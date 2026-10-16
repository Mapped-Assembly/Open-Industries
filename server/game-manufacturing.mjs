import { installUnit } from "./game-units.mjs";
import { randomUUID } from "node:crypto";
import { evaluateUse } from "@openindustries/material-science/engine";
import { contentsOf, grams } from "./game-robots.mjs";

export const manufacturingVersion = "manufacturing-v1";
const part = (id, use, mass, station = "bench") => ({
	id,
	category: "part",
	station,
	duration_ms: 4000,
	power_w: 250,
	materials: [{ use, mass_g: mass }],
	products: [],
	components: [],
});
const assembly = (
	id,
	category,
	station,
	products,
	components = [],
	requirements = [],
) => ({
	id,
	category,
	station,
	duration_ms: 8000,
	power_w: 500,
	materials: [],
	products: products.map(([kind, quantity]) => ({ kind, quantity })),
	components: components.map(([kind, quantity]) => ({ kind, quantity })),
	requirements,
});
const recipes = [
	part("copper-conductor", "copper-conductor", 100),
	part("steel-bracket", "steel-bracket", 1000),
	part("aluminum-housing", "aluminum-housing", 300, "metal-press"),
	part("hdpe-housing", "hdpe-housing", 200),
	part("glass-filler", "glass-filler", 500),
	part("traction-tread", "traction-tread", 500),
	part("steel-chassis", "steel-bracket", 8000, "metal-press"),
	assembly(
		"metal-press",
		"machine",
		"bench",
		[
			["steel-bracket", 2],
			["copper-conductor", 1],
		],
		[["fastener", 4]],
	),
	assembly(
		"furnace",
		"machine",
		"bench",
		[
			["steel-bracket", 2],
			["glass-filler", 1],
			["copper-conductor", 1],
		],
		[
			["fastener", 2],
			["insulated-wire", 1],
		],
	),
	assembly(
		"polymer-processor",
		"machine",
		"bench",
		[
			["steel-bracket", 1],
			["hdpe-housing", 1],
			["copper-conductor", 1],
		],
		[["fastener", 2]],
		["furnace"],
	),
	assembly(
		"fabricator",
		"machine",
		"bench",
		[
			["steel-bracket", 1],
			["copper-conductor", 1],
		],
		[
			["fastener", 2],
			["drive", 1],
			["controller", 1],
		],
	),
	assembly(
		"solar-array",
		"machine",
		"bench",
		[
			["steel-bracket", 1],
			["copper-conductor", 1],
		],
		[
			["solar-panel", 1],
			["charge-controller", 1],
		],
	),
	assembly(
		"charging-port",
		"machine",
		"bench",
		[
			["steel-bracket", 1],
			["copper-conductor", 1],
			["hdpe-housing", 1],
		],
		[
			["fastener", 2],
			["insulated-wire", 1],
		],
	),
	assembly(
		"solar-reflector",
		"upgrade",
		"fabricator",
		[
			["steel-bracket", 1],
			["glass-filler", 1],
		],
		[["fastener", 2]],
	),
	assembly(
		"scrap-barricade",
		"defense",
		"fabricator",
		[
			["steel-bracket", 2],
			["traction-tread", 1],
		],
		[["fastener", 2]],
	),
	assembly(
		"scavenger-robot",
		"robot",
		"fabricator",
		[
			["steel-chassis", 1],
			["copper-conductor", 1],
			["hdpe-housing", 1],
			["traction-tread", 2],
		],
		[
			["motor", 2],
			["wheel", 2],
			["robot-battery", 1],
			["camera", 1],
			["depth-sensor", 1],
			["controller", 1],
			["magnetic-inductive-probe", 1],
		],
	),
];
// Unit recipes consume the same graded products and tested reclaimed hardware as machinery.
recipes.push(
	part("steel-slug", "steel-slug", 250, "metal-press"),
	assembly(
		"sentry-turret",
		"defense",
		"fabricator",
		[
			["steel-bracket", 2],
			["copper-conductor", 1],
			["hdpe-housing", 1],
		],
		[
			["motor", 1],
			["camera", 1],
			["controller", 1],
			["fastener", 2],
		],
	),
	assembly(
		"armored-turret",
		"defense",
		"fabricator",
		[
			["steel-bracket", 2],
			["copper-conductor", 1],
			["aluminum-housing", 1],
		],
		[
			["motor", 1],
			["camera", 1],
			["controller", 1],
			["fastener", 2],
		],
	),
	assembly(
		"raid-launcher",
		"defense",
		"fabricator",
		[
			["steel-chassis", 1],
			["copper-conductor", 1],
			["hdpe-housing", 1],
			["traction-tread", 2],
		],
		[
			["motor", 2],
			["wheel", 2],
			["controller", 1],
			["robot-battery", 1],
			["fastener", 2],
		],
	),
);
export const manufacturingCatalog = () => ({
	version: manufacturingVersion,
	recipes: structuredClone(recipes),
	storage_slots: 16,
	queue_limit: 8,
	retained_job_limit: 64,
	scope: "modeled-parts-and-assembly-not-electronics-fabrication",
});
export const productionLive = (j) =>
	["waiting", "running", "paused"].includes(j.state);
export const isManufacturing = (j) => j.kind === "manufacturing";
const add = (a, b) => {
	for (const [k, n] of Object.entries(b)) a[k] = (a[k] ?? 0) + n;
	return a;
};
export const productionProducts = (p) => p.production?.products ?? [];
const ready = (p, kind) =>
	kind === "bench"
		? p.base.assets.find((a) => a.kind === "bench" && a.status === "ready")
		: productionProducts(p).find(
				(a) => a.kind === kind && a.state === "installed" && a.enabled,
			);
export const productionStation = (p, kind) =>
	kind === "bench"
		? p.base.assets.find((a) => a.kind === "bench")
		: productionProducts(p).find(
				(a) => a.kind === kind && a.state === "installed",
			);
const countSlots = (p) =>
	productionProducts(p).filter((a) => a.state === "available").length;
const stockReserved = (p, id) =>
	p.jobs
		.filter((j) => isManufacturing(j) && productionLive(j))
		.reduce(
			(n, j) =>
				n +
				j.component_inputs
					.filter((c) => c.id === id)
					.reduce((n, c) => n + c.quantity, 0),
			0,
		);
/** A preview uses owned, paid evidence and exact catalog requirements; it never reserves inputs. */
export function manufacturingPlan(p, args) {
	const r = recipes.find((r) => r.id === args.recipe_id),
		missing = [];
	const no = (code, message, next_actions) => ({
		status: "ineligible",
		code,
		message,
		next_actions,
		recipe_id: args.recipe_id,
	});
	if (!r)
		return no("UNSUPPORTED_RECIPE", "Choose a declared manufacturing recipe.", [
			"choose-supported-recipe",
		]);
	if (p.production?.version && p.production.version !== manufacturingVersion)
		throw Error("UNSUPPORTED_MANUFACTURING_PIN");
	const station = productionStation(p, r.station);
	if (
		["sentry-turret", "armored-turret", "raid-launcher"].includes(r.id) &&
		(p.units?.length ?? 0) +
			p.jobs.filter(
				(j) =>
					isManufacturing(j) &&
					productionLive(j) &&
					["sentry-turret", "armored-turret", "raid-launcher"].includes(
						j.recipe,
					),
			).length >=
			16
	)
		missing.push("Unit history limit reached.");
	if (
		!station ||
		station.state === "destroyed" ||
		station.status === "destroyed"
	)
		missing.push(`Construct ${r.station} first.`);
	for (const requirement of r.requirements ?? [])
		if (!ready(p, requirement)) missing.push(`Enable ${requirement}.`);
	if (
		r.category === "machine" &&
		productionProducts(p).some(
			(a) => a.kind === r.id && a.state === "installed",
		)
	)
		missing.push("This machine is already installed.");
	if (
		p.jobs.filter(isManufacturing).length >= 64 ||
		p.jobs.filter((j) => isManufacturing(j) && productionLive(j)).length >= 8 ||
		productionProducts(p).length >= 128
	)
		missing.push(
			"Production history limit reached; start another recovery session.",
		);
	if (r.materials.length && p.batches.length >= 512)
		missing.push("Bulk lot history is full; use another recovery session.");
	const batchIds = args.batch_ids ?? [],
		productIds = args.product_ids ?? [],
		componentIds = args.component_ids ?? [];
	if (
		new Set([...batchIds, ...productIds, ...componentIds]).size !==
		batchIds.length + productIds.length + componentIds.length
	)
		return no("DUPLICATE_INPUT", "Select each owned input once.", [
			"choose-distinct-inputs",
		]);
	if (batchIds.length !== r.materials.length)
		missing.push(`Select ${r.materials.length} eligible material batch(es).`);
	const materials = [];
	for (let i = 0; i < r.materials.length; i++) {
		const demand = r.materials[i],
			b = p.batches.find((b) => b.id === batchIds[i]);
		if (!b) {
			missing.push("Select an owned material batch.");
			continue;
		}
		// Ammunition is a game abstraction, with its own mass predicate rather than bracket geometry.
		const check =
			demand.use === "steel-slug"
				? {
						status:
							b.material.inspection === "graded" &&
							b.material.grade === "game-steel-v1" &&
							b.material.form === "stock" &&
							b.material.condition === "sound" &&
							b.material.hazard === "none-detected" &&
							b.material.constituents.length === 1 &&
							b.material.constituents[0].material === "steel"
								? "eligible"
								: "ineligible",
						code: "AMMUNITION_STOCK_REQUIRED",
					}
				: evaluateUse(
						b.material,
						demand.use,
						demand.use === "hdpe-housing" ? 60 : 20,
					);
		if (
			b.state !== "available" ||
			check.status !== "eligible" ||
			b.material.massG < demand.mass_g
		) {
			missing.push(
				`${demand.use}: ${b.state !== "available" ? "BATCH_UNAVAILABLE" : (check.code ?? "INSUFFICIENT_INPUT")}.`,
			);
			continue;
		}
		// Manufacture only homogeneous recovered stock; offcuts keep their original grade and provenance.
		if (b.material.constituents.length !== 1) {
			missing.push("Sort homogeneous stock before manufacture.");
			continue;
		}
		materials.push({
			id: b.id,
			mass_g: demand.mass_g,
			material: b.material.constituents[0].material,
		});
	}
	const products = productIds.map((id) =>
		productionProducts(p).find((a) => a.id === id),
	);
	if (
		products.some((a) => !a || a.state !== "available") ||
		products.length !== r.products.reduce((n, d) => n + d.quantity, 0)
	)
		missing.push("Select the exact available manufactured parts.");
	for (const d of r.products)
		if (products.filter((a) => a?.kind === d.kind).length !== d.quantity)
			missing.push(`Requires ${d.quantity} ${d.kind}.`);
	const components = [];
	for (const d of r.components) {
		let remain = d.quantity;
		for (const id of componentIds) {
			const c = p.components.find((c) => c.id === id);
			if (
				p.jobs.some(
					(j) =>
						j.kind === "component-inspection" &&
						productionLive(j) &&
						j.input_batch_id === id,
				) ||
				!c ||
				c.kind !== d.kind ||
				!c.tested ||
				c.condition !== "sound" ||
				!c.compatibleAssemblies.includes("starter-maintenance-v1")
			)
				continue;
			const quantity = Math.min(remain, c.quantity - stockReserved(p, id));
			if (quantity > 0) {
				components.push({
					id,
					kind: c.kind,
					quantity,
					unit_mass_g: c.unitMassG,
				});
				remain -= quantity;
			}
		}
		if (remain) missing.push(`Requires ${d.quantity} tested ${d.kind}.`);
	}
	if (componentIds.some((id) => !components.some((c) => c.id === id)))
		missing.push("Remove unused, unavailable or untested components.");
	if (missing.length)
		return no("UNMET_REQUIREMENTS", missing.join(" "), [
			"inspect-material-and-components",
			"construct-required-machine",
			"choose-exact-bill-of-materials",
		]);
	return {
		status: "eligible",
		code: "ELIGIBLE",
		message: "Exact inputs will be reserved; time and power are server-owned.",
		next_actions: ["enqueue-manufacturing"],
		recipe_id: r.id,
		station_id: station.id,
		duration_ms: r.duration_ms,
		power_w: r.power_w,
		energy_j: (r.duration_ms * r.power_w) / 1000,
		materials,
		products: productIds,
		components,
	};
}
/** Reserve entire source lots, specific products and exact tested component quantities atomically. */
export function enqueueManufacturing(p, args, now, fail) {
	const plan = manufacturingPlan(p, args);
	if (plan.status !== "eligible") fail("MANUFACTURING_REQUIREMENTS");
	p.production ??= { version: manufacturingVersion, products: [] };
	for (const m of plan.materials)
		p.batches.find((b) => b.id === m.id).state = "reserved";
	for (const id of plan.products)
		productionProducts(p).find((a) => a.id === id).state = "reserved";
	p.jobs.push({
		id: randomUUID(),
		machine_id: plan.station_id,
		input_batch_id: plan.materials[0]?.id ?? plan.station_id,
		recipe: plan.recipe_id,
		recipe_version: manufacturingVersion,
		kind: "manufacturing",
		power_w: plan.power_w,
		state: "waiting",
		pause_reason: null,
		cancellation_reason: null,
		duration_ms: plan.duration_ms,
		work_ms: 0,
		energy_mj: 0,
		last_tick_ms: now,
		outputs: [],
		material_inputs: plan.materials,
		product_inputs: plan.products,
		component_inputs: plan.components,
	});
	p.base.ready_to_finish = false;
}
/** Cancellation/failure returns held inputs, but never refunds spent work or produces an output. */
export function cancelManufacturing(p, j, reason, failed = false) {
	if (!productionLive(j)) return;
	for (const m of j.material_inputs)
		p.batches.find((b) => b.id === m.id).state = "available";
	for (const id of j.product_inputs)
		productionProducts(p).find((a) => a.id === id).state = "available";
	j.state = failed ? "failed" : "cancelled";
	j.pause_reason = null;
	j.cancellation_reason = reason;
}
/** Completed assemblies retain all constituents and original component identities, including offcuts. */
export function finishManufacturing(p, j) {
	if (
		countSlots(p) >= 16 ||
		p.batches.length +
			j.material_inputs.filter(
				(m) => p.batches.find((b) => b.id === m.id).material.massG > m.mass_g,
			).length >
			512
	) {
		j.state = "paused";
		j.pause_reason = "storage-full";
		return;
	}
	const r = recipes.find((r) => r.id === j.recipe),
		contents = {},
		components = [];
	for (const m of j.material_inputs) {
		const b = p.batches.find((b) => b.id === m.id);
		b.state = "consumed";
		add(contents, { [m.material]: m.mass_g });
		const remainder = b.material.massG - m.mass_g;
		if (remainder) {
			const offcut = structuredClone(b);
			offcut.id = randomUUID();
			offcut.state = "available";
			offcut.contents = { [m.material]: remainder };
			for (const k of ["copper", "hdpe", "dirt"])
				offcut[`${k}_g`] = k === m.material ? remainder : 0;
			offcut.material.id = offcut.id;
			offcut.material.massG = remainder;
			offcut.material.constituents = [
				{ material: m.material, massG: remainder },
			];
			offcut.source_job_id = j.id;
			offcut.parent_batch_id = b.id;
			offcut.observation_id = null;
			p.batches.push(offcut);
		}
	}
	for (const id of j.product_inputs) {
		const a = productionProducts(p).find((a) => a.id === id);
		a.state = "consumed";
		add(contents, a.contents);
		components.push(...a.components);
	}
	for (const input of j.component_inputs) {
		const c = p.components.find((c) => c.id === input.id);
		c.quantity -= input.quantity;
		components.push({ ...input });
	}
	p.components = p.components.filter((c) => c.quantity > 0);
	p.base.inventory = p.components.map((c) => ({
		kind: c.kind,
		quantity: c.quantity,
		unit_mass_g: c.unitMassG,
	}));
	const output = {
		id: randomUUID(),
		kind: r.id,
		category: r.category,
		state: r.category === "part" ? "available" : "installed",
		enabled: true,
		contents,
		components,
		source_job_id: j.id,
	};
	p.production.products.push(output);
	installUnit(p, output);
	if (r.category === "robot") {
		const home = p.base.assets.find((a) => a.kind === "battery").position;
		p.robots.push({
			id: output.id,
			position: { ...home },
			home: { ...home },
			capacity_mj: 8000000,
			energy_mj: 0,
			initial_mj: 0,
			charged_mj: 0,
			spent_mj: 0,
			payload_g: 10000,
			sensors: ["camera-depth", "magnetic-inductive"],
			cargo: [],
			job_id: null,
		});
	}
	j.state = "completed";
	j.pause_reason = null;
}
/** Derive availability from installed equipment; automatic pauses never erase input reservations. */
export function settleManufacturing(p, now) {
	if (!p.production) return false;
	let changed = false;
	for (const j of p.jobs.filter(
		(j) => isManufacturing(j) && productionLive(j),
	)) {
		const r = recipes.find((r) => r.id === j.recipe),
			station = productionStation(p, r.station);
		if (
			!station ||
			station.status === "destroyed" ||
			station.state === "destroyed"
		) {
			cancelManufacturing(p, j, "machine_destroyed", true);
			changed = true;
			continue;
		}
		const bulkFull =
			p.batches.length +
				j.material_inputs.filter(
					(m) => p.batches.find((b) => b.id === m.id).material.massG > m.mass_g,
				).length >
			512;
		const reason =
			!ready(p, r.station) || (r.requirements ?? []).some((k) => !ready(p, k))
				? "machine-disabled"
				: countSlots(p) >= 16 || bulkFull
					? "storage-full"
					: p.machine.status !== "ready"
						? "power"
						: null;
		if (reason && j.pause_reason !== "requested") {
			if (j.state !== "paused" || j.pause_reason !== reason) changed = true;
			j.state = "paused";
			j.pause_reason = reason;
		}
		if (
			j.state === "paused" &&
			(j.pause_reason === "requested" ||
				reason ||
				(j.pause_reason === "power" &&
					p.machine.energy_mj <
						Math.min(500000, (j.duration_ms - j.work_ms) * j.power_w)))
		)
			continue;
		if (
			j.state === "running" ||
			p.jobs.some((other) => other !== j && other.state === "running")
		)
			continue;
		if (reason) continue;
		j.state = "running";
		j.pause_reason = null;
		j.last_tick_ms = now;
		changed = true;
		if (j.work_ms === j.duration_ms) finishManufacturing(p, j);
	}
	return changed;
}
/** Starter solar may be disassembled only into its original components, never copied. */
export function salvageStarterAsset(p, id, fail) {
	const a = p.base.assets.find((a) => a.id === id);
	if (!a || !["solar", "robot", "fabricator"].includes(a.kind))
		fail("NOT_AVAILABLE");
	if (
		a.status === "destroyed" ||
		!a.components.length ||
		p.jobs.some(productionLive)
	)
		fail("NOT_READY");
	if (a.kind === "robot") {
		const r = p.robots.find((r) => r.id === id);
		if (
			r.job_id ||
			r.cargo.length ||
			r.position.x !== r.home.x ||
			r.position.y !== r.home.y
		)
			fail("NOT_READY");
		r.retired = true;
		r.spent_mj += r.energy_mj;
		r.energy_mj = 0;
	}
	p.production ??= { version: manufacturingVersion, products: [] };
	for (const part of a.components)
		p.components.push({
			id: randomUUID(),
			owner: p.owner,
			location: "store",
			kind: part.kind,
			quantity: part.quantity,
			unitMassG: part.unit_mass_g,
			condition: "unknown",
			tested: false,
			compatibleAssemblies: [],
			allocation: "component-only",
			revision: 1,
		});
	a.components = [];
	a.status = "destroyed";
	p.base.inventory = p.components.map((c) => ({
		kind: c.kind,
		quantity: c.quantity,
		unit_mass_g: c.unitMassG,
	}));
}
/** Metered solar and an additional charging port are modeled upgrades, not energy grants. */
export function productionSolar(p) {
	if (!p.production) return 100;
	const solar =
		p.base.assets.some((a) => a.kind === "solar" && a.status === "ready") ||
		ready(p, "solar-array");
	return (
		(p.base.assets.some((a) => a.kind === "solar" && a.status === "ready")
			? 100
			: 0) +
		productionProducts(p).filter(
			(a) => a.kind === "solar-array" && a.state === "installed" && a.enabled,
		).length *
			100 +
		(solar
			? productionProducts(p).filter(
					(a) =>
						a.kind === "solar-reflector" &&
						a.state === "installed" &&
						a.enabled,
				).length * 50
			: 0)
	);
}
export const chargingPower = (p) => (ready(p, "charging-port") ? 1000 : 500);
/** Partition output/WIP mass and existing components without minting new ledger count resources. */
export function manufacturingAllocations(p) {
	const rows = [];
	for (const a of productionProducts(p).filter((a) => a.state !== "consumed")) {
		rows.push({
			id: `manufactured:${a.id}`,
			unit: "g",
			contents: a.contents,
			job: null,
		});
		const parts = {};
		for (const c of a.components)
			parts[`part.${c.kind}`] = (parts[`part.${c.kind}`] ?? 0) + c.quantity;
		rows.push({
			id: `manufactured-parts:${a.id}`,
			unit: "count",
			contents: parts,
			job: null,
		});
	}
	for (const j of p.jobs.filter(
		(j) => isManufacturing(j) && productionLive(j),
	)) {
		const parts = {};
		for (const c of j.component_inputs)
			parts[`part.${c.kind}`] = (parts[`part.${c.kind}`] ?? 0) + c.quantity;
		rows.push({
			id: `assembly-parts:${j.id}`,
			unit: "count",
			contents: parts,
			job: j.id,
		});
	}
	return rows;
}
export const reservedComponentQuantity = stockReserved;
/** Owner-only projection exposes declared inputs and unmet needs, never opponent inventory. */
export function manufacturingProjection(p) {
	return {
		version: manufacturingVersion,
		storage_used: countSlots(p),
		storage_slots: 16,
		products: productionProducts(p).map((a) => ({
			...a,
			mass_g: grams(a.contents),
		})),
		jobs: p.jobs.filter(isManufacturing).map((j) => ({
			id: j.id,
			machine_id: j.machine_id,
			recipe: j.recipe,
			state: j.state,
			reason: j.pause_reason ?? j.cancellation_reason,
			duration_ms: j.duration_ms,
			work_ms: j.work_ms,
			energy_mj: j.energy_mj,
			material_inputs: j.material_inputs,
			product_inputs: j.product_inputs,
			component_inputs: j.component_inputs,
		})),
	};
}
/** Preserve original starter part totals after movement into stores, reservations and assemblies. */
export function assertManufacturing(p, fail) {
	if (!p.production) return;
	if (
		p.production.version !== manufacturingVersion ||
		p.production.products.length > 128 ||
		p.robots.length > 8
	)
		fail("INVARIANT_FAILED");
	const counts = (rows) => {
		const out = {};
		for (const c of rows)
			out[`${c.kind}:${c.unit_mass_g}`] =
				(out[`${c.kind}:${c.unit_mass_g}`] ?? 0) + c.quantity;
		return Object.entries(out)
			.sort()
			.map((r) => r.join("="))
			.join(";");
	};
	const current = [
		...p.base.assets.flatMap((a) => a.components),
		...p.base.inventory,
		...productionProducts(p)
			.filter((a) => a.state !== "consumed")
			.flatMap((a) => a.components),
	];
	if (counts(current) !== counts(p.base.starter_ledger))
		fail("INVARIANT_FAILED");
	const ids = new Set();
	for (const a of productionProducts(p)) {
		if (
			ids.has(a.id) ||
			!["available", "reserved", "installed", "destroyed", "consumed"].includes(
				a.state,
			) ||
			Object.values(a.contents).some((n) => !Number.isSafeInteger(n) || n < 0)
		)
			fail("INVARIANT_FAILED");
		ids.add(a.id);
	}
	for (const c of p.components)
		if (stockReserved(p, c.id) > c.quantity) fail("INVARIANT_FAILED");
	const held = new Set();
	for (const j of p.jobs.filter(isManufacturing)) {
		const r = recipes.find((r) => r.id === j.recipe),
			outputs = productionProducts(p).filter((a) => a.source_job_id === j.id);
		if (
			j.recipe_version !== manufacturingVersion ||
			!r ||
			j.duration_ms !== r.duration_ms ||
			j.power_w !== r.power_w ||
			j.energy_mj !== j.work_ms * r.power_w ||
			(j.state === "completed" ? outputs.length !== 1 : outputs.length !== 0)
		)
			fail("INVARIANT_FAILED");
		if (productionLive(j))
			for (const id of [
				...j.material_inputs.map((m) => m.id),
				...j.product_inputs,
			]) {
				if (held.has(id)) fail("INVARIANT_FAILED");
				held.add(id);
				const input =
					p.batches.find((b) => b.id === id) ??
					productionProducts(p).find((a) => a.id === id);
				if (input?.state !== "reserved") fail("INVARIANT_FAILED");
			}
		if (outputs.length) {
			const expected = {},
				parts = [];
			for (const m of j.material_inputs)
				add(expected, { [m.material]: m.mass_g });
			for (const id of j.product_inputs) {
				const product = productionProducts(p).find((a) => a.id === id);
				if (!product || product.state !== "consumed") fail("INVARIANT_FAILED");
				add(expected, product.contents);
				parts.push(...product.components);
			}
			parts.push(...j.component_inputs);
			const out = outputs[0],
				sorted = (value) => JSON.stringify(Object.entries(value).sort());
			if (
				out.kind !== r.id ||
				out.category !== r.category ||
				sorted(expected) !== sorted(out.contents) ||
				counts(parts) !== counts(out.components)
			)
				fail("INVARIANT_FAILED");
		}
	}
	if (p.base.power.solar_w !== productionSolar(p)) fail("INVARIANT_FAILED");
}
