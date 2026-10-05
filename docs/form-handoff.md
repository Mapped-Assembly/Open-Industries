# Form Handoff Contract

Mergence accepts compiled Form project artifacts produced by the Form SDK, OpenCode, or Codex. Authoring and compilation remain outside Mergence; Mergence imports the accepted artifact for spatial review and layout.

## Supported Artifact

The preferred file is a `form-project.json` manifest containing a compiled `project_ir`:

```json
{
  "format": "form-project",
  "version": 1,
  "project_id": "project-id",
  "project_ir": {
    "hardware_ir_version": "0.2",
    "overview": { "title": "Example project" },
    "mechanical": {},
    "components": [],
    "part_definitions": []
  },
  "agent": "opencode",
  "artifacts": [{ "path": "models/enclosure.step" }]
}
```

The importer also accepts these existing Form representations:

- A top-level `hardware_ir` object.
- A top-level `project_ir` object.
- A `form.project` (or legacy `forma.project`) namespace object containing `project.meta`, `product.overview`, `product.electrical`, and `product.mech` payloads.

Legacy `forma-project` manifests and the `forma-project.json` entry-point filename remain supported alongside `form-project` / `form-project.json`. The branding change does not require editing existing project files.

Compiled IR is preferred over a draft IR. The compiled project is the source of truth for validation, component identity, mechanical placements, and CAD references.

## Provenance

When present, the manifest should include:

- `project_id`: stable Form project identity.
- `revision`: source revision or namespace object revision.
- `agent`: one of `sdk`, `opencode`, or `codex`.
- `hardware_ir_version`: supported Hardware IR version (`0.1` or `0.2`).
- `validation`: compiler validation summary and findings.
- `artifacts`: local artifact paths and optional SHA-256 digests.

### Portable data policy

Authoring provenance identifies the project and its author; runtime configuration describes how a provider was called. Only the former belongs in a portable artifact.

| Retained authoring/hardware data | Excluded execution data |
| --- | --- |
| Project ID, revision, authoring agent, Hardware IR version | `runtime_config`, provider/model/LLM/inference configuration and settings containers |
| Components, BOM, compiler findings, mechanical placements, geometry | Provider identifiers, model identifiers, API base URLs and provider endpoints |
| Source filename/digest, CAD references, artifact paths and SHA-256 digests | Credential fields, including API keys, passwords, authorization and tokens |

The shared `scrubPortableData` policy recursively removes these fields through objects, arrays, SDK `response` wrappers, namespace payloads, and retained source documents. Field matching ignores case, underscores and hyphens. Generic `model`, `endpoint` and `temperature` fields are excluded in authoring metadata and records containing runtime settings; CAD adapters such as `cad_model.model` and physical component/BOM `model` values are retained. `agent`, `source_agent`, project IDs and revision counters are not provider configuration and remain intact.

This policy runs when importing Form data, reading legacy geometry bundles or scene manifests, writing cloud geometry, exporting portable scenes (including pinned `bundledVersions`) or recovery downloads, and reading/saving local Form files through MCP. CLI room import/export uses the same policy. MCP scene responses also keep their existing allowlisted contract. Sanitization returns a new object: original files and immutable cloud bytes are not rewritten, and their byte digests remain source identities. Legacy records are sanitized on read and on their next export; this is not a migration of previously stored objects.

Producers must still exclude prompts containing secrets and server logs. This is a structured-field policy, not a scanner that can recognize arbitrary secrets pasted into free-form prose or binary CAD files.

### Source revision recovery

A scene reference binds the asset ID, source kind, source digest, Form project ID/schema version, and source revision when present. Both opening a scene and repairing missing geometry check these values. An ID match alone is insufficient. A mismatch reports how to recover before replacing the current workspace; reimport the original project/revision or open a portable scene containing its matching geometry. Correct repairs retain instance IDs, transforms, visibility, room dimensions and animation. Cloud-pinned instances additionally require their exact immutable file-version binding.

Deterministic checks: `npm run test:portable-scenes` covers nested wrappers, retained CAD/BOM/provenance, legacy bundles, pinned exports and mismatch recovery. `npm run test:portable-scenes-browser` verifies export/import across browser origins and a visible mismatch warning without replacing the current room. `npm run test:mcp-scenes` checks actual uploaded JSON bytes and local MCP Form read/save boundaries. No live provider credentials are required.

## CAD Resolution

Mergence resolves CAD only from files explicitly selected with the project JSON. A CAD reference may be a path, filename, or nested CAD source object. Use **Import project folder** to retain the selected folder's relative paths, or select the JSON and STEP files together with the ordinary file picker.

For folder imports, references are relative to the JSON file's directory: `Root/form-project.json` plus `cad/part.step` resolves to `Root/cad/part.step`, even when `Root/other/part.step` is also selected. Nested project directories and multiple project manifests each use their own base directory. Separators, redundant `.` segments and repeated separators are normalized; filename matching remains case-sensitive. An exact path wins over basename matches. A missing folder-relative file never binds to a different directory just because its basename matches. Separately selected files without directory information retain unique-basename fallback; ambiguous matches are rejected. Other selected STEP files remain independent scene assets.

Every declared `artifacts[].sha256` must be a string containing exactly 64 hexadecimal characters, including declarations whose files are missing. Hashes are optional, accept upper/lowercase, and retain their original spelling in the source document. Invalid declarations fail before geometry conversion or envelope fallback. The resolved companion's bytes must match its declared digest before cached or newly converted geometry is used. Normalized exact artifact declarations take precedence over unique-basename declaration fallback; duplicate/ambiguous declarations and checksum mismatches fail with actionable errors.

Remote URLs, URI schemes, absolute server/drive/UNC paths and references containing `..` are metadata only. They are neither fetched nor matched to a local namesake automatically. Missing CAD may fall back to `mechanical.component_placements` or `mechanical.render_dimensions` envelopes when those fields are available; projects without usable geometry fail explicitly. A failed import leaves the current scene and its placements unchanged.

`npm run test:cad` covers directory roots, nested projects, duplicate names, declaration identity and malformed/mismatched hashes. `npm run test:form-workflows-browser` exercises the actual folder picker and CAD worker, same-named files in separate directories, missing CAD, integrity/ambiguity errors, preservation of the existing scene and recovery through scene reopen.

Form mechanical placement coordinates are millimeters with Z-up. Mergence normalizes imported geometry to meters with Y-up and keeps the normalization offset in the scene asset metadata.

## Agent Workflows

The SDK, OpenCode, and Codex workflows converge on the same compiled artifact:

```text
SDK or agent authors Hardware IR
  -> form.compile_project
  -> form-project.json with compiled project_ir
  -> Mergence imports JSON and selected CAD artifacts
  -> Mergence reviews and arranges the project spatially
```

OpenCode and Codex should use the `form-hardware` skill and set the authoring agent explicitly when compiling:

```bash
python .agents/skills/form-hardware/scripts/form.py compile \
  "$PROJECT_DIR/form-project.json" \
  --authoring-agent opencode \
  --output "$PROJECT_DIR/compiled-project.json" \
  --update-project
```

Use `--authoring-agent codex` for Codex-authored projects. The resulting manifest, not the pre-compiled draft, is the file to import into Mergence.

## Ownership Boundary

Form owns the authored Hardware IR, electrical validation, component identity, and compiled project revision. Mergence owns room placement, camera context, visibility, and spatial review state. Mergence spatial edits are not electrically revalidated by Form unless a later explicit handoff workflow is used. Authored animation reviews are handed back as a scrubbed `astra.animation-feedback` package; OpenCode applies accepted mechanical changes through Form's `form.opencode.update_project` tool before Mergence reimports the revised artifact.

## Compatibility

Unsupported versions and malformed variants must fail with an actionable message. Mergence must retain local file import when Form MCP is unavailable. Direct MCP integration is optional and must remain server-side; credentials must never enter the browser bundle or saved scene files.


### Typed import validation

The import models in `src/lib/form-model.ts` follow the [upstream Hardware IR definitions](https://github.com/caid-technologies/Form-OSS/blob/d594bd3317860eb1225030dcc38d8a2a26f5d291/forma_core/workspaces/projects/models.py). Known overview, component, part-definition, BOM, net/pin, validation, mechanical, assembly, architecture, and provenance fields are typed and checked before either envelope or companion-STEP import. Errors identify the failing field, for example `project_ir.bom[0].quantity` or `namespace.mechanical.component_placements[0].size.x_mm`.

Optional sections may be absent. Nullable overview, mechanical, requirements, architecture, validation and metadata sections remain supported; geometry must still be available to render an asset. A missing raw-IR version keeps the legacy 0.1 default, while namespace documents default to 0.2. Explicit unsupported, empty or non-string versions are rejected. Object revision counters are independent of the Hardware IR version.

Validation retains the sanitized source document and all extension fields without coercion, defaults or IR-version migration. In particular, legacy 0.1 component quantities are not expanded into invented geometry. Open-ended CAD adapters, electrical specifications, instance configurations and vendor namespaces remain data rather than execution instructions. Structured runtime settings and secrets remain excluded by the portable-data policy above.

This is import structure validation, not a rerun of the upstream compiler's electrical, BOM consistency or manufacturing checks. Existing compiler findings are retained for inspection, including unsuccessful validation results. The deterministic `npm run test:form-import` suite covers both IR versions, all supported wrappers, legacy identifiers, missing/malformed fields, source retention, normalized geometry, companion-CAD imports and portable round trips. Attributable SDK/portable-agent workflow captures and reproduction instructions are in `scripts/fixtures/form-workflows`; `test:form-workflows` and `test:form-workflows-browser` verify those outputs without provider credentials.
