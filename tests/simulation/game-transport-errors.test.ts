import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { callGameTool } from "../../server/mcp-game.js";

test("a severed response makes reads unavailable while mutations retain uncertain outcomes", async () => {
	// Transport fault only: this endpoint never returns a fabricated game result.
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.write("{");
			res.destroy();
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	assert(address && typeof address !== "string");
	const keys = ["ASTRA_GAME_TOOLS_ENABLED", "ASTRA_GAME_SERVICE_URL", "ASTRA_GAME_SESSION"] as const;
	const saved = keys.map((key) => process.env[key]);
	process.env.ASTRA_GAME_TOOLS_ENABLED = "true";
	process.env.ASTRA_GAME_SERVICE_URL = `http://127.0.0.1:${address.port}`;
	process.env.ASTRA_GAME_SESSION = "a".repeat(64);
	try {
		await assert.rejects(callGameTool("", "astra.game_read_match", { version: 5, match_id: randomUUID() }), { code: "UNAVAILABLE" });
		await assert.rejects(callGameTool("", "astra.game_create_match", { version: 5, command_id: randomUUID() }), { code: "OUTCOME_UNKNOWN" });
	} finally {
		keys.forEach((key, index) => {
			const value = saved[index];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		});
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	}
});
