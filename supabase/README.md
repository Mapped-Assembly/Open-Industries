# Core Postgres and Auth

Hosted project: **astra-industries** (`mrhxfmtofvrgfaikllfw`), US East / North Virginia.
Organization: **astra-industries** (`dzvwumsgnlminyfgplww`), newly created using the default Free plan.

[Project dashboard](https://supabase.com/dashboard/project/mrhxfmtofvrgfaikllfw)

## CLI

```sh
npm install
npx supabase login
npx supabase link --project-ref mrhxfmtofvrgfaikllfw
npx supabase db push --dry-run
npx supabase db push
npx supabase db query --linked --file supabase/tests/core-ownership.sql
```

The CLI is pinned as a development dependency. Local link details and database connection caches in `.temp/` are ignored. Supply a database password through the CLI prompt or `SUPABASE_DB_PASSWORD` when needed. The provisioned password on the initial Windows workstation is stored in Windows Credential Manager under service `astra-industries-supabase`, username `postgres`; it is not stored in the repository. It can also be reset through the Supabase dashboard.

## Schema

- `public.assets`: owner-scoped asset metadata, unique by owner and content-derived asset key.
- `public.scenes`: owner-scoped versioned JSON documents for room dimensions, instance references/transforms, and animation settings.
- Ownership references `auth.users`. Authenticated clients can create/read/update/delete only their own rows. Anonymous database access is revoked; timestamps are maintained by triggers.
- The ownership test exercises two transaction-local users and database roles, checks cross-user isolation and owner CRUD, then rolls back everything. It does not test an end-to-end Auth signup/login flow.

Postgres and Auth are core (#12). S3-compatible object storage is a separate feature (#13); its migrations provision the private `astra-assets` bucket and file-version/reference tables. The local Storage services remain disabled by default. See [cloud storage](../docs/cloud-storage.md) for independent enablement, policies, and lifecycle tests. The full local `config.toml` has not been pushed to the hosted Auth service. Only the Site URL and redirect allowlist from `hosted-auth/supabase/config.toml` have been applied.

The app retains an explicit device library in IndexedDB and now supports authenticated cloud scene save/list/open/delete and library metadata sync. `save_workspace_scene` writes scene documents and storage references atomically with optimistic revision checks. Sign-in does not automatically upload local files. See [the workspace guide](../docs/workspace.md); binaries use the separate optional storage feature.

Free-plan quotas include 500 MB database size, 1 GB object storage, and 5 GB egress; inactive free projects may be paused after a week. Keep binary geometry out of metadata JSON. Creating this project did not request a paid plan, paid compute size, or add-on.

## GitHub login

1. Register an [OAuth app in GitHub](https://github.com/settings/applications/new), named **Mergence**. Homepage: your Mergence app URL (`http://127.0.0.1:8787` for local development). Authorization callback URL must be exactly:

   `https://mrhxfmtofvrgfaikllfw.supabase.co/auth/v1/callback`

2. Generate a client secret in GitHub. In [Supabase Auth providers](https://supabase.com/dashboard/project/mrhxfmtofvrgfaikllfw/auth/providers), enable GitHub and save its Client ID and Client Secret. Store the secret only in the provider settings, not in Vite variables or source code. This step requires the GitHub OAuth app owner and is not performed by the CLI setup.
3. Add these public values to a root `.env.local` (ignored) and your Vercel project's environment:

   ```dotenv
   VITE_SUPABASE_URL=https://mrhxfmtofvrgfaikllfw.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=your_publishable_key_from_supabase
   ```

4. Under Supabase Authentication → URL Configuration, the production Site URL is `https://astra-industries.vercel.app`, and its exact origin plus local ports 8787 and 5173 have been configured as redirects. Never use a production frontend URL as GitHub's callback; GitHub calls Supabase first, and Supabase returns to Mergence.
5. Rebuild/redeploy so Vite picks up the variables. Click **Sign in with GitHub**, authorize, and return to Mergence. The account name and **Sign out** button indicate the restored session. Login requests `read:user user:email`, not repository access.

Authentication uses PKCE, persists/refreshed sessions through the Supabase client, and signs out of the current browser session. OAuth errors are shown in the UI; a disabled provider is detected before navigating away. Imported assets/room settings are temporarily saved to IndexedDB for the redirect and restored once on return in the same tab (up to one hour). This temporary snapshot is not cloud scene persistence.

To update just hosted Auth redirect settings, edit `hosted-auth/supabase/config.toml`, review the diff, then apply:

```sh
npx supabase config diff --workdir supabase/hosted-auth --project-ref mrhxfmtofvrgfaikllfw
npx supabase config push --workdir supabase/hosted-auth --project-ref mrhxfmtofvrgfaikllfw
```

`npm run test:auth` exercises the real Supabase client with mocked provider/token responses: PKCE, login errors, session persistence, logout, workspace restoration, and mobile layout. It does not prove the external GitHub credentials or live authorization work. A real authorization round trip is still required after enabling the provider.

## Scene revision links

See [scene links](../docs/scene-links.md) for immutable revision URLs, owner-only access, expiring/revocable sharing, the `scene-asset` Edge Function, migration/deployment steps, and deterministic tests.
