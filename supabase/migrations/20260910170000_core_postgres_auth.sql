-- Core records depend on Supabase Auth only. Binary storage is feature #13.
create table public.assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  asset_key text not null check (char_length(asset_key) between 1 and 256),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  source_kind text not null check (source_kind in ('form', 'step')),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 524288),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, asset_key)
);

create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  schema_version integer not null default 1 check (schema_version = 1),
  document jsonb not null default '{}'::jsonb
    check (jsonb_typeof(document) = 'object' and octet_length(document::text) <= 2097152),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index scenes_owner_updated_idx on public.scenes(owner_id, updated_at desc);
create index assets_owner_updated_idx on public.assets(owner_id, updated_at desc);

create function public.set_core_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  new.created_at = old.created_at;
  return new;
end;
$$;

create trigger assets_updated_at before update on public.assets
for each row execute function public.set_core_updated_at();
create trigger scenes_updated_at before update on public.scenes
for each row execute function public.set_core_updated_at();

alter table public.assets enable row level security;
alter table public.scenes enable row level security;

revoke all on public.assets, public.scenes from anon, authenticated;
grant select, insert, update, delete on public.assets, public.scenes to authenticated;
grant all on public.assets, public.scenes to service_role;
revoke all on function public.set_core_updated_at() from public, anon, authenticated;

create policy assets_owner_access on public.assets for all to authenticated
using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy scenes_owner_access on public.scenes for all to authenticated
using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

comment on table public.assets is 'User-owned asset metadata. Geometry and GIF binary storage are tracked separately in feature #13.';
comment on table public.scenes is 'User-owned versioned room/layout/animation documents. Application-level schema validation is required.';
