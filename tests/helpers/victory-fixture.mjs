import { randomUUID } from "node:crypto";
import { installUnit, commandUnit } from "../../server/game-units.mjs";
import { commandCombat } from "../../server/game-combat.mjs";
const fail = (code) => {
	throw Error(code);
};
/** Isolated near-final-blow fixture, not manufacturing evidence. Never exposed as a runtime tool. */
export function seedVictoryFixture(db, a, b, outcome = "win") {
	const created = db.dispatch(a, "astra.game_create_match", {
			version: 5,
			command_id: randomUUID(),
		}),
		id = created.snapshot.match_id;
	db.dispatch(b, "astra.game_join_match", {
		version: 5,
		command_id: randomUUID(),
		match_id: id,
		invite_code: created.invite_code,
	});
	db.transaction(() => {
		const match = db.load(id);
		db.advance(match);
		commandCombat(
			match,
			match.players[0],
			{ action: "start_combat" },
			match.last_advanced_ms,
			fail,
		);
		for (const p of match.players) {
			const product = {
				id: randomUUID(),
				kind: "raid-launcher",
				category: "defense",
				state: "installed",
				enabled: false,
				contents: {},
				components: [],
				source_job_id: randomUUID(),
			};
			p.production = { version: "manufacturing-v1", products: [product] };
			installUnit(p, product);
			const u = p.units[0];
			u.state = "deployed";
			u.position = { x: p.slot === 1 ? 60 : 36, y: 24 };
			const ammo = {
				id: randomUUID(),
				kind: "steel-slug",
				category: "part",
				state: "available",
				enabled: true,
				contents: {},
				components: [],
				source_job_id: randomUUID(),
			};
			p.production.products.push(ammo);
			commandUnit(
				match,
				p,
				{
					action: "load_unit_ammunition",
					unit_id: u.id,
					ammunition_id: ammo.id,
				},
				match.last_advanced_ms,
				fail,
			);
			commandUnit(
				match,
				p,
				{ action: "set_unit_enabled", unit_id: u.id, enabled: true },
				match.last_advanced_ms,
				fail,
			);
			const tower = p.base.assets.find((a) => a.kind === "tower");
			if (
				outcome === "tie" ||
				(outcome === "win" ? p.slot === 2 : p.slot === 1)
			)
				p.combat_health[tower.id] = 50;
		}
		db.save(match);
	});
	return id;
}
/** Admit both trusted fixture orders in one transaction so neither wins by caller order. */
export function armVictoryFixture(db, id) {
	db.transaction(() => {
		const match = db.load(id);
		db.advance(match);
		const at = Math.max(db.clock(), match.last_advanced_ms);
		for (const p of match.players)
			commandCombat(
				match,
				p,
				{
					action: "combat_order",
					unit_id: p.units[0].id,
					order: "target",
					target_id: match.world.towers.find((t) => t.slot !== p.slot).id,
				},
				at,
				fail,
			);
		db.save(match);
	});
}
