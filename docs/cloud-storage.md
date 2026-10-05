# Optional private asset storage (#13)

## Enable independently

Apply migrations with `npx supabase db push`, then set `VITE_CLOUD_STORAGE_ENABLED=true` and rebuild. The flag defaults to **off** for new environments; Postgres/Auth and the IndexedDB library work independently. The workbench runs locally against your configured backend.

The existing public `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are sufficient. Users sign in with GitHub. **No S3 keys or service-role keys belong in the browser.** Supabase Storage is S3-compatible; Mergence uses its authenticated Storage API against the same bucket, with the user's JWT and storage policies. A direct S3 signing service is unnecessary for this browser workflow. If a future backend uses the S3 protocol, configure its credentials server-side and re-evaluate its access boundary; privileged S3 access may bypass these user policies.

For a local Supabase stack, explicitly enable `[storage]` and `[storage.s3_protocol]` in your local configuration before starting it. Core's default local configuration keeps those services disabled. The integration test can target a separate Supabase project via environment variables.

## Workflow

1. Import an asset, save it in **GIF studio → Asset library**, and optionally render a preview.
2. In **Cloud files**, select the local entry and click **Upload cloud copy**. Nothing uploads automatically when signing in or importing.
3. The upload includes `asset.json` (normalized geometry, retained Form project data with credential fields removed, and optional preview metadata) and `preview.gif` when available. For standalone STEP imports, you can optionally attach the **original STEP file**; its SHA-256 must match the imported source. The file is stored as `source.step`.
4. On another browser signed into the same account, open the cloud library and **Load cloud asset into room**. Downloads are hash/size-verified before use. GIFs and original STEP attachments can also be explicitly retrieved/downloaded.
5. **Remove cloud copy** removes that immutable version's files and file metadata. It does not delete local library entries, room instances, or the core asset metadata row. Changed geometry/preview/source attachments create new versions; exact retries reuse the existing version.

The full original binary STEP is currently attachable for standalone STEP assets. Form geometry and retained compiled data are preserved in the JSON bundle; resolving/uploading additional companion source artifacts belongs to the fuller artifact pipeline (#20). This is not automatic room/animation cloud persistence (#27).

Generated architectural assets tagged with generator `form-industries` are supported after migration `20260929100000_generated_scene_assets.sql`. They retain source kind `generated`; upload validation rejects unsupported generated provenance. This enables the complete bundled cleanroom to reopen through an [MCP-authored scene URL](mcp-scenes.md).

## Data contract and lifecycle

- `public.assets`: existing core identity/metadata; unique `(owner_id, asset_key)`.
- `public.asset_file_versions`: owner, asset FK, immutable descriptors (`name`, `mime`, `size`, SHA-256), content-derived fingerprint, lifecycle state, timestamps.
- Paths: `owner UUID/version UUID/asset.json`, `preview.gif`, or `source.step`. The database validates allowed descriptors; a declared version is required before any object can be uploaded.
- `pending`: durable upload intent exists. Immutable uploads use `upsert=false`; retries verify already-present objects rather than replacing them. A missing/wrong-sized/wrong-content-type object prevents finalization.
- `ready`: all declared objects exist; overwrites and direct object deletion are denied.
- `deleting`: deletion is authorized only after checking saved-scene references. A storage/API failure leaves a visible intent so **Retry removal** can finish. The row cannot be removed while storage objects remain; already-missing objects do not prevent completion.

All transitions go through owner-checking RPCs. Authenticated users cannot directly change version state/descriptors. File downloads also verify SHA-256 in the application; storage metadata checks alone are not a content hash guarantee. RPC metadata and storage policies prevent other accounts from listing, reading, writing, or deleting the user's files. Each transfer uses a session-bound client, and account changes discard stale UI results/preview URLs.

## Shared references / contract for #27

`public.scene_asset_files(scene_id, version_id, owner_id)` registers cloud scene references. Composite foreign keys enforce matching owners. Saving a cloud scene under #27 must register its version references in this table, and remove obsolete references when updating the scene. A ready-version check locks against concurrent file deletion. Scene deletion cascades its reference rows, **not the files**. Removing a referenced cloud version is blocked.

The cloud scene adapter now registers these references transactionally through `save_workspace_scene`, alongside the versioned manifest and optimistic revision update. Arbitrary IDs embedded only in JSON are not a substitute for these relation rows. See `workspace.md` for save/reopen behavior.

## Limits and recovery

- 25 MiB per binary/JSON file; 50 MiB combined upload bundle. Large renderable JSON can exceed these limits even when the original compressed CAD file was smaller.
- Supabase Free includes 1 GB object storage and 5 GB egress. Copies/previews/repeated downloads count against these quotas. The browser reports transfer failures, never a false ready result.
- Requests time out after 60 seconds. Retry with the same local bundle to resume its pending upload, or remove the pending copy. If session credentials expire, sign back in and retry.
- After a partial deletion, refresh and use **Retry removal**. Interrupted file writes cannot create untracked paths: every allowed path belongs to an intent. Incomplete intents are listed rather than hidden or automatically deleted.
- Review older pending/deleting intents in the cloud list. Administrator cleanup should use the same state transition + Storage API removal sequence; never delete `storage.objects` rows directly, which would orphan physical files. Clean up versions before deleting a user/core asset.
- Previously downloaded bytes cannot be revoked. Previously issued signed URLs/CDN copies can remain usable until their expiry/cache lifetime. Mergence normally uses authenticated downloads and zero cache lifetime on upload; clearing metadata is not a promise to erase recipients' copies.

## Verification

Build with cloud enabled and run the application on port 8787. Set these **test-process-only** variables, then run `npm run test:storage`:

```text
SUPABASE_TEST_URL=https://your-test-project.supabase.co
SUPABASE_TEST_PUBLIC_KEY=your_publishable_key
SUPABASE_TEST_ADMIN_KEY=your_test_project_service_role_key
```

The test creates two temporary confirmed users (no mail is sent), exercises the real Auth/Storage/Postgres services, injects their issued sessions into isolated Chrome contexts, and removes its data/users in `finally`. Use a dedicated test project; it writes real objects. The admin key is used only by the Node test for user setup/cleanup, never by the UI. The STEP attachment fixture is fetched from the occt-import-js test repository. Keys are never logged.

Coverage includes UI geometry/GIF uploads, identical retries, separate-browser reads, source STEP round trips, wrong-source hashes, credential-field filtering, cross-user/anonymous denial, expired signed URLs, descriptor/file limits, incomplete finalization, immutable objects, scene reference protection, interrupted uploads/removals, and cleanup. Runtime page errors fail the browser test. Screenshots are written to `test-results/13-cloud-library-after.png`.

Rebuild with `VITE_CLOUD_STORAGE_ENABLED=false` and run `npm run test:storage-disabled` to verify local imports/library and Auth controls still work with no cloud-object requests. Database ownership tests remain in `supabase/tests/core-ownership.sql` and should also pass with this feature installed.
