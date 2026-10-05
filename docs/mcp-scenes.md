# Author scenes from an external agent

Mergence's local stdio MCP server lets an external agent discover assets, create a scene, read it, and save an edit as a new revision. The workbench runs locally; saved scenes and geometry use your configured Supabase backend. No in-app chat, provider SDK, or live LLM is required.

For a clean-checkout walkthrough, copyable Codex/OpenCode setup, cross-client replay, and pinned-revision checks, see [cross-agent workflows](mcp-agent-workflows.md).

## Setup

1. Run `npm ci` in this checkout. Apply all Supabase migrations using your normal migration process (`npx supabase db push`), through `20260929120000_scene_history.sql`, including the generated-assets migration. Private Storage must be enabled for geometry.
2. Configure `.env` with your **public** Supabase settings and explicitly enable scene tools:

   ```dotenv
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=your-public-key
   ASTRA_SCENE_TOOLS_ENABLED=true
   ASTRA_WORKBENCH_ORIGIN=http://127.0.0.1:5173
   ```

3. Run `node cli/astra.mjs auth login`. This uses the existing GitHub/Supabase CLI sign-in; configure its callback as described in the [CLI guide](development.md#astra-cli). Credentials stay in the CLI session file, outside tool arguments and scene documents. `ASTRA_CLI_CONFIG` can select a separate session file.
4. Start the local workbench with `npm run dev`, and sign in there with the same account to open private URLs. `VITE_CLOUD_STORAGE_ENABLED=true` additionally enables the workbench's upload UI; MCP uploads are enabled separately by `ASTRA_SCENE_TOOLS_ENABLED`.
5. Configure an MCP host that supports local stdio. For hosts using `mcpServers`, the configuration is:

   ```json
   {
     "mcpServers": {
       "astra": {
         "command": "node",
         "args": ["/absolute/path/OpenIndustries/server/astra-mcp.mjs"],
         "env": {
           "ASTRA_ROOT": "/absolute/path/OpenIndustries",
           "ASTRA_SCENE_TOOLS_ENABLED": "true"
         }
       }
     }
   }
   ```

Use your checkout's absolute path (on Windows, forward slashes such as `C:/projects/OpenIndustries` work). Restart the MCP server after configuration changes. Hosts limited to remote MCP need a separate trusted transport adapter; this repository supplies only local stdio. Connect any compatible agent through that host; Mergence does not contact an LLM.

## Tools and schemas

`tools/list` exposes the full versioned JSON input/output schemas, defined in [`server/mcp-scene-contract.mjs`](../server/mcp-scene-contract.mjs). Each scene tool requires `version: 1` and rejects unknown fields. Successful calls provide the same JSON in `structuredContent` and text content.

| Tool | Input and result |
| --- | --- |
| `astra.list_scene_assets` | List ready immutable versions owned by the CLI account, plus three bundled cleanroom examples. Pass `next_offset` as `offset` for another page. |
| `astra.inspect_scene_asset` | Pass an `asset` reference to inspect dimensions, provenance, warnings, and valid part IDs for animation. Raw Form IR and provider configuration are omitted. |
| `astra.create_scene` | Pass `request_id`, `agent`, and a complete `scene`. The caller-generated UUID `request_id` becomes the stable scene ID. |
| `astra.read_scene` | Pass `scene_id` and optionally `revision_id`. Returns a typed scene with immutable cloud asset references, ready to edit. |
| `astra.update_scene` | Pass `scene_id`, explicit `base_revision`, a new UUID `request_id`, `agent`, and the complete replacement `scene`. |

Asset references are either `{"kind":"cloud","version_id":"<uuid>"}` or `{"kind":"example","id":"cleanroom-architecture"}`. The other example IDs are `cleanroom-robot` and `cleanroom-desk`. To use your own Form or STEP model, import it in the workbench, upload a cloud copy, then discover/inspect its version. Tools do not accept file paths, arbitrary download URLs, credentials, or raw geometry.

Positions and dimensions use meters in a Y-up world. Room fields are `width` (X), `depth` (Z), and `height` (Y). Rotations are Euler XYZ degrees, matching the workbench. Instance poses are absolute; component keyframes are local to their instance. `visible` is required. Omit `animation` for a static scene (three-second timeline, no tracks); otherwise provide `duration`, `loop`, and `tracks`. Each track targets `instance_id` and optionally `part_id`, with keys containing `time`, `position`, and `rotation`. Whole-instance keys may also include boolean `visible`; it changes at the key time and holds until the next explicit visibility key, falling back to base instance visibility before the first one. Omitted values retain that held value. Component keys support transforms only. Read/update calls preserve visibility keys. Mission routes use these same animation tracks.

For example, call `astra.create_scene` with a fresh UUID:

```json
{
  "version": 1,
  "request_id": "f1640000-0000-4000-8000-000000000002",
  "agent": "my-agent",
  "scene": {
    "name": "Workstation layout",
    "room": { "width": 8, "depth": 6, "height": 3 },
    "instances": [{
      "id": "desk-1",
      "name": "Workstation",
      "asset": { "kind": "example", "id": "cleanroom-desk" },
      "position": [0, 0, 0],
      "rotation": [0, 90, 0],
      "visible": true
    }]
  }
}
```

The result includes `version`, `scene_id`, numeric `revision_id`, `head_url`, `revision_url`, and `access: "owner"`. URLs resolve against `ASTRA_WORKBENCH_ORIGIN`, which defaults to `http://127.0.0.1:5173`; they do not publish a site or create a public share. Open `revision_url` in the signed-in local workbench to reproduce the exact saved snapshot. Read, edit the returned `scene`, and call `astra.update_scene` using the returned `revision_id` as `base_revision`.

## Persistence, recovery, and limits

Scene writes use the existing `save_workspace_scene` RPC, immutable revision snapshots, and owner-scoped asset versions. Geometry is verified for size, SHA-256, identity, topology, and supported provenance before use. The cleanroom architecture remains explicitly `generated` with generator `form-industries`; it is synthetic architectural geometry, not Form-authored hardware or STEP CAD. Generated assets now use the same private immutable Storage lifecycle after the new migration. Example imports upload only the selected bundled assets.

Each snapshot records `authoring.via`, the caller's descriptive `agent` label, `parent_revision`, `request_id`, and a request digest. The label is not an authenticated agent identity. The workbench provides [history, comparison, and restore](scene-history.md); its database-assigned parent and authenticated author metadata extend this document-level provenance. The broader retained-Form-data sanitization work remains #37; these tools expose only allowlisted scene/source fields and never return raw retained project documents.

Failed tools set `isError: true` and return `{"error":{"code":"…","message":"…"}}`; conflicts also include `current_revision` when available.

| Error | Recovery |
| --- | --- |
| `INVALID_REQUEST` / `INVALID_SCENE` | Correct the indicated schema path, duplicate IDs, missing animation targets, or duplicate/out-of-range key times. Inspect an asset for valid component IDs. |
| `ASSET_UNAVAILABLE` / `INVALID_ASSET` | Select a ready version owned by this account, or re-upload matching valid geometry. |
| `DISABLED` / `AUTH_REQUIRED` / `CONFIGURATION` | Check explicit opt-in, public Supabase settings, workbench origin, and CLI sign-in. Service-role keys are rejected. |
| `CONFLICT` | Read the current scene, reconcile the edit, then use its revision and a new request UUID. No stale overwrite is made. |
| `REQUEST_ID_REUSED` | A different payload already used this request ID at the head. Read the scene and assign a fresh UUID to the new edit. |
| `ASSET_UPLOAD_FAILED` / `SAVE_FAILED` / `TIMEOUT` | Read the scene to determine whether the save committed. Retry the identical request when appropriate. Pending uploads are reusable and visible in Cloud files. |
| `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_DATA` | Reduce scene/asset complexity to the discovered schema limits. |

An identical retry while its write is still the scene head returns that same revision. After another edit, the stale base returns a conflict. Uploads may finish before a competing scene edit wins; unused versions remain visible for explicit cleanup. Local room drafts are never replaced by MCP writes.

Limits: 1 MiB tool arguments, scene metadata, and tool results; 25 MiB per geometry file and 50 MiB referenced geometry per request; 1,000 instances/tracks and 10,000 total keyframes; room dimensions 1–100 m; animation duration 0.5–120 seconds. Network requests share a 60-second abort deadline. The stdio transport caps lines at 11 MiB (preserving legacy file handoffs) and queues at most eight requests. Calls run sequentially; every call reloads and verifies the CLI session so account changes apply to subsequent operations. Timeout errors never imply that a server-side write was rolled back.

The local `astra.create_room`, `astra.read_room`, and file-feedback tools remain available without cloud configuration, CLI login, or scene-tool opt-in. Browser file import also works independently.

## Deterministic cleanroom verification

[`scripts/fixtures/cleanroom-scene-request.json`](../scripts/fixtures/cleanroom-scene-request.json) is a sanitized typed agent request: room dimensions, six instance placements, references to the bundled geometry, and the robot's 110-second sampling route. It contains no raw geometry, provider configuration, or credentials. Its synthetic architecture and STEP fixtures retain the [example provenance and licenses](../public/examples/cleanroom/README.md).

```sh
npm run test:mcp
npm run test:mcp-scenes
npx playwright install chromium
npm run test:mcp-scenes-browser
```

The integration suite launches the real stdio server and Supabase client against a local HTTP facade backed by the actual migrations in PGlite/PostgreSQL. It tests generated/STEP/Form geometry, create/read/update, immutable revisions, schema validation, stale conflicts, interrupted-upload retries, missing sessions, account switching, and sanitized responses. The browser variant also opens an MCP-returned revision URL in a fresh signed-in browser and verifies the six cleanroom instances and robot animation. `ASTRA_CHROME_PATH` can select an installed Chromium executable. These tests use fixture authentication and local Storage emulation; they make no live Supabase or LLM calls.
