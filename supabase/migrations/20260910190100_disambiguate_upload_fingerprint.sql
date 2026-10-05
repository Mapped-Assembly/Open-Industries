create or replace function public.prepare_asset_upload(p_asset_key text, p_name text, p_source_kind text, p_metadata jsonb, p_files jsonb)
returns public.asset_file_versions language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); item jsonb; aid uuid; result public.asset_file_versions;
  v_fingerprint text; filenames text[] := '{}'; total_bytes bigint := 0;
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
  select jsonb_agg(value order by value->>'name') into p_files from jsonb_array_elements(p_files);
  v_fingerprint := encode(sha256(convert_to(p_files::text, 'UTF8')), 'hex');
  insert into public.assets(owner_id, asset_key, name, source_kind, metadata)
    values (uid, p_asset_key, p_name, p_source_kind, p_metadata)
    on conflict(owner_id, asset_key) do update set name = excluded.name, metadata = excluded.metadata
    returning id into aid;
  insert into public.asset_file_versions(owner_id, asset_id, fingerprint, files)
    values (uid, aid, v_fingerprint, p_files)
    on conflict(asset_id, fingerprint) do update set updated_at = now()
    returning * into result;
  if result.state = 'deleting' then raise exception 'Finish removing the previous cloud copy before uploading it again'; end if;
  return result;
end;
$$;
