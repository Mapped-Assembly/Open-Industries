-- Runs against local or hosted Postgres, creates no lasting users or records.
begin;
insert into auth.users(id) values
  ('a5100000-0000-4000-8000-000000000001'),
  ('a5100000-0000-4000-8000-000000000002');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a5100000-0000-4000-8000-000000000001', true);
insert into public.assets(asset_key, name, source_kind) values ('test-fixture', 'Ownership test', 'form');
insert into public.scenes(name, document) values ('Ownership test', '{"room":[6,5,3],"instances":[]}');
do $$ begin
  if (select count(*) from public.assets) <> 1 or (select count(*) from public.scenes) <> 1 then
    raise exception 'Owner cannot read own records';
  end if;
end $$;

select set_config('request.jwt.claim.sub', 'a5100000-0000-4000-8000-000000000002', true);
do $$ begin
  if exists(select 1 from public.assets) or exists(select 1 from public.scenes) then
    raise exception 'Cross-user read leaked records';
  end if;
  update public.assets set name = 'Not allowed';
  if found then raise exception 'Cross-user update succeeded'; end if;
  delete from public.scenes;
  if found then raise exception 'Cross-user delete succeeded'; end if;
  begin
    insert into public.assets(owner_id, asset_key, name, source_kind)
    values ('a5100000-0000-4000-8000-000000000001', 'forged', 'Forged', 'step');
    raise exception 'Owner impersonation succeeded';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a5100000-0000-4000-8000-000000000001', true);
update public.scenes set name = 'Updated by owner';
delete from public.assets;
do $$ begin
  if exists(select 1 from public.assets) then raise exception 'Owner delete failed'; end if;
  if not exists(select 1 from public.scenes where name = 'Updated by owner') then raise exception 'Owner update failed'; end if;
end $$;
set local role anon;
do $$ begin
  begin
    perform 1 from public.scenes;
    raise exception 'Unauthenticated read was permitted';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
