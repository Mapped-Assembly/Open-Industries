import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { GameDatabase, canonical } from "../../server/game-sqlite.mjs";
import {
	seedVictoryFixture,
	armVictoryFixture,
} from "../helpers/victory-fixture.mjs";
import { nativeGame } from "../../server/domains/game-core.mjs";
import { assertVictory } from "../../server/game-victory.mjs";
import { validateGameRequest } from "../../server/mcp-game-contract.mjs";

for (const outcome of ["win", "loss", "tie"])
	test(`file-backed ${outcome}: simultaneous final blows, immutable result, concurrent workers, rollback, restart, privacy and command locks`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "oi-victory-")),
			path = join(directory, "game.sqlite");
		let now = 1000,
			db = new GameDatabase(path, { clock: () => now });
		try {
			db.tick();
			const a = (
					await db.authenticate(
						{ username: "alice", password: "victory-fixture-password" },
						true,
					)
				).token,
				b = (
					await db.authenticate(
						{ username: "bobby", password: "victory-fixture-password" },
						true,
					)
				).token,
				c = (
					await db.authenticate(
						{ username: "outsider", password: "victory-fixture-password" },
						true,
					)
				).token;
			const id = seedVictoryFixture(db, a, b, outcome),
				read = (token = a) =>
					db.dispatch(token, "astra.game_read_match", {
						version: 5,
						match_id: id,
					}).snapshot;
			// A real paid job and robot reservation must be stopped without refunding consumed charge.
			const robot = read().field.robots[0].id,
				target = read().world.deposits.find(
					(d: any) => d.home_slot === 1 && d.kind === "construction",
				).id;
			const request = {
				version: 5,
				command_id: randomUUID(),
				match_id: id,
				expected_revision: read().revision,
				action: "survey_robot",
				robot_id: robot,
				deposit_id: target,
				sensor: "camera-depth",
			};
			const receipt = db.dispatch(a, "astra.game_command", request);
			const component = read().science.components[0].id;
			db.dispatch(a, "astra.game_command", {
				version: 5,
				command_id: randomUUID(),
				match_id: id,
				expected_revision: read().revision,
				action: "inspect_component",
				component_id: component,
			});
			armVictoryFixture(db, id);
			now += 500;
			db.tick();
			assert.equal(read().status, "active");
			const before = canonical(db.loadInstance(id));
			db.db.exec(
				"CREATE TRIGGER victory_fault BEFORE UPDATE ON matches BEGIN SELECT RAISE(ABORT,'victory-fault'); END",
			);
			now += 500;
			assert.throws(() => db.tick());
			assert.equal(canonical(db.loadInstance(id)), before);
			db.db.exec("DROP TRIGGER victory_fault");
			db.close();
			db = new GameDatabase(path, { clock: () => now }); // no client final-blow command: restart worker resolves it
			if (outcome === "tie") {
				const moduleUrl = new URL(
					"../../server/game-sqlite.mjs",
					import.meta.url,
				).href;
				await Promise.all(
					[1, 2].map(
						() =>
							new Promise<void>((done, reject) => {
								const child = spawn(
									process.execPath,
									[
										"--import",
										"tsx",
										"--input-type=module",
										"-e",
										`import {GameDatabase} from ${JSON.stringify(moduleUrl)};const db=new GameDatabase(process.argv[1],{clock:()=>Number(process.argv[2])});try{db.tick();}finally{db.close();}`,
										path,
										String(now),
									],
									{ stdio: ["ignore", "ignore", "pipe"] },
								);
								let error = "";
								child.stderr.on("data", (chunk) => {
									error += chunk.toString();
								});
								child.once("error", reject);
								child.once("exit", (code) =>
									code === 0 ? done() : reject(Error(error)),
								);
							}),
					),
				);
			}
			db.tick();
			const result = read().completion;
			assert.equal(result.result_version, "victory-v1");
			assert.equal(
				result.winner_slot,
				outcome === "tie" ? null : outcome === "win" ? 1 : 2,
			);
			assert.equal(result.resolved_at_ms, 2000);
			assert.equal(read().status, "completed");
			assert.deepEqual(read(b).completion, result);
			assert.equal(
				result.tower_health.filter((t: any) => t.health === 0).length,
				outcome === "tie" ? 2 : 1,
			);
			assert(
				db
					.load(id)
					.players.every((p: any) => p.units[0].ammunition_ids.length === 0),
			);
			assert(
				db
					.load(id)
					.players.every((p: any) =>
						p.combat_orders.every(
							(o: any) =>
								o.state === "cancelled" && o.reason === "match-completed",
						),
					),
			);
			assert.equal(read().field.jobs.at(-1).reason, "match-completed");
			assert.equal(read().jobs.at(-1).cancellation_reason, "match_completed");
			assert(read().jobs.at(-1).energy_mj > 0);
			assert.throws(() => read(c), { code: "NOT_AVAILABLE" });
			const own = read(),
				otherJson = JSON.stringify(read(b));
			for (const secret of [
				own.field.robots[0].cargo[0]?.id,
				own.science.components[0]?.id,
				own.manufacturing.products.find((p: any) => p.kind === "steel-slug").id,
			].filter(Boolean))
				assert(!otherJson.includes(secret));
			const physical = canonical(db.load(id).players),
				historyCount = db.db
					.prepare("SELECT count(*) n FROM simulation_events")
					.get()!.n;
			const concurrent = new GameDatabase(path, { clock: () => now });
			try {
				db.tick();
				concurrent.tick();
				assert.deepEqual(read().completion, result);
			} finally {
				concurrent.close();
			}
			assert.deepEqual(db.dispatch(a, "astra.game_command", request), receipt);
			for (const action of [
				"abandon_match",
				"rotate_invite",
				"finish_recovery",
				"start_combat",
			])
				assert.throws(
					() =>
						db.dispatch(a, "astra.game_command", {
							version: 5,
							command_id: randomUUID(),
							match_id: id,
							expected_revision: read().revision,
							action,
						}),
					{ code: "MATCH_INACTIVE" },
				);
			now += 600000;
			db.tick();
			assert.deepEqual(read().completion, result);
			assert.equal(canonical(db.load(id).players), physical);
			const terminalEvents = db.db
				.prepare("SELECT event FROM simulation_events ORDER BY sequence")
				.all()
				.filter(
					(row: any) =>
						nativeGame(JSON.parse(row.event).state).completion?.result_id ===
						result.result_id,
				);
			assert(terminalEvents.length >= 1);
			assert(
				Number(
					db.db.prepare("SELECT count(*) n FROM simulation_events").get()!.n,
				) >= Number(historyCount),
			);
			const saved = db.loadInstance(id);
			db.close();
			db = new GameDatabase(path, { clock: () => now });
			assert.deepEqual(read().completion, result);
			assert.deepEqual(db.load(id).players, nativeGame(saved).players);
			const rescheduled = db.load(id);
			rescheduled.completion.resolved_at_ms -= 1;
			assert.throws(() => db.save(rescheduled), { code: "INVARIANT_FAILED" });
			const invalid = db.load(id);
			invalid.completion.winner_slot = outcome === "win" ? 2 : 1;
			assert.throws(
				() =>
					assertVictory(invalid, () => {
						throw Error("INVARIANT_FAILED");
					}),
				/INVARIANT_FAILED/,
			);
		} finally {
			db.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
test("clients cannot submit a winner, tower health or result; pre-upgrade zero towers finalize before new work", async () => {
	assert.throws(
		() =>
			validateGameRequest("astra.game_command", {
				version: 5,
				command_id: randomUUID(),
				match_id: randomUUID(),
				expected_revision: 1,
				action: "resolve_victory",
				winner_slot: 1,
			}),
		{ code: "INVALID_REQUEST" },
	);
	const db = new GameDatabase(":memory:", { clock: () => 1000 });
	try {
		db.tick();
		const a = (
				await db.authenticate(
					{ username: "alice", password: "victory-fixture-password" },
					true,
				)
			).token,
			b = (
				await db.authenticate(
					{ username: "bobby", password: "victory-fixture-password" },
					true,
				)
			).token,
			id = seedVictoryFixture(db, a, b, "tie");
		const m = db.load(id);
		for (const p of m.players) {
			const tower = p.base.assets.find((a: any) => a.kind === "tower");
			tower.status = "destroyed";
			p.combat_health[tower.id] = 0;
		}
		db.save(m);
		db.tick();
		const terminal = db.load(id);
		assert.equal(terminal.completion.winner_slot, null);
		assert.equal(terminal.completion.resolved_at_ms, 1000);
		assert.equal(terminal.status, "completed");
	} finally {
		db.close();
	}
});
