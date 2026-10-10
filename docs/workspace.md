# Persistent animated workspace

## Complete workflow

1. Generate projects in Form separately, then import the compiled JSON and any companion STEP files into OpenIndustries.
2. Select a scene instance. Edit its base XYZ position and rotation, rename it, duplicate it, change visibility, or delete it. Undo/redo retains up to 50 workspace edits. Reset puts that instance at the world origin with zero rotation.
3. Choose **Animate**. Select the whole instance or a component target. Set a time, edit keyframe position/rotation and whole-instance visibility, and click **Add / update keyframe**. A key at the same time is replaced. Existing key buttons seek to their time; their delete buttons remove them.
4. Play/pause, scrub, or reset to the base layout. **GIF studio → Authored timeline animation** exports a selected time range (up to 4 seconds), with per-frame instance visibility and instance/component transforms in the review JSON. Ordinary turntables use the currently previewed pose, or base poses when the timeline is reset.
5. Sign in, choose **Save / open scenes**, and save a named cloud scene. **Include cloud geometry** uploads missing asset bundles so another browser can reopen the room. Clear that checkbox for metadata-only saves. Open saved scenes explicitly from the list after refreshing.
6. **Export scene JSON** produces a portable manifest with bundled geometry and tracks. Import that JSON through the normal file picker to reopen it without cloud services.

## Shared instance model

The automatic IndexedDB drafts from #39 are retained and upgraded: the complete scene manifest, animation, and active cloud revision are autosaved after 250 ms of inactivity. Drafts and their geometry are partitioned by user (or guest) and stable room ID to avoid restoring another account's workspace. Older #38/#39 guest scenes are migrated on load while preserving repeated geometry instances and their IDs. The legacy records are retained. A local draft is separate from an explicit cloud save.

`Workspace` owns room dimensions, `SceneItem[]`, and an `Animation` document. Each item has a stable UUID, a reference to immutable imported geometry, a display name, base position/rotation, visibility, and optionally a cloud file-version ID. Repeated instances share source geometry but have independent identities and transforms. All import/library/cloud entry points use the same placement function; new assets are placed to the right of existing bounds with a gap.

The viewport and GIF renderer both use `evaluateWorkspace` and `applyWorldPoses`. Renderers never mutate imported Form data. The viewport keeps its renderer/camera alive while transforms or timeline time change; ordinary edits do not repeatedly recreate WebGL contexts or reset camera navigation.

Positions are meters with Y up. Instance rotations are XYZ Euler degrees. Keyframe positions interpolate linearly; rotations use shortest-path quaternion interpolation. Poses hold the first/last key outside the keyed interval. Instance keys are absolute world poses; component keys are offsets from imported geometry, rotated about the component's center. Whole-instance keys can also include a boolean `visible`. Visibility changes exactly at the key time and holds until the next explicit visibility key; before the first visibility key it uses the base instance visibility. Omitted visibility values preserve that held value, so older transform-only tracks keep their base visibility. Component tracks animate transforms only. Reset restores base transforms and visibility. This is visual animation, not physics or electrical revalidation.

Tracks target stable instance IDs and optional source part IDs. Deleting an instance removes its tracks. Missing/duplicate targets, invalid keyframes, unsupported versions, and non-finite transforms are rejected during scene import. GIF metadata records exact sampled frame times and evaluated transforms; GIF's 10 ms tick still determines playback timing.

## Switching rooms safely

Sidebar **New room**, saved-room open/duplicate, imported scene JSON, and generated layouts share the same transition flow. Unsaved changes offer **Save and continue**, **Discard and continue**, or **Cancel**. Signed-out users save to a device draft; signed-in users save the named cloud scene. Save/load failures keep the current editor and expose retry or cancel. A successful save continues directly without a second discard prompt.

Before a normal switch, pending device writes are flushed. New local/imported/generated/copy rooms receive a fresh room ID together with their contents; cloud rooms use their saved ID. Device writes are ordered per account and only the current room may update its active-room pointer. Explicit discard can proceed when local storage is unavailable. Corrupt drafts stay protected until recovery or explicit discard.

Late opens, saves, lists, file imports, Form generation, and cloud-asset downloads cannot update a different room or account. Cancelling a cloud action ignores its late UI result; a request already committed by the server may still appear in that account's saved scenes. Account changes retain the previous account's draft and restore the destination account's own draft. Fullscreen moves the existing workspace controls without remounting them, preserving names, dialogs, and operation guards.

Run `npm run test:room-transitions` for the isolated browser/SQL regression suite. It covers room identity, independent timelines, save/open/storage failures, conflicts, retry/cancel/discard, delayed results, missing geometry, duplicate/delete independence, and keyboard/mobile/fullscreen behavior.

## Postgres and storage

`SceneRepository` uses a session-bound authenticated Supabase client. Core metadata operations do not depend on the optional storage flag:

- Explicit scene save/list/open/delete and explicit device-library metadata sync operate through Postgres.
- `save_workspace_scene` writes the versioned scene document and `scene_asset_files` references in one transaction. Referenced files must be ready and belong to the same user and asset identity.
- Each scene has a revision. A save against a stale revision fails visibly instead of overwriting another device's edits. Reopen the current revision or choose **Save as new copy**. Delete also checks the revision.
- A failed first save retains its generated scene ID in the current UI, so retrying does not blindly create another scene. An uncertain committed write can be recovered through the scene list. Uploaded file intents remain independently visible/recoverable in the cloud library if the final scene save fails.
- Deleting a scene releases references, not shared geometry files. Object deletion is blocked while another scene references the version.
- Sign-out/account changes clear the active workspace, scene selection, and user-specific cloud lists. Source files already explicitly stored in the device library remain local files.

Opening a metadata-only scene on a device without the source files produces labeled red **missing geometry placeholders** at the saved transforms. Reimporting the exact original asset replaces placeholders while retaining instance IDs and animation. Missing geometry cannot be exported as a review GIF. Source digests, project IDs, and Form revision numbers identify the expected design. Pinned cloud files are downloaded and integrity-checked independently of the upload flag. Missing pinned geometry requires its exact cloud file version; a matching local asset ID or source digest is not a substitute.

Scene lists and the metadata catalog currently show the latest 200 records. Binary files keep the storage feature's 25 MiB/file and 50 MiB/bundle limits; scene JSON in Postgres is limited to 2 MiB and 1,000 instances. Local portable scene files are limited to 75 MiB on import. Animation documents allow up to 120 seconds, 1,000 tracks, and 10,000 keys. Large models still require practical performance validation on the target hardware.

## Saved revision history

Expand **Revision history** for an owned scene to inspect authorship and change summaries, compare any two saved revisions, or restore an earlier snapshot as a new head. A stale restore returns the current revision and leaves history unchanged. See [revision history and restore](scene-history.md) for migration, exact file-version binding, and legacy-cache recovery details.

## Form data and inspector

The importer retains sanitized source documents and a known-field IR model. Raw IR, project/hardware wrappers, compiled manifests, and namespace objects preserve overview, component identities, BOM, validation, project revision, agent provenance, and artifact declarations. Namespace BOM/validation payloads and companion-CAD projects retain their metadata. Credential-like fields are excluded.

The inspector presents labeled overview/source data, severity-tagged validation, BOM rows, mechanical information, component metadata, and selectable geometry. Raw retained JSON remains available as an advanced view. Duplicate/missing component refs, unknown placement refs, ambiguous artifact declarations, and checksum failures produce import diagnostics. Inline CAD with explicit component refs can coexist with envelope-only components; unmatched whole-assembly CAD is not guessed into component identities.

`scripts/workspace-test.ts` contains synthetic, sanitized contract fixtures for SDK/OpenCode/Codex-shaped artifacts, namespaces, mixed geometry, and companion CAD. These verify the handoff format; they are not claims that live agent generation was run. Broader real-project fixtures and CAD shape mapping can extend this suite.

## Verification

- `npm run test:workspace`: pure contract/model checks, source immutability, stable transforms, component sampling, rotations, scene serialization and missing-asset recovery.
- `npm run test:workspace-live`: real Supabase Auth/Postgres/Storage with isolated Chrome contexts. Set the test-only keys documented in `cloud-storage.md`. Verifies timeline/GIF frame agreement, cloud save/reopen, shared file protection, conflicts, user isolation, portable scene JSON, and missing geometry restoration. Test data is cleaned up.
- Existing Auth, fullscreen, CAD, GIF and import smoke tests remain applicable.

## Form animation feedback

GIF studio's authored-animation export records the evaluated frame poses. **Send feedback to Form** stores those poses, the animation manifest, source identities, and a user instruction in `.astra/feedback/latest.json`. The local OpenCode command `/form-feedback` consumes that package and calls Form's `form.opencode.update_project` MCP tool. OpenIndustries then reimports the revised compiled project for another animation review. The package is scrubbed for credential-like fields and is not sent to cloud automatically.

## CLI room transfer

The `astra` CLI uses the same Supabase Auth account as the browser. `astra auth login` uses GitHub OAuth through a local callback, `astra rooms list` lists owned cloud rooms, `astra rooms export` downloads a portable manifest, `astra rooms import` saves a local manifest as a new cloud room, and `astra rooms validate` checks a local file without network access. CLI cloud transfer deliberately excludes binary geometry; geometry upload remains an authenticated OpenIndustries browser operation through the existing storage policy.

`ASTRA_BASE_URL` can point the live workspace test to the deployed app. Use a dedicated test project for new deployments and never place test admin credentials in Vite environment variables.
