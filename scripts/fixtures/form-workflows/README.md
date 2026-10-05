# Captured Form handoff workflows

These public, sanitized outputs complement the synthetic contracts in `../form-import`.
`provenance.json` records source revisions, the portable client hash, sanitation and
SHA-256 for every captured file. The tests consume committed outputs; they never
call a provider, MCP server, account, or database.

| Capture | Actual producer | Schema and representation |
| --- | --- | --- |
| `sdk/project-ir-0.1.json` | Form OSS v0.2.0 public `blueprint_core.generation.generate_project_with_workflow`, simulation mode | Compiled Hardware IR 0.1, component envelopes |
| `sdk/project-ir.json` | Installed `caid-forma-core==0.3.5` public generation API, simulation mode | Compiled Hardware IR 0.2, definitions/instances/BOM, component envelopes |
| `sdk/project-object.json` | Installed SDK `build_project_object` | Namespace object, including history, BOM, validation and mechanical data |
| `opencode/forma-project.json`, `compiled-project.json` | Published portable `forma.py compile --authoring-agent opencode --update-project`, calling the real local `forma.compile_project` handler | Compiled 0.2, original local STEP reference and declared artifact hashes |
| `codex/forma-project.json`, `compiled-project.json` | Same published compile workflow with `--authoring-agent codex` | Compiled 0.2, inline BASE mesh and TOP envelope |
| `{opencode,codex}/project-object.json` | Pinned upstream `build_project_object` over each actual compiled result | Namespace handoff |
| `{opencode,codex}/authored-ir-0.1.json` | Small author-owned inputs created by the capture script | Legacy 0.1 authoring input, upgraded to 0.2 by the real compiler |

The agent captures execute the shared portable client and real compile handler;
they are **not recordings of native OpenCode or Codex application sessions**, and
do not claim to test model-generated design quality. The two authored inputs have
distinct project IDs and CAD representations. SDK simulation returns its bundled
demo project for the recorded prompt. None of these fixtures is a private design
or a fabrication instruction. The STEP block is self-authored geometry generated
by the capture script, not third-party CAD.

## Reproduce the captures

Use Python 3.12, git and uv, from the repository root. Python dependencies are only
needed for recapture, not the normal npm tests.

```sh
git clone https://github.com/caid-technologies/Form-OSS.git /tmp/form-upstream
git -C /tmp/form-upstream checkout d594bd3317860eb1225030dcc38d8a2a26f5d291
git -C /tmp/form-upstream worktree add --detach /tmp/form-legacy 6125a56e16b71de21d38929bc1ec09e94119ec21
uv venv /tmp/form-capture-env --python 3.12
uv pip install --python /tmp/form-capture-env/bin/python -r scripts/form-workflow-capture-requirements.txt
/tmp/form-capture-env/bin/python scripts/capture-form-workflows.py \
  --upstream /tmp/form-upstream --legacy-upstream /tmp/form-legacy \
  --output /tmp/form-recaptured
diff -r scripts/fixtures/form-workflows /tmp/form-recaptured
```

Only this README is absent from the fresh output. Both checkouts are verified by
commit. Each phase runs in an isolated temporary directory with a fresh local
SQLite database, a minimal environment without inherited credentials, and a
network audit hook allowing only loopback connections. The historical SDK has
no `persist_project` flag, so its own persistence uses that disposable database.
The current SDK uses `persist_project=False`. Agent subprocesses talk only to
the local HTTP adapter around the unmodified upstream MCP handler. Actual
`tools/call` requests are captured in `compile-requests.json`; only JSON-RPC request
IDs are normalized. No compiler responses or geometry converters are mocked.

Timestamps are normalized to `2026-09-29T00:00:00Z`, and the exact list of removed
model/provider selection fields is recorded in provenance. Fixed project IDs and
the `sdk` source label are explicit generation metadata inputs, not rewritten
outputs. Materialized validation, wiring and schematic artifacts retain their
original bytes and compiler-declared hashes. Other JSON is sorted/indented for
review. Hardware, findings, BOM, revision, agent, artifact references and namespace
extensions are preserved. The tests also check every JSON file against the
application's portable-data scrubber.

## Verify the handoff

```sh
npm ci
npm run test:form-import
npm run test:form-workflows
npx playwright install --with-deps chromium
npm run test:form-workflows-browser
```

The pure suite covers all nine captured outputs, both compiled IR versions and
legacy migration, real OpenCascade STEP conversion, millimeters/Z-up conversion,
source retention, namespace history, exact CAD paths and unique-basename fallback,
duplicate filenames/declarations, declared hashes, missing CAD envelopes, mixed
geometry, stable part IDs, placement and portable round trips. Invalid JSON,
unsupported versions, incomplete projects, missing geometry and malformed fields
are explicit mutations of the real capture, not mislabeled producer outputs.

The Playwright suite uses the actual app and CAD worker. It checks SDK 0.1/0.2,
OpenCode STEP/missing-STEP, Codex mixed and namespace imports; inspector provenance,
BOM and retained IR; component selection and STEP canvas raycast; independent
instance duplication/placement; export/reopen; atomic invalid-import recovery;
desktop and mobile layouts; page/console/network health. Google Fonts CSS is
fulfilled locally with an empty stylesheet; other external requests fail the test.
On mobile the existing responsive UI hides the inspector, so selection uses its
visible timeline control. `ASTRA_CHROME_PATH` can select an installed Chromium.
Set `FORM_IMPORT_EVIDENCE_DIR` to retain screenshots and exported scenes. CI uploads
these as `form-import-browser-evidence`.

The browser suite also selects a real project folder with duplicate STEP basenames
in separate directories, checks project-relative resolution, and verifies malformed
hash, checksum mismatch, ambiguous loose-file and missing-sibling recovery. The
focused `test:cad` suite covers nested/multiple project roots, optional and strict
64-character SHA-256 declarations, and inaccessible path references.
