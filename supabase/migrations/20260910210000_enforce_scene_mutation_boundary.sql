-- Room documents and their binary references may only be mutated through the
-- validated security-definer RPCs. Authenticated clients retain read access.
revoke insert, update, delete on public.scenes from authenticated;
grant select on public.scenes to authenticated;
revoke insert, update, delete on public.scene_asset_files from authenticated;
grant select on public.scene_asset_files to authenticated;

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
  document := source_row.document;
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

revoke all on function public.duplicate_workspace_scene(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.duplicate_workspace_scene(uuid, uuid, text) to authenticated;
