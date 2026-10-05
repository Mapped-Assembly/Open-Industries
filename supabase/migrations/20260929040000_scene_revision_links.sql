-- URL references are origin-relative so the same database works with local,
-- preview and production workbenches. API clients resolve against their app URL.
alter table public.scenes
  add column head_url text generated always as ('/?sceneId=' || id::text) stored,
  add column revision_url text generated always as ('/?sceneId=' || id::text || '&revision=' || revision::text) stored;

-- Keep only used IDs after deletion so a stale URL cannot point at a new scene.
create table public.scene_identities (id uuid primary key);
insert into public.scene_identities select id from public.scenes;
alter table public.scene_identities enable row level security;
revoke all on public.scene_identities from public,anon,authenticated;

create table public.scene_revisions (
  scene_id uuid not null,
  revision integer not null check (revision > 0),
  owner_id uuid not null,
  name text not null,
  document jsonb not null,
  created_at timestamptz not null default now(),
  primary key (scene_id, revision),
  unique (scene_id, revision, owner_id),
  foreign key (scene_id, owner_id) references public.scenes(id, owner_id) on delete cascade
);
create table public.scene_revision_assets (
  scene_id uuid not null,
  revision integer not null,
  owner_id uuid not null,
  version_id uuid not null,
  primary key (scene_id, revision, version_id),
  foreign key (scene_id, revision, owner_id) references public.scene_revisions(scene_id, revision, owner_id) on delete cascade,
  foreign key (version_id, owner_id) references public.asset_file_versions(id, owner_id) on delete restrict
);
create index scene_revision_assets_version_idx on public.scene_revision_assets(version_id);
create trigger revision_file_ready before insert on public.scene_revision_assets
for each row execute function public.check_scene_file_ready();

-- Existing heads are recoverable; versions overwritten before this migration are not.
insert into public.scene_revisions(scene_id, revision, owner_id, name, document, created_at)
select id, revision, owner_id, name, document, updated_at from public.scenes;
insert into public.scene_revision_assets(scene_id, revision, owner_id, version_id)
select f.scene_id, s.revision, f.owner_id, f.version_id from public.scene_asset_files f join public.scenes s on s.id=f.scene_id;

create function public.snapshot_scene_revision() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    if exists(select 1 from public.scene_identities where id=new.id) then raise exception 'Scene ID was already used. Create a new scene ID'; end if;
    insert into public.scene_identities values(new.id);
  end if;
  insert into public.scene_revisions(scene_id, revision, owner_id, name, document, created_at)
  values(new.id, new.revision, new.owner_id, new.name, new.document, new.updated_at);
  insert into public.scene_revision_assets(scene_id, revision, owner_id, version_id)
  select distinct new.id, new.revision, new.owner_id, (value->>'cloudVersionId')::uuid
  from jsonb_array_elements(new.document->'instances') where value ? 'cloudVersionId';
  return new;
end;
$$;
create trigger scenes_snapshot after insert or update on public.scenes
for each row execute function public.snapshot_scene_revision();

-- Old revisions retain their geometry even after the head stops using it.
create or replace function public.begin_asset_file_delete(p_id uuid) returns public.asset_file_versions
language plpgsql security definer set search_path='' as $$
declare result public.asset_file_versions;
begin
  select * into result from public.asset_file_versions where id=p_id and owner_id=auth.uid() for update;
  if not found then raise exception 'Cloud copy not found'; end if;
  if exists(select 1 from public.scene_asset_files where version_id=p_id)
    or exists(select 1 from public.scene_revision_assets where version_id=p_id) then
    raise exception 'This cloud copy is referenced by a saved scene revision. Delete the scene before removing its geometry';
  end if;
  update public.asset_file_versions set state='deleting', updated_at=now() where id=p_id returning * into result;
  return result;
end;
$$;

create table public.scene_shares (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null,
  revision integer not null,
  owner_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (scene_id, revision, owner_id) references public.scene_revisions(scene_id, revision, owner_id) on delete cascade
);
create index scene_shares_scene_idx on public.scene_shares(scene_id);
alter table public.scene_revisions enable row level security;
alter table public.scene_revision_assets enable row level security;
alter table public.scene_shares enable row level security;
revoke all on public.scene_revisions, public.scene_revision_assets, public.scene_shares from public, anon, authenticated;
grant select on public.scene_revisions, public.scene_revision_assets to authenticated;
create policy revision_owner_read on public.scene_revisions for select to authenticated using (owner_id=(select auth.uid()));
create policy revision_assets_owner_read on public.scene_revision_assets for select to authenticated using (owner_id=(select auth.uid()));

create function public.create_scene_share(p_id uuid, p_revision integer, p_expires_at timestamptz default now()+interval '7 days')
returns jsonb language plpgsql security definer set search_path='' as $$
declare token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''); share_id uuid;
begin
  if auth.uid() is null or not exists(select 1 from public.scene_revisions where scene_id=p_id and revision=p_revision and owner_id=auth.uid()) then
    raise exception 'Scene revision not found or access denied';
  end if;
  if p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '30 days' then raise exception 'Share expiry must be within 30 days'; end if;
  insert into public.scene_shares(scene_id,revision,owner_id,token_hash,expires_at)
  values(p_id,p_revision,auth.uid(),encode(sha256(convert_to(token,'UTF8')),'hex'),p_expires_at) returning id into share_id;
  return jsonb_build_object('id',share_id,'expires_at',p_expires_at,'url','/?sceneId='||p_id::text||'&revision='||p_revision::text||'#share='||token);
end;
$$;
create function public.revoke_scene_shares(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.scenes where id=p_id and owner_id=auth.uid()) then raise exception 'Scene not found or access denied'; end if;
  update public.scene_shares set revoked_at=now() where scene_id=p_id and revoked_at is null;
end;
$$;

-- Anonymous users can read exactly one revision only when carrying its capability.
-- A token never permits head reads, other revisions, listing, or writes.
create function public.get_workspace_scene(p_id uuid, p_revision integer default null, p_share_token text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare snapshot public.scene_revisions; selected_revision integer; versions jsonb;
begin
  if p_share_token is not null then
    if length(p_share_token)<>64 or not exists(select 1 from public.scene_shares
      where scene_id=p_id and revision=p_revision and token_hash=encode(sha256(convert_to(p_share_token,'UTF8')),'hex')
        and revoked_at is null and expires_at>now()) then raise exception 'Shared link is invalid, expired, or revoked'; end if;
  elsif auth.uid() is null then raise exception 'Sign in to open this private scene';
  elsif not exists(select 1 from public.scenes where id=p_id and owner_id=auth.uid()) then raise exception 'Scene not found or access denied';
  end if;
  select coalesce(p_revision,revision) into selected_revision from public.scenes where id=p_id;
  select * into snapshot from public.scene_revisions where scene_id=p_id and revision=selected_revision;
  if not found then raise exception 'Scene revision not found'; end if;
  select coalesce(jsonb_agg(to_jsonb(v) || jsonb_build_object('asset',jsonb_build_object('asset_key',a.asset_key))), '[]'::jsonb)
    into versions from public.scene_revision_assets r join public.asset_file_versions v on v.id=r.version_id join public.assets a on a.id=v.asset_id
    where r.scene_id=p_id and r.revision=selected_revision;
  return jsonb_build_object('scene',jsonb_build_object('id',p_id,'owner_id',snapshot.owner_id,'name',snapshot.name,
    'revision',snapshot.revision,'document',snapshot.document,'updated_at',snapshot.created_at,
    'head_url','/?sceneId='||p_id::text,'revision_url','/?sceneId='||p_id::text||'&revision='||snapshot.revision::text), 'versions',versions);
end;
$$;
revoke all on function public.snapshot_scene_revision(), public.create_scene_share(uuid,integer,timestamptz),
  public.revoke_scene_shares(uuid), public.get_workspace_scene(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.create_scene_share(uuid,integer,timestamptz), public.revoke_scene_shares(uuid) to authenticated;
grant execute on function public.get_workspace_scene(uuid,integer,text) to anon,authenticated;
