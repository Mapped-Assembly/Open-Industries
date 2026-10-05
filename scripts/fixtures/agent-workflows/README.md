# Authored cross-agent MCP fixtures

`grok.json`, `chatgpt.json`, and `codex.json` are **hand-authored examples, not captures from those products or evidence that their native apps were tested**. No provider SDK, credential, prompt transcript, or model output is included. The client names are descriptive labels and confer no authority.

Each profile supplies a complete MCP initialization payload, request-ID style, result-reading mode, create identity, and a small revision edit. The shared scene is loaded from [`../cleanroom-scene-request.json`](../cleanroom-scene-request.json), so asset placements and the A/C sampling timeline have one source of truth. Profile files are replay descriptors, not direct `tools/call` arguments. `npm run demo:mcp-scene -- --client codex --print-request` prints an actual JSON-RPC create request without starting a server.

| Profile | JSON-RPC IDs | Result representation exercised | Revision edit |
| --- | --- | --- | --- |
| Grok example | Strings | JSON text content | Room width 26 m; move Desk 2 to X 3.148 m |
| ChatGPT example | Strings | `structuredContent` | Room width 27 m; move Desk 2 to X 3.248 m |
| Codex example | Numbers | Both, checked for agreement | Room width 28 m; move Desk 2 to X 3.348 m |

These variations exercise MCP interoperability, not claimed vendor-specific wire formats. All clients discover the same schemas, list/inspect example assets, create revision 1, read its cloud asset references, and update using an explicit base revision. Updates keep the A/C route unchanged and leave blocked Room B unsampled. The suite also hands a scene between differently named clients using the same authenticated account.

Fixed request UUIDs make isolated tests repeatable. The live replay command generates fresh UUIDs unless `--request-id` is supplied; a retry must reuse the same identity and payload. The update builder edits the read snapshot, retaining exact cloud version references rather than uploading example geometry again.

Run `npm run test:mcp-agent-workflows` or `npm run test:mcp-agent-workflows-browser`. Both reuse the actual migrations, fixture Auth/Storage service, immutable revision APIs, and the existing bundled geometry. They make no live Supabase or LLM calls. The browser version opens returned private URLs after updates, verifies rendered animation, and revisits pinned originals for all three profiles. Existing `test:mcp-scenes` owns the wider malformed-input/retry matrix; `test:scene-history` owns the same-ID/different-file-version matrix from #66. Artifact-import coverage remains a separate #21 concern.

See the [local walkthrough](../../../docs/mcp-agent-workflows.md) and [asset provenance](../../../public/examples/cleanroom/README.md). No additional license grant is made for fixtures or bundled assets by these profiles.
