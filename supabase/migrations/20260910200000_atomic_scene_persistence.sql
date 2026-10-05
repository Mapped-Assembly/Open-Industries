alter table public.scenes add column revision integer not null default 1 check (revision >= 1);
alter table public.scenes add column last_write_id uuid;

create function public.save_workspace_scene(p_id uuid, p_name text, p_document jsonb, p_expected_revision integer, p_write_id uuid)
returns public.scenes language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); result public.scenes; item jsonb; version_id uuid;
begin
  if uid is null then raise exception 'Sign in to save a cloud scene'; end if;
  if p_id is null or p_write_id is null or p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid scene write identity'; end if;
  if jsonb_typeof(p_document) is distinct from 'object' or p_document->>'format' is distinct from 'astra.scene'
    or p_document->>'version' is distinct from '1' or p_document->>'units' is distinct from 'm'
    or p_document->>'upAxis' is distinct from 'Y' or jsonb_typeof(p_document->'instances') is distinct from 'array'
    or p_document ? 'bundledAssets' then raise exception 'Expected an Mergence scene manifest without binary geometry'; end if;
  if jsonb_array_length(p_document->'instances') > 1000 then raise exception 'Scene exceeds 1000 instances'; end if;
  select * into result from public.scenes where id=p_id for update;
  if found then
    if result.owner_id <> uid then raise exception 'Scene not found'; end if;
    if result.last_write_id=p_write_id then return result; end if;
    if result.revision<>p_expected_revision then raise exception 'Scene changed on another device. Reopen it or save a new copy'; end if;
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

create function public.delete_workspace_scene(p_id uuid,p_expected_revision integer) returns void
language plpgsql security definer set search_path='' as $$
declare result public.scenes;
begin
  if auth.uid() is null then raise exception 'Sign in to delete a scene'; end if;
  select * into result from public.scenes where id=p_id and owner_id=auth.uid() for update;
  if not found then return; end if;
  if result.revision<>p_expected_revision then raise exception 'Scene changed on another device. Refresh before deleting'; end if;
  delete from public.scenes where id=p_id;
end;
$$;
revoke all on function public.save_workspace_scene(uuid,text,jsonb,integer,uuid), public.delete_workspace_scene(uuid,integer) from public,anon,authenticated;
grant execute on function public.save_workspace_scene(uuid,text,jsonb,integer,uuid), public.delete_workspace_scene(uuid,integer) to authenticated;
