# Scene and revision links

Cloud saves return two URLs:

| URL | Behavior | Access |
| --- | --- | --- |
| `/?sceneId=<uuid>` | Opens the latest saved revision when loaded | Owner sign-in |
| `/?sceneId=<uuid>&revision=<number>` | Opens that immutable revision | Owner sign-in |
| `/?sceneId=<uuid>&revision=<number>#share=<token>` | Opens only the explicitly shared revision | Anyone holding the unexpired, unrevoked link |

In **Save / open scenes**, save the scene and use **Copy private revision link**. To let someone else view it, choose **Create shared revision link**, then **Copy shared link**. The UI creates a link lasting seven days. **Revoke all shared links** invalidates every share for that scene, including older revisions. Sharing a revision does not share future edits or grant editing permission.

Include cloud geometry when saving for another browser/device. Metadata-only scenes retain their layout and animation but show labeled missing-geometry placeholders on another device. The viewer reports unavailable assets, missing revisions, sign-in/access errors, and expired or revoked shares. Supported generated architecture is uploadable after migration `20260929100000_generated_scene_assets.sql`; its synthetic provenance is preserved. Portable JSON remains available without cloud services.

Owners can inspect history, compare revisions, and restore an earlier revision as a new head. These operations are not granted by shared links. See [revision history and restore](scene-history.md).

## Workspace isolation

A URL opens an isolated workbench. It never restores, edits, or autosaves over the existing IndexedDB draft, OAuth recovery snapshot, asset cache, or active-room pointer. Edits in a link workspace are temporary until explicitly exported or saved to cloud. **Return to saved workspace** opens the original local workspace. Private-link sign-in returns to the requested revision rather than the default room.

## Agent/API contract

`save_workspace_scene` and `duplicate_workspace_scene` still return the saved scene record, now including `head_url` and `revision_url`. The existing `revision` is the immutable revision ID within the scene. Stale `p_expected_revision` writes continue to fail. Retrying the same successful `p_write_id` does not create another revision.

The database returns **origin-relative URL references** so one database can support development, preview, and production origins. An agent should resolve these against its configured workbench origin, never the Supabase API origin:

```js
const result = await client.rpc('save_workspace_scene', {
  p_id: sceneId,
  p_name: name,
  p_document: manifest,
  p_expected_revision: baseRevision, // 0 to create
  p_write_id: writeId,
});
if (result.error) throw result.error;
const scene = Array.isArray(result.data) ? result.data[0] : result.data;
const revisionUrl = new URL(scene.revision_url, workbenchOrigin).href;
```

`SceneRepository.save()` and `.duplicate()` return absolute URLs in the browser, or when passed a fourth constructor argument specifying the workbench origin. The local stdio `astra.create_room` tool creates local JSON only. The separate `astra.create_scene` and `astra.update_scene` tools persist complete scenes and return these URLs; see [MCP scene authoring](mcp-scenes.md).

Read a cloud snapshot with `get_workspace_scene(p_id, p_revision, p_share_token)`. A null revision selects the head for the owner. A share requires both the exact revision and its token. Responses contain `scene` and only that revision's retained asset versions. Private reads require the user's JWT; never give an agent a service-role key.

`create_scene_share(p_id, p_revision, p_expires_at)` requires owner authentication, defaults to seven days, and accepts at most 30 days. It returns `id`, `url`, and `expires_at`. `revoke_scene_shares(p_id)` revokes all shares for the scene. Tokens are stored as hashes and carried in URL fragments so they are not sent in normal page requests or referrers. Treat the full link as a bearer credential.

## Deployment

1. Apply migrations with the normal Supabase migration process (`supabase db push`). Scene links require `20260929040000_scene_revision_links.sql`; history/restore additionally require `20260929120000_scene_history.sql`. Apply all intervening migrations.
2. Deploy `supabase functions deploy scene-asset`. Its `verify_jwt = false` setting is intentional: signed-out shared viewers authenticate with a capability checked by the database on every request. The function uses Supabase's built-in server environment variables. Never expose the service-role key in Vite configuration.
3. Build/deploy the frontend with the existing `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Enable `VITE_CLOUD_STORAGE_ENABLED=true` to upload geometry. Reading an existing link's geometry does not depend on that upload flag.
4. Allow the application's scene query URLs in the Supabase OAuth redirect allowlist (for example, the trusted application origin followed by `/**`).

Shared geometry stays in the private bucket. The Edge Function first authorizes the exact scene/revision, then proxies only a referenced `asset.json`; callers cannot supply an arbitrary object path. It sends `Cache-Control: no-store` and does not issue reusable signed URLs. Revocation/expiry blocks subsequent scene and geometry requests; it cannot erase data a viewer has already downloaded or displayed. An in-flight authorized download may finish.

Existing scene heads are backfilled as snapshots. Revisions overwritten before this migration cannot be reconstructed and return a missing-revision error. Historical geometry remains retained even when a newer head removes it. Deleting a scene explicitly deletes its revision/share history and releases references; it does not delete the underlying assets automatically. Used scene IDs cannot be recreated, so an old link cannot later resolve to an unrelated scene.

## Verification

```sh
npm run test:scene-links
npx playwright install chromium
npm run test:scene-links-browser
```

The first suite applies the actual migrations in PGlite/PostgreSQL with minimal Supabase auth/storage schema stubs and exercises SQL permissions, revisions, retention, sharing, and the geometry proxy. The browser suite starts its own Vite server with test-only cloud configuration and uses the real Supabase browser client, intercepted HTTP backed by the same database RPCs, and deterministic geometry. It checks a fresh browser context, animation interpolation, private access, head versus pinned revisions, UI share/revoke actions, error states, and byte-for-byte preservation of existing local records and the active-room pointer. No live cloud, agent, or provider credentials are used. `ASTRA_BASE_URL` and `ASTRA_CHROME_PATH` can override the local server and browser executable.
