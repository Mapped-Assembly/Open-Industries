# Development and integration guide

This guide covers optional Form generation, agent workflows, import details, GIF exports, and deployment. Start with the [README](../README.md) for the project overview and browser quickstart.

## Local Form generation

Python is required only for the local **Build with Form** bridge. After the Node.js setup in the README, install Python 3.11+ and the pinned Form dependency.

### Windows PowerShell

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-form.txt
```

### macOS / Linux

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-form.txt
```

Form is installed through `caid-forma-core==0.3.5`; no Form source checkout is required for this bridge. The distribution provides the `forma-oss` and `forma-core` commands. OpenIndustries invokes `python -m forma_core` from this environment. Set `FORM_PYTHON` in `.env` if you need a different Python executable.

Start `npm run dev`, open <http://127.0.0.1:5173>, and use **Generate Forma project → Build with Form → Deterministic demo → Build and import** to verify creation and import without provider credentials. Keep `VITE_FORM_GENERATION_ENABLED=true`. The panel checks `/api/health`; if Python/Form is missing, install it and click **Check again**.

After generation, **Export selected Forma project** downloads the original equipment design as Hardware IR JSON, including the BOM and validation. **Export OI project** bundles the full room, equipment geometry, placements, and animation into `.oi.json`; reopen it with **Import OI project**. Layout transforms do not modify the Forma design. External CAD references are not downloaded by the Forma JSON exporter.

For live generation, configure the appropriate provider environment variables in `.env` (see [`.env.example`](../.env.example)) and enter the provider/model in the UI. Provider credentials stay in the server-side Form process. Live provider calls have not yet been verified in this project.

## Optional Form MCP demo

The repository includes a project-local OpenCode configuration for the Form OSS MCP server. It is local-only and does not affect the Vercel build or browser bundle. OpenIndustries' file import and existing local generation bridge continue to work when Form MCP is not installed or running.

The commands below run inside a separate [Form OSS checkout](https://github.com/caid-technologies/Forma-OSS), using its documented setup:

```powershell
py -3 .\scripts\development\setup-opencode.py --root . --workspace "$HOME\form-workspace" --install-cli
.\scripts\development\dev.ps1
```

The Form backend must be available at `http://127.0.0.1:8000/mcp`. Then, from this OpenIndustries checkout:

```powershell
opencode mcp list
opencode
```

Use the `/form-demo` command in OpenCode. It compiles a validated project to `demo/form-project.json`; import that file into OpenIndustries with **Import project**. The generated `demo/` directory is ignored by Git. Restart OpenCode after changing `opencode.json` because project configuration is loaded at startup.

OpenCode now connects to both local servers: Form provides equipment authoring and validation, while OpenIndustries exposes room creation, animation feedback, compiled-artifact handoff, and space-brief tools. Verify both with `opencode mcp list` before starting the demo.

For typed scene creation and revision updates with private local-workbench URLs, see [external-agent scene authoring](mcp-scenes.md). The empty local-file tools below remain available independently.

## Create rooms through MCP

Ask your connected agent: **“Create a room called Maker lab, 9 meters wide, 7 meters deep, and 3.2 meters high.”** The agent can call:

```json
{"name":"astra.create_room","arguments":{"name":"Maker lab","width":9,"depth":7,"height":3.2}}
```

This creates an empty, portable `astra.scene` v1 document under `.astra/rooms/<id>.json` and returns its ID, path, and document. Each dimension must be 1–100 meters; the room vector uses **width, depth, height**. Each call creates a new room, even when names match, without overwriting an existing room.

- `astra.list_rooms` lists rooms created by this MCP checkout.
- `astra.read_room` takes an `id` and returns the saved scene document.

Open the returned JSON through **Drop files or browse** in the workbench, then import equipment and arrange the room. Creating a room does not replace the active browser workspace. These are local files; to save across devices, sign in and save from the workbench, or use `astra rooms import <path> --name "Maker lab"` after CLI login. The MCP server runs with the local user's filesystem access and does not expose a remote, shared-user endpoint. `astra.write_space_brief` remains available for the preset layout planner.

Run `npm run test:mcp` to verify the MCP protocol, room persistence, and workbench manifest compatibility.

If the MCP server is unavailable, use the deterministic Form demo or import an existing Form JSON/STEP project as usual.

## Animation feedback loop

Render **Authored timeline animation** in GIF studio, enter feedback such as a clearance or motion change, and choose **Send feedback to Form**. OpenIndustries saves a scrubbed review package to `.astra/feedback/latest.json`; it contains the room manifest, sampled frame poses, animation tracks, and the instruction, but not credentials or geometry secrets.

In OpenCode, run `/form-feedback`. It reads the review, updates the Form project through `form.opencode.update_project`, and writes the revised compiled manifest back to `demo/form-project.json`. Reimport that manifest into OpenIndustries and render the animation again. This is intentionally a human-reviewed loop; OpenIndustries never silently changes electrical or mechanical design data.

## OpenIndustries CLI

Install the local CLI from this checkout:

```powershell
npm install
npm link
astra auth login
```

`astra auth login` opens GitHub and stores the Supabase session in the user's OpenIndustries CLI config. Add `http://127.0.0.1:54331/callback` to the Supabase Auth redirect allowlist for the deployed Supabase project, or set `ASTRA_CLI_REDIRECT_URL` to an allowlisted callback. The CLI uses the same OpenIndustries account as the browser.

```powershell
astra rooms list
astra rooms validate .\astra-scene.json
astra rooms import .\astra-scene.json --name "Lab demo"
astra rooms export <room-id> .\astra-scene.json
astra auth logout
```

The browser workbench remains the local room editor and can import/export portable scene JSON without signing in. To view a local room, choose **Drop files or browse** and open its `.astra/rooms/<id>.json` scene. The CLI transfers those manifests to and from cloud; binary geometry is not uploaded by the CLI and can be attached from OpenIndustries when cloud storage is enabled.

## Cleanroom example details

Open `/?scene=cleanroom` to load the bundled cleanroom POC example from `public/examples/cleanroom/cleanroom-suite.json`. It shows four 20×20 ft rooms, four imported stainless workbenches, and the Form swab-sampling robot. The personnel doors are 1.2 m wide so the 0.995 m robot envelope can pass in this POC. The schedule sends it into Room A for two samples, skips occupied Room B, then enters Room C for two samples when its access window opens. The one-shot animation maps 1 timeline second to 1 scheduled minute from 09:00 and parks the robot after its route. The imported robot STEP is a mostly fused pose, so sample contact is shown by a short approach/retract rather than articulated arm joints. The route bypasses the saved workspace without replacing it; its schedule and geometry are example data, not manufacturing approval.

## Import contracts

- Form: Hardware IR 0.1/0.2, `project_ir` / `hardware_ir` wrappers, `form-project` manifest v1, and `form.project` namespace objects. Object versions are revision counters. Mechanical placements and inline CAD mesh vertices use millimeters with Z up.
- SDK/agent handoff: see [`docs/form-handoff.md`](form-handoff.md) for the canonical compiled artifact contract used by the Form SDK, OpenCode, and Codex.
- Generated architectural assets use the `generated` source variant in bundled OpenIndustries scenes. They are explicitly synthetic architecture, not Form-authored hardware or STEP CAD. With migration `20260929100000_generated_scene_assets.sql`, supported `form-industries` generated geometry can be uploaded and reopened through private scene URLs.
- Select referenced STEP artifacts together with their Form JSON. Missing CAD falls back to labeled mechanical envelopes when available; otherwise the import reports an error. Remote CAD URLs and server-local paths are not fetched automatically.
- STEP: `.step` and `.stp` Part 21 files are converted with `occt-import-js@0.0.23`. OpenCascade reads source units; the UI provides source-up-axis and scale correction. Geometry conversion runs in an isolated worker with a 120-second timeout. Successful conversions are cached for repeated imports.
- Scene asset schema v1: stable content-derived asset/part IDs, source filename/digest/project identity, named hierarchy, indexed triangle meshes, dimensions, and warnings. All geometry is normalized to meters, Y up, centered in X/Z and floor-aligned; `originOffset` retains the original normalization offset. Metadata is allowlisted for display.
- Limits: 25 MiB per file, 75 MiB per batch, 2 million vertices per asset. These are protective caps, not a benchmarked performance guarantee. STEP variants and large assemblies need broader fixture validation.

## Verification

Run `npm run test:project-files` for Forma/OI round trips and generation error handling, and `npm run test:project-files-browser` for browser generation/import/export, a fresh-browser reopen, failure recovery, and desktop/mobile layouts. CI uses deterministic API fixtures and uploads the browser evidence. To exercise the installed Python Forma package instead, set `OI_REAL_GENERATION=true` before running the browser test; it starts its own local API on port 8799 and uses deterministic simulation, without provider credentials. `OI_PROJECT_EVIDENCE_DIR` optionally retains its screenshots and exported files. Live paid-provider generation remains unverified.

After `npm run build`, with `npm start` running, run `npm test`. The Chrome smoke test checks Form import, actual STEP conversion using an upstream cube fixture, room controls, invalid JSON recovery, and pip-installed Form deterministic generation. Screenshots are written to `test-results/`. Chrome and network access for the STEP fixture are required.

## GIF studio and asset library

Open **GIF studio** in the viewer (also available in fullscreen). Everything in this workflow runs in the browser; no Form process, provider credentials, upload service, or server-side rendering is required.

### Export for visual review

1. Import your Form/STEP assets and open **Floor export**.
2. Choose **Entire room**, **Floor section**, or **Selected asset**. A section is defined by its X/Z center and width/depth in meters, relative to the room center. Its box is highlighted in the viewport. It must fit within the room and intersect an asset; geometry outside its six boundaries is clipped in the export.
3. Choose 320, 480, or 640 pixels square, a 2–4 second duration, and 10 or 15 fps. Click **Render GIF**; progress and cancellation are available.
4. Inspect the animated preview, then download the GIF and its review metadata JSON. Metadata records source asset IDs, names, provenance, instance positions, units, room/section dimensions, motion mode, frame timing, and geometry approximation warnings. Supply both files to a visual-review agent to preserve spatial context. OpenIndustries does not automatically call an LLM or apply corrections.

**Turntable** makes one complete camera orbit around fixed geometry. Selected assets can also use **Sample lift-and-return**, a clearly labeled synthetic motion with a stationary camera. It is a preview preset, not an authored animation timeline or physics simulation. Captures use a separate renderer and never modify the active room or camera.

GIF timing is rounded to the format's 10 ms tick: 15 fps becomes 70 ms/frame. Metadata and preview report the actual duration. At most 60 frames are encoded; frames are processed sequentially with UI yields, and temporary render resources are disposed on completion, failure, or cancellation. GIFs use a 256-color palette per frame, so some color quantization is expected.

### Build a reusable asset library

1. Select a room asset, open **Asset library**, and click **Save selected asset to library**.
2. Render a **turntable** or **sample motion** preview from its card. The latest GIF and review metadata are saved with its geometry in IndexedDB. Saving the same asset ID updates its existing entry.
3. Refresh or reopen OpenIndustries on the same browser origin: library entries and previews remain. **Add to room** restores an instance without reimporting the source file. **Remove from library** deletes the stored asset and preview while leaving existing room instances intact.

The device library is per browser/device/origin and subject to browser quota and eviction. Use the explicit Cloud files actions for private geometry/GIF transfers. Cloud scenes can be saved and reopened after reload through **Save / open scenes**; portable scene JSON also bundles geometry and animation without a cloud dependency.

### GIF checks

With the app running on port 8787, run `npm run test:gif`. It imports deterministic fixtures, renders and decodes real GIF downloads to check dimensions, moving frames, timing and looping, verifies section filtering/metadata, tests library persistence and both motion presets, and covers cancellation, fullscreen, and mobile layout. No Form installation or external fixture download is needed for this suite. Run `npm run test:fullscreen` for the existing fullscreen regressions. Screenshots are saved under `test-results/10-*.png`.

GIF encoding uses `gifenc` (MIT); the test-only GIF decoder is `omggif` (MIT).

## Vercel deployment

[`vercel.json`](../vercel.json) deploys the Vite frontend with `npm ci`, `npm run build`, and output directory `dist`. The project is linked to `isayahcs-projects/astra-industries` on Vercel.

Production/preview environment variables:

- `VITE_SUPABASE_URL`: the Supabase project URL.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: the public browser key (never a service-role/secret key).
- `VITE_FORM_GENERATION_ENABLED=false`: disables local generation and shows setup guidance without making API calls; generate locally, then import the Forma or OI project into the hosted app.

The deployment serves rendering, imports, GIF exports, local asset library, and GitHub Auth. The Node/Python generation server is not deployed. `.vercelignore` excludes environment files, virtual environments, local databases/caches, server code, Supabase config, and test screenshots.

The Supabase production Site URL and redirect allowlist include `https://astra-industries.vercel.app`; GitHub's OAuth callback remains `https://mrhxfmtofvrgfaikllfw.supabase.co/auth/v1/callback`. Preview deployment origins must be explicitly allowed before using OAuth on them.

Deploy the current checkout with `vercel deploy --prod --yes --scope isayahcs-projects`. Validate public rendering/imports/GIFs with `node scripts/deployment-smoke.mjs`. Set `ASTRA_BASE_URL=https://astra-industries.vercel.app` when running `node scripts/auth-live-smoke.mjs` to check the production GitHub redirect without signing in.
