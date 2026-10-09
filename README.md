# Mergence

**Arrange hardware in a 3D space, animate how it moves, and share the layout for review.**

Mergence is a spatial workbench that runs locally in your browser for planning fabrication shops, manufacturing spaces, and laboratories. Import equipment from [Form](https://github.com/caid-technologies/Form-OSS) or a STEP CAD file, place it in a room at real-world scale, and preview a workflow before moving physical equipment.

[Run locally](#run-locally) · [Try the local demo](#try-the-local-demo) · [Documentation](#documentation)

## Why use it?

A hardware model describes an individual piece of equipment. Planning a workspace also means deciding where that equipment goes, what sits around it, and how people or materials move through the room.

Mergence brings those models into one editable scene. A maker can compare workbench arrangements, a manufacturing team can illustrate material flow, and a lab team can review an equipment layout or sampling route. The output is a room layout, an animation, and files that others can reopen or review.

## Try the local demo

Follow [Run locally](#run-locally) to install the project and start `npm run dev`, then open the [cleanroom demo](http://127.0.0.1:5173/?scene=cleanroom). It includes four rooms, stainless workbenches, and a Form-authored swab-sampling robot. The animation visits Rooms A and C and skips occupied Room B, showing how equipment, space, and a schedule fit together. The demo opens without replacing your saved workspace.

To make your own layout, open the [local workbench](http://127.0.0.1:5173):

1. Choose **Space brief / local demo**, select a maker, manufacturing, or biofab space, and click **Build space layout**. This creates a preset layout with labeled equipment placeholders and a material-flow animation.
2. Or choose **Import project** / **Drop files or browse** to open your own Form JSON, STEP model, or saved Mergence scene.
3. Adjust the room and equipment, then use **Animate**, **GIF studio**, or **Export scene JSON** to inspect and share the result.

You can import, edit, animate, and export locally without signing in. Optional cloud features use GitHub sign-in and a configured Supabase backend; the workbench itself runs on your machine.

## What you can do today

| Capability | What it does |
| --- | --- |
| Import equipment | Open Form project JSON and `.step` / `.stp` CAD files, with geometry normalized to meters. |
| Arrange a room | Set width, depth, and height; move, rotate, rename, duplicate, hide, or remove equipment instances; undo and redo edits. |
| Inspect a design | View available components, bill of materials (BOM), validation findings, and source/project metadata. |
| Author motion | Add position and rotation keyframes for equipment or components, then play or scrub the timeline. |
| Export a visual review | Render GIFs of a room, a floor section, or a selected asset, with companion JSON recording spatial and animation context. |
| Reuse equipment | Save geometry and previews in a device asset library and add them to another layout. |
| Save and reopen | Export portable scene JSON, restore local drafts, or save named cloud scenes with revision history, comparison, and restore. |
| Work with agents locally | Use optional Form/MCP workflows to author equipment, create or revise saved scenes from an external agent, and return animation feedback to Form. |

## How Form and Mergence work together

### Generate and transfer projects in OpenIndustries

- **Generate Forma project → Build with Form** checks the local Forma installation before enabling generation. Choose **Deterministic demo** for a sample without credentials, or **Live generation** with your server-configured provider and model. The resulting equipment is added to the current room, with its design, BOM, and validation data retained.
- **Export selected Forma project** downloads the selected equipment as `.forma.json`, using the same Hardware IR shape as Forma's JSON export. Referenced STEP/CAD files remain separate; room placement and animation belong to the OI project.
- **Export OI project** downloads a portable `.oi.json` containing the room, available equipment geometry, instance names/transforms/visibility, retained Forma design data, and animation. **Import OI project** opens it on a fresh browser without an account. Unsaved room changes are protected by the existing save/discard/cancel prompt.
- Existing `mergence-scene.json` and `astra.scene` v1 files still open. The **Export scene JSON** action uses the same portable OI export. Missing geometry remains marked missing; exporting cannot restore unavailable source files.

**Hosted generation:** the current Vercel build serves only the browser app; it does not run the Node/Python generator. It supports both project file workflows. Generation controls explain how to use the local workbench instead of silently disappearing. See [local generation setup](docs/development.md#local-form-generation).

**Form authors the equipment; Mergence places and reviews it in a space.** Form OSS provides hardware generation, validation, and compiled project data. Mergence imports that output and adds room layout, instance placement, animation, and visual review.

1. **Create or bring equipment.** Author and compile a project in Form, or use an existing STEP file from another CAD tool.
2. **Import it into Mergence.** Select the Form JSON and any referenced STEP files together. Standalone STEP files also work.
3. **Arrange and animate.** Place equipment in the room and add keyframes to illustrate its motion or a workflow.
4. **Save or share.** Export a portable scene, render a GIF plus review metadata, or save a cloud scene.
5. **Iterate when needed.** In the optional local agent workflow, send animation feedback to Form, review the revised design, and reimport its compiled artifact.

An **asset** is reusable imported equipment geometry. An **instance** is one placed copy of that asset. A **scene** combines the room, instances, and animation. Multiple instances can share one asset while keeping independent positions and motion.

See the [workspace guide](docs/workspace.md) for the full editing workflow and the [Form handoff contract](docs/form-handoff.md) for supported project formats.

## Saving your work

| Option | Where it lives | Best for |
| --- | --- | --- |
| Automatic local draft | The current browser/device | Returning to work after a refresh. This is separate from a cloud save. |
| Device asset library | The current browser/device | Reusing equipment and its GIF previews across layouts. |
| Portable scene JSON | A file you export | Reopening or transferring a scene with its geometry and animation, without cloud services. |
| Cloud scene | Your signed-in Supabase account | Saving named scenes across devices. Enable **Include cloud geometry** when saving if the other device needs the models. |
| Cloud files | Optional private Supabase Storage | Explicitly uploading geometry bundles, GIF previews, and supported source attachments. |

Browser storage is subject to quota and eviction, so export a scene file for a portable copy. Signing in does not automatically upload your imported files. A metadata-only cloud scene may show missing-geometry placeholders on another device until you provide the source assets. See [cloud storage setup](docs/cloud-storage.md) for enabling geometry transfers.

## Run locally

### Browser workbench

Install **Node.js 22** and Git, then run:

```bash
git clone https://github.com/caid-technologies/Form-Industries.git
cd Form-Industries
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The development command starts both Vite and the local API server. To view the bundled example, open <http://127.0.0.1:5173/?scene=cleanroom>.

Python, provider API keys, and Supabase configuration are optional for local imports, room editing, animation, the device library, and exports.

To serve a production build locally:

```bash
npm run build
npm start
```

Open <http://127.0.0.1:8787>.

### Optional services

Copy [`.env.example`](.env.example) to `.env` when you need configuration. Restart development or rebuild after changing browser variables.

| Feature | Setup |
| --- | --- |
| Local **Build with Form** | Install Python 3.11+ and `requirements-form.txt` into `.venv`. Follow the [local generation guide](docs/development.md#local-form-generation), then try **Deterministic demo** without provider credentials. |
| Live Form generation | Configure server-side provider credentials in `.env` and select a provider/model in the UI. Live provider calls have not yet been verified in this project. |
| GitHub sign-in and cloud scenes | Configure Supabase Auth/Postgres and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. See [Auth/database setup](supabase/README.md). |
| Private cloud geometry and GIFs | Apply the storage migrations and set `VITE_CLOUD_STORAGE_ENABLED=true`. See the [storage guide](docs/cloud-storage.md). |
| Disable local generation | Set `VITE_FORM_GENERATION_ENABLED=false` for browser-only deployments. The generation panel explains local setup; import/export stays available. |
| Local agents and CLI | See [OpenCode/MCP setup](docs/development.md#optional-form-mcp-demo), [scene authoring through MCP](docs/mcp-scenes.md), and the [Mergence CLI](docs/development.md#astra-cli). |

Only public Supabase browser configuration belongs in `VITE_` variables. Provider credentials and Supabase service-role keys must stay out of the browser bundle.

## Technology and repository map

| Part | Technology | Location |
| --- | --- | --- |
| Browser interface | React 19, TypeScript, Vite | [`src/main.tsx`](src/main.tsx), [`src/components/`](src/components/) |
| 3D workspace and animation | Three.js | [`src/lib/`](src/lib/), [`src/components/workspace-viewer.tsx`](src/components/workspace-viewer.tsx) |
| STEP conversion | `occt-import-js` / OpenCascade WebAssembly in a worker | [`src/lib/step.ts`](src/lib/step.ts), [`public/step-worker.js`](public/step-worker.js) |
| GIF export | `gifenc`, rendered in the browser | [`src/lib/gif.ts`](src/lib/gif.ts) |
| Cloud accounts and persistence | Supabase Auth, Postgres, optional private Storage | [`supabase/`](supabase/), [`src/lib/scene-repository.ts`](src/lib/scene-repository.ts) |
| Local Form bridge and agent tools | Node.js/Express, Python `caid-forma-core==0.3.5`, MCP | [`server/`](server/), [`opencode.json`](opencode.json) |
| Room transfer CLI | Node.js | [`cli/astra.mjs`](cli/astra.mjs) |
| Verification and examples | Model tests, browser smoke tests, bundled scenes | [`scripts/`](scripts/), [`public/examples/cleanroom/`](public/examples/cleanroom/) |

## Current scope and limitations

Mergence is a working prototype for spatial planning and visual review. Keep these boundaries in mind when evaluating the demo:

- **Animation is visual.** Keyframes illustrate movement; they do not provide physics simulation, collision guarantees, electrical revalidation, or manufacturing approval.
- **Space briefs use presets and planning envelopes.** These placeholders represent equipment positions and sizes. Replace them with Form-authored projects or CAD for detailed review.
- **The cleanroom route is illustrative.** Its access schedule is example data, and the mostly fused robot CAD uses whole-robot approach/retract motion to approximate sampling. See the [example notes](public/examples/cleanroom/README.md).
- **Imports have practical limits.** Equipment imports are capped at 25 MiB per file, 75 MiB per batch, and 2 million vertices per asset. Large assemblies and STEP variants still need broader validation.
- **Companion CAD must be selected explicitly.** Mergence does not automatically fetch remote CAD URLs or server-local paths. Missing CAD uses labeled envelopes when the project provides them, or reports an error.
- **Agent integration is optional and local.** The local workbench supports imports and visual review; the Form generation and feedback bridge uses the local API server. Design changes go through an explicit review and reimport loop.

## Development checks

For the TypeScript build and model/contract checks:

```bash
npm run build
npm run test:cad
npm run test:scene
npm run test:workspace
npm run test:mcp
npm run test:mcp-scenes
npm run test:scene-history
npm run test:mcp-agent-workflows
```

For browser smoke tests, run `npm start` in another terminal after building, then run `npm test`, `npm run test:gif`, or `npm run test:fullscreen`. These need Chrome. The main `npm test` suite also needs the Python Form installation and network access for a STEP fixture; the GIF suite does not need those two dependencies. Screenshots go to `test-results/`.

Live cloud tests need a dedicated Supabase test project and test-only credentials; follow the [workspace](docs/workspace.md#verification) and [storage](docs/cloud-storage.md#verification) guides.

## Publishing packages

The repository publishes two distributions from a GitHub Release:

- [`mergence`](https://www.npmjs.com/package/mergence) is the npm package for the browser workbench and local CLI.
- [`open-industries`](https://pypi.org/project/open-industries/) is the Python package for the static geospatial scene exporter. Its CLI is `oi-export-scene`.

The `Publish packages` workflow validates both builds before publishing. Add a current npm automation token as the repository `NPM_TOKEN` secret, and configure a PyPI trusted publisher for the `pypi` environment, before creating the first release. Package versions are taken from `package.json` and `pyproject.toml`; update both together, then publish a GitHub Release for that version.

## Documentation

- [Workspace guide](docs/workspace.md) — editing, animation, persistence, missing-geometry recovery, and the inspector.
- [Geospatial interchange](tools/geospatial/README.md) — static OI scenes to 3D Tiles 1.1, CesiumJS and an independent Three.js viewer, with geographic placement and provenance checks.
- [Form handoff contract](docs/form-handoff.md) — compiled artifacts, supported formats, provenance, and CAD resolution.
- [Revision history and restore](docs/scene-history.md) — compare saved versions, restore a new head, and preserve exact geometry bindings.
- [Cross-agent walkthrough](docs/mcp-agent-workflows.md) — deterministic Grok/ChatGPT/Codex fixtures, local agent setup, and create/update/reopen commands.
- [External-agent scene authoring](docs/mcp-scenes.md) — MCP setup, typed tools, revision URLs, and the deterministic cleanroom fixture.
- [Authoritative city-dump runtime](docs/mcp-game-runtime.md) — authenticated two-player matches, private material inspection, durable processing and database scheduler setup.
- [Development and integration guide](docs/development.md) — local generation, MCP, CLI, import contracts, and GIF details.
- [Scene links](docs/scene-links.md) — private scene/revision URLs, expiring shared links, and deployment steps.
- [Cloud storage guide](docs/cloud-storage.md) — private asset transfers, setup, limits, and lifecycle.
- [Supabase Auth and database setup](supabase/README.md) — schema, GitHub login, migrations, and ownership checks.
- [Cleanroom example](public/examples/cleanroom/README.md) — scene behavior, source models, and CAD licensing.

## Third-party software

Form OSS / Form Core is used under **MPL-2.0**; preserve applicable notices and obligations when reusing upstream code. STEP conversion uses `occt-import-js` and its OpenCascade/WebAssembly distribution; retain their bundled license notices. GIF encoding uses `gifenc` (MIT), and the test decoder is `omggif` (MIT).

The cleanroom robot and workbench source projects declare their mechanical CAD under **CERN-OHL-S-2.0**; see the [example provenance notes](public/examples/cleanroom/README.md). Upstream STEP test geometry is fetched by the smoke test rather than bundled in this repository.

## Citation

If you use OpenIndustries / Mergence in research, publications, or other academic work, please cite the project:

```bibtex
@software{mapped_assembly_open_industries_2026,
  author = {{Mapped Assembly}},
  title = {OpenIndustries (Mergence): Spatial workbench for hardware and manufacturing-system planning},
  year = {2026},
  url = {https://github.com/Mapped-Assembly/Open-Industries},
  note = {Open-source software}
}
```
