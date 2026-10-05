# Local cross-agent scene walkthrough

Mergence has **no chat composer**. Describe a scene to an external agent connected to its local MCP server; that agent calls typed tools and returns a URL for the local workbench. The `astra.*` tool names and `ASTRA_*` settings remain the wire contract after the Mergence rename. This server is distinct from the optional Form OSS authoring server.

The Grok, ChatGPT, and Codex fixtures are authored examples using one provider-agnostic contract. They are not captured vendor outputs or certification of native-client compatibility. The replay and test commands below need no LLM credentials and invoke no model.

## 1. Start from a clean checkout

Use Node 22 or newer:

```sh
git clone https://github.com/caid-technologies/OpenIndustries.git
cd OpenIndustries
npm ci
npm run build
npm run test:mcp-agent-workflows
```

This test starts the real stdio server and uses a local HTTP fixture service backed by the real database migrations in PGlite. It requires neither a Supabase project nor a Python/Form installation. For browser verification:

```sh
npx playwright install chromium
npm run test:mcp-agent-workflows-browser
```

CI installs Chromium system dependencies too. `ASTRA_CHROME_PATH` selects a locally installed Chromium executable. Screenshots are written to `test-results/mcp-<client>-<stage>.png` for the original, updated, pinned, comparison, and restored views. Set `MCP_WORKFLOW_EVIDENCE_DIR` to choose another output directory; CI uploads these as `mcp-workflow-browser-evidence`. Tests check create/update/read, schema discovery, owner isolation, conflicts, sanitized responses, returned URLs, and browser comparison/restore of the same MCP-authored scene. Restore must append a new head with the original geometry, placements and animation, preserve all earlier snapshots, and leave the original revision URL unchanged. Merely visiting `/?scene=cleanroom` is not this test.

## 2. Configure persistent scene authoring

Skip this section for the deterministic tests or the bundled local demo. Real `create_scene`/`update_scene` calls require Supabase Auth, Postgres, and private Storage, even though the workbench runs locally.

Use your own development Supabase project and apply **all** repository migrations through `20260929120000_scene_history.sql`, including the generated-assets and revision-link migrations:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

Enable GitHub in that project's Auth providers. The GitHub OAuth callback is `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`. Add `http://127.0.0.1:54331/callback` (CLI) and `http://127.0.0.1:5173/**` (workbench, including scene queries) to Supabase's redirect allowlist. Keep the GitHub OAuth secret in Supabase provider settings.

Create `.env` in the checkout with your own **public** settings:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
VITE_CLOUD_STORAGE_ENABLED=true
VITE_FORM_GENERATION_ENABLED=false
ASTRA_SCENE_TOOLS_ENABLED=true
ASTRA_WORKBENCH_ORIGIN=http://127.0.0.1:5173
```

Use one local origin consistently; `localhost` and `127.0.0.1` have different browser sessions. Ensure the private `astra-assets` bucket and its policies exist after migration. The browser upload flag and MCP opt-in are separate. Do not add provider keys or service-role keys to this configuration for the fixture workflow.

```sh
node cli/astra.mjs auth login
npm run dev
```

Sign in to the workbench at `http://127.0.0.1:5173` with the same account as the CLI. The CLI session stays in its user configuration directory; never paste it into a prompt, fixture, or tool argument. `ASTRA_CLI_CONFIG` optionally selects a separate session file.

Private owner URLs use authenticated Storage reads and do not require a geometry Edge Function. If you also want signed-out shared links, deploy `npx supabase functions deploy scene-asset` and follow [scene-link setup](scene-links.md#deployment). Merging code or running fixture tests does not apply migrations, configure OAuth, or deploy that function.

## 3. Connect an external host

The repository provides **local stdio**, not an HTTP MCP endpoint. The process needs access to the checkout, `.env`, and the CLI user's session file. Use absolute paths; Windows forward-slash paths such as `C:/projects/OpenIndustries` work. Restart the host after editing its configuration.

### Codex CLI / IDE

Add this entry to your Codex `config.toml` (for example `~/.codex/config.toml`), replacing the path:

```toml
[mcp_servers.mergence]
command = "node"
args = ["/absolute/path/OpenIndustries/server/astra-mcp.mjs"]
cwd = "/absolute/path/OpenIndustries"
tool_timeout_sec = 90

[mcp_servers.mergence.env]
ASTRA_ROOT = "/absolute/path/OpenIndustries"
ASTRA_SCENE_TOOLS_ENABLED = "true"
```

Run `codex mcp list` or use `/mcp` in the CLI to inspect the connection. Configuration fields are documented in the [official Codex MCP guide](https://developers.openai.com/codex/mcp). Scene calls have a 60-second server deadline; the host timeout should leave time to receive the response.

### OpenCode V2 or another stdio host

For OpenCode V2, merge this into your host configuration (do not replace unrelated servers):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "mergence": {
        "type": "local",
        "command": ["node", "/absolute/path/OpenIndustries/server/astra-mcp.mjs"],
        "cwd": "/absolute/path/OpenIndustries",
        "environment": {
          "ASTRA_ROOT": "/absolute/path/OpenIndustries",
          "ASTRA_SCENE_TOOLS_ENABLED": "true"
        }
      }
    }
  }
}
```

Run `opencode mcp list`. This is the [V2 configuration shape](https://opencode.ai/v2/docs/mcp-servers); older OpenCode releases, including the legacy shape in this repository's `opencode.json`, use a different nesting. Use the documentation for your installed host version. A generic `mcpServers` JSON example is in the [MCP guide](mcp-scenes.md#setup).

For a Grok- or ChatGPT-named client, use a host that already supplies local MCP tool execution and forwards tool results to the model you choose. The fixtures simulate that host boundary and do not make model calls. Native ChatGPT's app connection does not directly spawn this local stdio command; see its [official MCP connection guidance](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). A trusted transport adapter is a separate integration and is not shipped or tested here. No native Grok application connection is claimed.

## 4. Create, open, revise, and revisit

To inspect an actual deterministic create request without any connection:

```sh
npm run demo:mcp-scene -- --client codex --print-request
```

The output wraps the [shared cleanroom request](../scripts/fixtures/cleanroom-scene-request.json) in `tools/call`. When using it with a real agent, replace its sample `request_id` with a fresh UUID. Ask the connected agent:

> Discover the Mergence scene tools and inspect the three cleanroom example assets. Use the supplied scene request to create the six-instance cleanroom and the 110-second A/C sampling route, leaving occupied Room B unsampled. Use a fresh request UUID and your descriptive agent label. Return the scene ID, revision ID, and private revision URL. Do not call a generation provider or change my existing local workspace.

For the exact same workflow without an LLM, in a second terminal run:

```sh
npm run demo:mcp-scene -- --client codex --create
```

This **writes** one scene and its referenced geometry to your configured backend. It prints `scene_id`, `revision_id: 1`, `head_url`, and `revision_url`. Open the returned `revision_url` in the signed-in local workbench. Expect the architecture, robot, and four desks; play the animation or inspect 5/10 seconds for Room A and 65/70 seconds for Room C. One animation second represents one scheduled minute from 09:00. The sampling-plan table belongs to the bundled demo route; the MCP scene carries the route as animation, not a live scheduling or access-control system.

Revise that scene with another example client. Replace `SCENE_UUID` with the returned ID:

```sh
npm run demo:mcp-scene -- --client chatgpt --update SCENE_UUID --base-revision 1
```

The runner reads pinned revision 1, preserves its immutable cloud asset references and route, changes room width to 27 m, moves Desk 2 to X 3.248 m, and submits `update_scene` with base revision 1. It returns revision 2. Open that URL to see the edit, then reopen the original revision-1 URL: the width remains 24.384 m and the original layout/route remains intact. The head URL shows the latest revision when opened.

The agent equivalent is to call `read_scene`, edit the returned `scene`, then call `update_scene` with its `scene_id`, explicit `base_revision`, a fresh `request_id`, and the new descriptive `agent`. Agent labels do not change ownership; the authenticated CLI account must own the scene.

Open **Revision history**, select revisions 1 and 2, and click **Compare revisions** to inspect the room-width and desk-position changes. Click **Restore revision 1** and confirm: the workbench appends a new head revision containing revision 1's layout and animation. Existing revisions stay intact. Reopen the original revision-1 URL to verify that it still identifies the same saved snapshot. If another client advances the head first, refresh history and review the change before retrying a restore.

For a committed-write retry, pass `--request-id THE_SAME_UUID` and exactly the same client, scene, and base revision. The runner prints the request ID before sending. A stale base returns `CONFLICT` with the current revision; read/compare that revision before deliberately updating your base. The runner never silently retries against a newer head. See [error recovery](mcp-scenes.md#persistence-recovery-and-limits). Test scenes can be deleted explicitly in the workbench; unreferenced uploads remain available for deliberate cleanup.

## Fixture scope and provenance

The [fixture matrix](../scripts/fixtures/agent-workflows/README.md) specifies which request-ID and response representations are exercised. These are contract tests, not live provider evaluations. Real-provider credentials and outputs must never be committed as fixtures. Any future captured fixture should record its origin separately and undergo sanitization before inclusion.

Asset units, source digests, generated/approximate geometry notes, and the available license evidence are in the [cleanroom asset manifest](../public/examples/cleanroom/asset-provenance.json) and [example notes](../public/examples/cleanroom/README.md). Import-format compatibility remains #21; exact file-version regression coverage is maintained by the #66 history suite. This workflow reuses those foundations.
