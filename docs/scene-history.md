# Revision history, comparison, and restore

Every accepted cloud save appends an immutable revision under the same scene ID. Open an owned scene, expand **Revision history** in **Save / open scenes**, and inspect its revision number, parent, timestamp, authenticated account, authoring source/agent label, and change summary. History loads 25 revisions at a time; **Load older revisions** continues from a revision cursor.

Choose two revisions and click **Compare revisions**. The comparison shows scene names and dimensions, instance additions/removals, poses, visibility, asset/source identities, immutable cloud file versions, timeline settings, and changed keyframe positions/rotations. Large comparisons show the first 200 changes and the total; each revision remains available through its own URL. Unknown document fields and raw provider configuration never enter the comparison.

**Restore revision N** appends the selected snapshot as a new head. It restores the name, scene content, animation, and exact asset versions while recording the current head as its parent and N as its restore source. Existing snapshots and shared URLs remain unchanged. Confirm the action explicitly; the prompt warns when the current workspace has unsaved edits. Export or save those edits first if you need them. A restore in a link workspace advances its displayed private revision URL and preserves the separate local draft.

A concurrent edit produces a conflict containing the current revision. Restore does not silently advance its base or overwrite another edit. Use **Refresh history**, compare the new head, then choose restore again. Save, rename (a save with a new name), and delete also keep their existing base-revision checks. Retries of a committed restore use the same request UUID and return the same head revision; after a later edit they conflict.

History and restore require owner authentication. A shared revision link grants access only to that snapshot and its geometry; it does not grant history, comparison of other revisions, or restore permission.

## Exact geometry bindings

Scene-list opens and private/shared revision URLs now use the same snapshot loader. A pinned instance must load the exact ready `cloudVersionId` retained by its revision, with size/hash and source checks. The loader never replaces it with device geometry merely because the asset ID, source digest, or project revision matches. One workspace can hold two file versions of the same asset ID. The viewport rebuilds geometry when a file-version binding changes while retaining its renderer for ordinary pose edits.

Local drafts store geometry by account/room, asset ID, and file-version ID. The hydrator accepts a separate version map; the unversioned asset list only satisfies unversioned instances. Missing pinned geometry remains a labeled placeholder. Importing an ordinary local source file does not silently claim that it is the missing immutable cloud version.

Portable `astra.scene` v1 exports keep unversioned geometry in `bundledAssets` and version-bound geometry in `bundledVersions`, with entries `{ cloudVersionId, asset }`. These explicit bindings round-trip multiple versions of the same asset offline. They describe the supplied portable snapshot; cloud revision URLs independently retrieve the server's immutable bytes. Both bundle fields are prohibited in cloud scene documents; binary geometry stays in Storage.

Older unversioned local drafts and portable files remain supported. Older **pinned** caches/bundles that record only an asset ID lack a verifiable file-version association and are not silently upgraded. Their original records are retained, and affected instances show missing geometry. Reopen the saved cloud revision to retrieve its exact files, then save/export a fresh copy. Metadata-only scenes still use matching local sources because they contain no cloud pin. The Storage feature flag controls uploads, not reads of already-pinned files.

## Database and API

Apply all migrations through `20260929120000_scene_history.sql` before using the new history UI/RPCs. This extends the existing `scene_revisions` / `scene_revision_assets` store introduced in #69; it does not create a second store or deploy the backend automatically.

New revision columns:

| Column | Meaning |
| --- | --- |
| `parent_revision` | Previous head, assigned by the database, or null for the first recorded snapshot |
| `author_id` | Authenticated account that performed the write; existing snapshots retain their owner attribution |
| `author_source` / `author_agent` | Allowlisted source category and bounded agent label; client-declared, not an authenticated LLM identity |
| `restored_from_revision` | Restore source when applicable |
| `change_summary` | Server-derived instance/asset counts and name/room/animation flags |

Migration backfill preserves existing documents and timestamps. Missing pre-migration history cannot be reconstructed; absent parents stay null. Summaries contain known flags/counts rather than free-form prompts, provider payloads, or caller-supplied summaries. Broader retained-Form-data sanitization remains tracked separately in #37.

- `list_scene_revisions(p_id, p_before_revision = null, p_limit = 25)` returns `scene_id`, `head_revision`, metadata-only `revisions`, and `next_before`. Limit: 1–50.
- `get_workspace_scene(p_id, p_revision, p_share_token = null)` remains the snapshot read API. The client comparison uses two owner-authorized reads and an allowlisted field diff; it does not download geometry to compare revisions.
- `restore_workspace_scene(p_id, p_revision, p_expected_revision, p_write_id)` restores through `save_workspace_scene` under the scene's row lock. Snapshots and head/reference updates share one transaction.
- Stale save/rename/delete/restore operations return SQLSTATE `40001` with JSON error details containing `current_revision`. The client exposes this as `SceneConflictError.currentRevision`.

Duplicate still creates a separate scene, revision 1, and new instance/animation-target IDs while retaining the referenced immutable geometry. It records source `duplicate` rather than copying the old agent's authorship. Referenced historical files remain protected from deletion. A failed reference check rolls back the head, snapshot, and all reference changes together.

## Verification

```sh
npm run build
npm run test:scene-history
npm run test:scene-links
npm run test:mcp-scenes
npx playwright install chromium
npm run test:scene-history-browser
```

The deterministic suite uses the real migrations/RLS/RPCs in PGlite with local fixture authentication and Storage emulation. It covers migration backfill, provenance, sanitized summaries/diffs, same-asset-ID/different-file-version loading, portable bindings, concurrent stale-base requests, stale rename/delete/restore, restore retries/rollback, pagination, duplicate independence, and cross-user/anonymous denial.

The browser variant checks history, comparison, successful restore, stale restore recovery, the new revision URL, clean saved-state detection, and version-aware IndexedDB round trips. The existing scene-link and MCP suites remain regression gates. CI runs these without live Supabase or LLM credentials. `ASTRA_CHROME_PATH` can select an installed Chromium executable.
