-- Optional feature #13: immutable file versions, private objects, and retryable cleanup.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('astra-assets', 'astra-assets', false, 26214400,
  array['application/json', 'image/gif', 'application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.assets add constraint assets_id_owner_unique unique (id, owner_id);
alter table public.scenes add constraint scenes_id_owner_unique unique (id, owner_id);

create table public.asset_file_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  asset_id uuid not null,
  fingerprint text not null,
  state text not null default 'pending' check (state in ('pending', 'ready', 'deleting')),
  files jsonb not null check (jsonb_typeof(files) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(asset_id, owner_id) references public.assets(id, owner_id) on delete restrict,
  unique(asset_id, fingerprint),
  unique(id, owner_id)
);
create index asset_file_versions_owner_idx on public.asset_file_versions(owner_id, created_at desc);
alter table public.asset_file_versions enable row level security;
revoke all on public.asset_file_versions from anon, authenticated;
grant select on public.asset_file_versions to authenticated;
create policy asset_file_versions_owner_read on public.asset_file_versions for select to authenticated
using ((select auth.uid()) = owner_id);

-- #27 must register these references when saving a cloud scene. Removing a scene
-- drops its references, not the underlying asset/version or any binary objects.
create table public.scene_asset_files (
  scene_id uuid not null,
  version_id uuid not null,
  owner_id uuid not null default auth.uid(),
  primary key(scene_id, version_id),
  foreign key(scene_id, owner_id) references public.scenes(id, owner_id) on delete cascade,
  foreign key(version_id, owner_id) references public.asset_file_versions(id, owner_id) on delete restrict
);
create index scene_asset_files_version_idx on public.scene_asset_files(version_id);
alter table public.scene_asset_files enable row level security;
revoke all on public.scene_asset_files from anon, authenticated;
grant select, insert, delete on public.scene_asset_files to authenticated;
create policy scene_asset_files_owner_access on public.scene_asset_files for all to authenticated
using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);

create function public.check_scene_file_ready() returns trigger
language plpgsql security definer set search_path = '' as $$
declare current_state text;
begin
  -- Lock against concurrent deletion while creating a shared scene reference.
  select state into current_state from public.asset_file_versions
    where id = new.version_id and owner_id = new.owner_id for update;
  if current_state is distinct from 'ready' then
    raise exception 'Only ready file versions can be referenced by a scene';
  end if;
  return new;
end;
$$;
create trigger scene_file_ready before insert on public.scene_asset_files
for each row execute function public.check_scene_file_ready();

create function public.prepare_asset_upload(p_asset_key text, p_name text, p_source_kind text, p_metadata jsonb, p_files jsonb)
returns public.asset_file_versions language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); item jsonb; aid uuid; result public.asset_file_versions;
  fingerprint text; filenames text[] := '{}'; total_bytes bigint := 0;
begin
  if uid is null then raise exception 'Sign in to use cloud storage'; end if;
  if jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files) not between 1 and 3 then
    raise exception 'Expected between one and three file descriptors';
  end if;
  for item in select value from jsonb_array_elements(p_files) loop
    if jsonb_typeof(item) is distinct from 'object'
       or (item->>'name') is null or (item->>'name') not in ('asset.json','preview.gif','source.step')
       or (item->>'name') = any(filenames)
       or (item->>'sha256') is null or (item->>'sha256') !~ '^[a-f0-9]{64}$'
       or (item->>'size') is null or (item->>'size') !~ '^[0-9]{1,8}$' then
      raise exception 'Invalid file descriptor';
    end if;
    if (item->>'size')::bigint not between 1 and 26214400 then raise exception 'File exceeds the 25 MiB limit'; end if;
    if (item->>'mime') is distinct from (case item->>'name'
       when 'asset.json' then 'application/json' when 'preview.gif' then 'image/gif' else 'application/octet-stream' end) then
      raise exception 'Invalid file content type';
    end if;
    filenames := array_append(filenames, item->>'name');
    total_bytes := total_bytes + (item->>'size')::bigint;
  end loop;
  if not ('asset.json' = any(filenames)) then raise exception 'Geometry bundle is required'; end if;
  if total_bytes > 52428800 then raise exception 'Upload bundle exceeds 50 MiB'; end if;
  -- Canonical ordering keeps retries idempotent even if descriptor order changes.
  select jsonb_agg(value order by value->>'name') into p_files from jsonb_array_elements(p_files);
  fingerprint := encode(sha256(convert_to(p_files::text, 'UTF8')), 'hex');
  insert into public.assets(owner_id, asset_key, name, source_kind, metadata)
    values (uid, p_asset_key, p_name, p_source_kind, p_metadata)
    on conflict(owner_id, asset_key) do update set name = excluded.name, metadata = excluded.metadata
    returning id into aid;
  insert into public.asset_file_versions(owner_id, asset_id, fingerprint, files)
    values (uid, aid, fingerprint, p_files)
    on conflict(asset_id, fingerprint) do update set updated_at = now()
    returning * into result;
  if result.state = 'deleting' then raise exception 'Finish removing the previous cloud copy before uploading it again'; end if;
  return result;
end;
$$;

create function public.finish_asset_upload(p_id uuid) returns public.asset_file_versions
language plpgsql security definer set search_path = '' as $$
declare result public.asset_file_versions; item jsonb;
begin
  select * into result from public.asset_file_versions where id = p_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Cloud copy not found'; end if;
  if result.state = 'deleting' then raise exception 'Cloud copy is being removed'; end if;
  for item in select value from jsonb_array_elements(result.files) loop
    if not exists(select 1 from storage.objects where bucket_id = 'astra-assets'
      and name = result.owner_id::text || '/' || result.id::text || '/' || (item->>'name')
      and (metadata->>'size')::bigint = (item->>'size')::bigint
      and metadata->>'mimetype' = item->>'mime') then
      raise exception 'Upload is incomplete; retry the upload or remove its pending cloud copy';
    end if;
  end loop;
  update public.asset_file_versions set state = 'ready', updated_at = now() where id = p_id returning * into result;
  return result;
end;
$$;

create function public.begin_asset_file_delete(p_id uuid) returns public.asset_file_versions
language plpgsql security definer set search_path = '' as $$
declare result public.asset_file_versions;
begin
  select * into result from public.asset_file_versions where id = p_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Cloud copy not found'; end if;
  if exists(select 1 from public.scene_asset_files where version_id = p_id) then
    raise exception 'This cloud copy is referenced by a saved scene. Remove the scene reference first';
  end if;
  update public.asset_file_versions set state = 'deleting', updated_at = now() where id = p_id returning * into result;
  return result;
end;
$$;

create function public.finish_asset_file_delete(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare result public.asset_file_versions;
begin
  select * into result from public.asset_file_versions where id = p_id and owner_id = auth.uid() for update;
  if not found then return; end if;
  if result.state <> 'deleting' then raise exception 'Begin deletion before removing metadata'; end if;
  if exists(select 1 from storage.objects where bucket_id = 'astra-assets'
      and name like result.owner_id::text || '/' || result.id::text || '/%') then
    raise exception 'Files are still present; retry cloud copy removal';
  end if;
  delete from public.asset_file_versions where id = p_id;
end;
$$;

-- Every object path is backed by a durable upload intent. No arbitrary paths,
-- overwrites of ready assets, or deletion of referenced/active files are allowed.
create function public.can_access_asset_object(object_name text, action text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.asset_file_versions v, jsonb_array_elements(v.files) f
    where v.owner_id = auth.uid()
      and object_name = v.owner_id::text || '/' || v.id::text || '/' || (f->>'name')
      and case action when 'read' then true when 'write' then v.state = 'pending'
        when 'delete' then v.state = 'deleting' else false end
  );
$$;
create policy astra_object_read on storage.objects for select to authenticated
using (bucket_id = 'astra-assets' and public.can_access_asset_object(name, 'read'));
create policy astra_object_insert on storage.objects for insert to authenticated
with check (bucket_id = 'astra-assets' and public.can_access_asset_object(name, 'write'));
create policy astra_object_delete on storage.objects for delete to authenticated
using (bucket_id = 'astra-assets' and public.can_access_asset_object(name, 'delete'));

revoke all on function public.prepare_asset_upload(text,text,text,jsonb,jsonb),
  public.finish_asset_upload(uuid), public.begin_asset_file_delete(uuid), public.finish_asset_file_delete(uuid),
  public.can_access_asset_object(text,text), public.check_scene_file_ready() from public, anon, authenticated;
grant execute on function public.prepare_asset_upload(text,text,text,jsonb,jsonb),
  public.finish_asset_upload(uuid), public.begin_asset_file_delete(uuid), public.finish_asset_file_delete(uuid),
  public.can_access_asset_object(text,text) to authenticated;
