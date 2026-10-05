-- Extend the existing immutable store; no second history or geometry store.
alter table public.scene_revisions
  add column parent_revision integer,
  add column author_id uuid,
  add column author_source text not null default 'legacy',
  add column author_agent text,
  add column restored_from_revision integer,
  add column change_summary jsonb not null default '{}'::jsonb;

-- Only counts and known flags enter summaries, never arbitrary text/credentials.
create function public.scene_change_counts(p_before jsonb, p_after jsonb)
returns jsonb language sql immutable set search_path='' as $$
  with b as (select value->>'id' id,value from jsonb_array_elements(case when jsonb_typeof(p_before)='array' then p_before else '[]'::jsonb end)),
       a as (select value->>'id' id,value from jsonb_array_elements(case when jsonb_typeof(p_after)='array' then p_after else '[]'::jsonb end))
  select jsonb_build_object('added',count(*) filter(where b.id is null),
    'removed',count(*) filter(where a.id is null),
    'changed',count(*) filter(where a.id is not null and b.id is not null and a.value is distinct from b.value))
  from b full join a using(id);
$$;
create function public.scene_change_summary(p_before jsonb,p_after jsonb,p_old_name text,p_new_name text)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('baseline',p_before is null,
    'name_changed',p_before is not null and p_old_name is distinct from p_new_name,
    'room_changed',p_before is not null and p_before->'room' is distinct from p_after->'room',
    'instances',public.scene_change_counts(p_before->'instances',p_after->'instances'),
    'assets',public.scene_change_counts(p_before->'assets',p_after->'assets'),
    'animation_changed',p_before is not null and p_before->'animation' is distinct from p_after->'animation');
$$;

-- Backfill metadata only. Existing documents/timestamps stay byte-for-byte intact.
update public.scene_revisions r set
  parent_revision=(select p.revision from public.scene_revisions p where p.scene_id=r.scene_id and p.revision=r.revision-1),
  author_id=r.owner_id,
  author_source=case when r.document#>>'{authoring,via}' in ('mcp','workbench','cli') then r.document#>>'{authoring,via}' else 'legacy' end,
  author_agent=case when r.document#>>'{authoring,via}'='mcp' and r.document#>>'{authoring,agent}' ~ '^[A-Za-z0-9_. -]{1,80}$' then r.document#>>'{authoring,agent}' end,
  change_summary=public.scene_change_summary(
    (select p.document from public.scene_revisions p where p.scene_id=r.scene_id and p.revision=r.revision-1),r.document,
    (select p.name from public.scene_revisions p where p.scene_id=r.scene_id and p.revision=r.revision-1),r.name);

create or replace function public.snapshot_scene_revision() returns trigger
language plpgsql security definer set search_path='' as $$
declare previous_document jsonb; previous_name text; parent integer; source text; agent text; restored integer;
begin
  if tg_op='INSERT' then
    if exists(select 1 from public.scene_identities where id=new.id) then raise exception 'Scene ID was already used. Create a new scene ID'; end if;
    insert into public.scene_identities values(new.id);
  else
    parent:=old.revision; previous_document:=old.document; previous_name:=old.name;
  end if;
  source:=case when new.document#>>'{authoring,via}' in ('mcp','workbench','cli','duplicate','restore') then new.document#>>'{authoring,via}' else 'api' end;
  if source='mcp' and new.document#>>'{authoring,agent}' ~ '^[A-Za-z0-9_. -]{1,80}$' then agent:=new.document#>>'{authoring,agent}'; end if;
  if source='restore' then
    begin
      restored:=(new.document#>>'{authoring,restored_from_revision}')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Invalid restore source';
    end;
    if restored<1 or not exists(select 1 from public.scene_revisions r where r.scene_id=new.id and r.revision=restored
      and r.owner_id=new.owner_id and r.name=new.name and r.document-'authoring'=new.document-'authoring') then
      raise exception 'Restore source must match an existing owned snapshot';
    end if;
  end if;
  insert into public.scene_revisions(scene_id,revision,owner_id,name,document,created_at,parent_revision,author_id,author_source,author_agent,restored_from_revision,change_summary)
  values(new.id,new.revision,new.owner_id,new.name,new.document,new.updated_at,parent,auth.uid(),source,agent,restored,
    public.scene_change_summary(previous_document,new.document,previous_name,new.name));
  insert into public.scene_revision_assets(scene_id,revision,owner_id,version_id)
  select distinct new.id,new.revision,new.owner_id,(value->>'cloudVersionId')::uuid
  from jsonb_array_elements(new.document->'instances') where value ? 'cloudVersionId';
  return new;
end;
$$;

create function public.list_scene_revisions(p_id uuid,p_before_revision integer default null,p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare head integer; rows jsonb; oldest integer; next_before integer;
begin
  select revision into head from public.scenes where id=p_id and owner_id=auth.uid();
  if auth.uid() is null or not found then raise exception 'Scene not found or access denied'; end if;
  if p_limit is null or p_limit not between 1 and 50 or p_before_revision<1 then raise exception 'Invalid history page'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.revision desc),'[]'::jsonb),min(r.revision) into rows,oldest
    from (select revision,parent_revision,created_at,author_id,author_source,author_agent,restored_from_revision,change_summary
      from public.scene_revisions where scene_id=p_id and owner_id=auth.uid() and (p_before_revision is null or revision<p_before_revision)
      order by revision desc limit p_limit) r;
  if exists(select 1 from public.scene_revisions where scene_id=p_id and revision<oldest) then next_before:=oldest; end if;
  return jsonb_build_object('scene_id',p_id,'head_revision',head,'revisions',rows,'next_before',next_before);
end;
$$;

-- Preserve the atomic write/reference boundary and return machine-readable conflicts.
create or replace function public.save_workspace_scene(p_id uuid, p_name text, p_document jsonb, p_expected_revision integer, p_write_id uuid)
returns public.scenes language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); result public.scenes; item jsonb; version_id uuid;
begin
  if uid is null then raise exception 'Sign in to save a cloud scene'; end if;
  if p_id is null or p_write_id is null or p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid scene write identity'; end if;
  if jsonb_typeof(p_document) is distinct from 'object' or p_document->>'format' is distinct from 'astra.scene'
    or p_document->>'version' is distinct from '1' or p_document->>'units' is distinct from 'm'
    or p_document->>'upAxis' is distinct from 'Y' or jsonb_typeof(p_document->'instances') is distinct from 'array'
    or p_document ? 'bundledAssets' or p_document ? 'bundledVersions' then raise exception 'Expected a Mergence scene manifest without binary geometry'; end if;
  if jsonb_array_length(p_document->'instances') > 1000 then raise exception 'Scene exceeds 1000 instances'; end if;
  select * into result from public.scenes where id=p_id for update;
  if found then
    if result.owner_id <> uid then raise exception 'Scene not found'; end if;
    if result.last_write_id=p_write_id then
      if result.name is distinct from p_name or result.document is distinct from p_document then raise exception 'Request ID already used for a different scene write'; end if;
      return result;
    end if;
    if result.revision<>p_expected_revision then raise exception using errcode='40001',message='Scene changed on another device. Reopen it or save a new copy',detail=jsonb_build_object('current_revision',result.revision)::text; end if;
    update public.scenes set name=p_name, document=p_document, revision=revision+1,last_write_id=p_write_id where id=p_id returning * into result;
  else
    if p_expected_revision<>0 then raise exception 'Scene was deleted. Save a new copy'; end if;
    insert into public.scenes(id,owner_id,name,document,last_write_id) values(p_id,uid,p_name,p_document,p_write_id) returning * into result;
  end if;
  delete from public.scene_asset_files where scene_id=p_id;
  for item in select value from jsonb_array_elements(p_document->'instances') where value ? 'cloudVersionId' order by value->>'cloudVersionId' loop
    version_id := (item->>'cloudVersionId')::uuid;
    if not exists(select 1 from public.asset_file_versions v join public.assets a on a.id=v.asset_id
      where v.id=version_id and v.owner_id=uid and v.state='ready' and a.asset_key=item->>'assetId') then
      raise exception 'A cloud asset is missing, belongs to another user, or is not ready';
    end if;
    insert into public.scene_asset_files(scene_id,version_id,owner_id) values(p_id,version_id,uid) on conflict do nothing;
  end loop;
  return result;
end;
$$;

create or replace function public.delete_workspace_scene(p_id uuid,p_expected_revision integer) returns void
language plpgsql security definer set search_path='' as $$
declare result public.scenes;
begin
  if auth.uid() is null then raise exception 'Sign in to delete a scene'; end if;
  select * into result from public.scenes where id=p_id and owner_id=auth.uid() for update;
  if not found then return; end if;
  if result.revision<>p_expected_revision then raise exception using errcode='40001',message='Scene changed on another device. Refresh before deleting',detail=jsonb_build_object('current_revision',result.revision)::text; end if;
  delete from public.scenes where id=p_id;
end;
$$;

create function public.restore_workspace_scene(p_id uuid,p_revision integer,p_expected_revision integer,p_write_id uuid)
returns public.scenes language plpgsql security definer set search_path='' as $$
declare head public.scenes; source public.scene_revisions; document jsonb; result public.scenes;
begin
  if auth.uid() is null then raise exception 'Sign in to restore a scene'; end if;
  if p_revision is null or p_revision<1 or p_expected_revision is null or p_expected_revision<1 or p_write_id is null then raise exception 'Invalid restore request'; end if;
  select * into head from public.scenes where id=p_id and owner_id=auth.uid() for update;
  if not found then raise exception 'Scene not found or access denied'; end if;
  select * into source from public.scene_revisions where scene_id=p_id and revision=p_revision and owner_id=auth.uid();
  if not found then raise exception 'Scene revision not found'; end if;
  document:=jsonb_set(source.document,'{authoring}',jsonb_build_object('via','restore','restored_from_revision',p_revision));
  -- save_workspace_scene performs retry identity, locked base checks, and all
  -- reference validation. A failed restore rolls back the new snapshot as well.
  select * into result from public.save_workspace_scene(p_id,source.name,document,p_expected_revision,p_write_id);
  return result;
end;
$$;

create or replace function public.duplicate_workspace_scene(p_source_id uuid, p_new_id uuid, p_name text)
returns public.scenes language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); source_row public.scenes; result public.scenes;
  document jsonb; instances jsonb := '[]'::jsonb; tracks jsonb := '[]'::jsonb;
  item jsonb; track jsonb; old_id text; new_id text; mapping jsonb := '{}'::jsonb;
begin
  if uid is null then raise exception 'Sign in to duplicate a scene'; end if;
  if p_source_id is null or p_new_id is null or p_source_id = p_new_id or nullif(btrim(p_name), '') is null then
    raise exception 'Invalid scene duplication request';
  end if;
  select * into source_row from public.scenes where id = p_source_id and owner_id = uid for share;
  if not found then raise exception 'Source scene not found'; end if;
  if exists(select 1 from public.scenes where id = p_new_id) then raise exception 'Destination scene already exists'; end if;
  document := jsonb_set(source_row.document,'{authoring}',jsonb_build_object('via','duplicate','source_scene_id',p_source_id,'source_revision',source_row.revision));
  if jsonb_typeof(document->'instances') is distinct from 'array' then raise exception 'Source scene document has no instance array'; end if;
  for item in select value from jsonb_array_elements(document->'instances') loop
    old_id := item->>'id';
    if old_id is null then raise exception 'Source scene has an invalid instance ID'; end if;
    new_id := gen_random_uuid()::text;
    mapping := mapping || jsonb_build_object(old_id, new_id);
    instances := instances || jsonb_build_array(jsonb_set(item, '{id}', to_jsonb(new_id)));
  end loop;
  document := jsonb_set(document, '{instances}', instances);
  if jsonb_typeof(document->'animation') = 'object' and jsonb_typeof(document->'animation'->'tracks') = 'array' then
    for track in select value from jsonb_array_elements(document->'animation'->'tracks') loop
      old_id := track->>'instanceId';
      new_id := mapping->>old_id;
      if new_id is null then raise exception 'Source animation references a missing instance'; end if;
      track := jsonb_set(track, '{instanceId}', to_jsonb(new_id));
      track := jsonb_set(track, '{id}', to_jsonb(new_id || ':' || coalesce(track->>'partId', 'instance')));
      tracks := tracks || jsonb_build_array(track);
    end loop;
    document := jsonb_set(document, '{animation,tracks}', tracks);
  end if;
  select * into result from public.save_workspace_scene(p_new_id, btrim(p_name), document, 0, gen_random_uuid());
  return result;
end;
$$;


revoke all on function public.scene_change_counts(jsonb,jsonb),public.scene_change_summary(jsonb,jsonb,text,text),
  public.list_scene_revisions(uuid,integer,integer),public.restore_workspace_scene(uuid,integer,integer,uuid) from public,anon,authenticated;
grant execute on function public.list_scene_revisions(uuid,integer,integer),public.restore_workspace_scene(uuid,integer,integer,uuid) to authenticated;
