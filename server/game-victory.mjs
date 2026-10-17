import { stopRobot } from "./game-robots.mjs";

export const victoryVersion = "victory-v1";
const active = (j) => ["waiting", "running", "paused"].includes(j.state);
export function finalTowerHealth(match) {
	return [1, 2].map((slot) => {
		const p = match.players.find((p) => p.slot === slot),
			tower = p?.base.assets.find((a) => a.kind === "tower");
		return {
			slot,
			health: !tower
				? 300
				: tower.status === "destroyed"
					? 0
					: (p.combat_health?.[tower.id] ?? 300),
		};
	});
}
/** Called after all same-time damage, or before resuming a pre-upgrade active save. */
export function resolveVictory(match, at, policy) {
	if (
		match.status !== "active" ||
		!match.combat_version ||
		match.players.length !== 2
	)
		return false;
	const towers = finalTowerHealth(match),
		destroyed = towers.filter((t) => t.health === 0);
	if (!destroyed.length) return false;
	for (const p of match.players) {
		for (const j of p.jobs)
			if (active(j)) policy.cancel(p, j, "match_completed");
		for (const r of p.robots) stopRobot(match, p, r, "match-completed");
		for (const o of p.combat_orders ?? [])
			if (["pending", "running"].includes(o.state)) {
				o.state = "cancelled";
				o.reason = "match-completed";
			}
		p.base.ready_to_finish = false;
	}
	match.next_combat_ms = null;
	match.invite_hash = null;
	match.status = "completed";
	match.completion = {
		result_version: victoryVersion,
		result_id: `${match.id}:${victoryVersion}`,
		reason:
			destroyed.length === 2
				? "simultaneous-tower-destruction"
				: "tower-destroyed",
		winner_slot: destroyed.length === 2 ? null : 3 - destroyed[0].slot,
		resolved_at_ms: at,
		tower_health: towers,
	};
	return true;
}
/** Terminal records are invariant-checked, rather than reconstructed or recomputed on reads. */
export function assertVictory(match, fail) {
	const r = match.completion;
	if (!r?.result_version) {
		if (
			["tower-destroyed", "simultaneous-tower-destruction"].includes(r?.reason)
		)
			fail("INVARIANT_FAILED");
		return;
	}
	const towers = finalTowerHealth(match),
		dead = towers.filter((t) => t.health === 0);
	if (
		r.result_version !== victoryVersion ||
		match.status !== "completed" ||
		!match.combat_version ||
		match.players.length !== 2 ||
		!dead.length ||
		r.result_id !== `${match.id}:${victoryVersion}` ||
		!Number.isSafeInteger(r.resolved_at_ms) ||
		r.resolved_at_ms < 0 ||
		r.resolved_at_ms > match.last_advanced_ms ||
		r.reason !==
			(dead.length === 2
				? "simultaneous-tower-destruction"
				: "tower-destroyed") ||
		r.winner_slot !== (dead.length === 2 ? null : 3 - dead[0].slot) ||
		JSON.stringify(r.tower_health) !== JSON.stringify(towers) ||
		match.next_combat_ms !== null ||
		match.invite_hash !== null ||
		match.players.some(
			(p) =>
				p.jobs.some(active) ||
				p.robots.some((r) => r.job_id) ||
				(p.combat_orders ?? []).some((o) =>
					["pending", "running"].includes(o.state),
				),
		)
	)
		fail("INVARIANT_FAILED");
}
