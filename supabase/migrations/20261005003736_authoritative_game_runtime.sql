-- Authoritative city-dump processing slice. No game table is a Data API resource.
-- Only dispatch crosses the authenticated boundary; internal functions and the
-- scheduler cannot be called by anon, authenticated, or service_role.
create schema game_private;
revoke all on schema game_private from public, anon, authenticated, service_role;
alter default privileges in schema game_private revoke execute on functions from public;

create table game_private.runtime (
  singleton boolean primary key default true check(singleton),
  last_tick_ms bigint
);
insert into game_private.runtime values(true, null);

create table game_private.matches (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users(id),
  status text not null default 'waiting' check(status in ('waiting','active','abandoned')),
  revision integer not null default 1 check(revision > 0),
  invite_code uuid default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  invite_expires_at timestamptz not null default clock_timestamp() + interval '1 hour',
  last_advanced_ms bigint not null default 0
);
create index game_matches_host on game_private.matches(host_id, created_at);
create table game_private.players (
  match_id uuid not null references game_private.matches(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  slot smallint not null check(slot in (1,2)),
  primary key(match_id, owner_id),
  unique(match_id, slot)
);
create index game_players_owner on game_private.players(owner_id, match_id);
create table game_private.deposits (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null,
  owner_id uuid not null,
  copper_g integer not null check(copper_g between 5000 and 7040),
  hdpe_g integer not null check(hdpe_g > 0),
  dirt_g integer not null default 500 check(dirt_g = 500),
  collected boolean not null default false,
  unique(match_id, owner_id),
  foreign key(match_id, owner_id) references game_private.players(match_id, owner_id),
  check(copper_g + hdpe_g + dirt_g = 10000)
);
create table game_private.observations (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid not null references game_private.deposits(id),
  owner_id uuid not null references auth.users(id),
  observed_at timestamptz not null default clock_timestamp(),
  unique(deposit_id, owner_id)
);
create table game_private.machines (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null,
  owner_id uuid not null,
  status text not null default 'ready' check(status in ('ready','destroyed')),
  power_w integer not null default 500 check(power_w = 500),
  energy_mj bigint not null default 20000000 check(energy_mj between 0 and 20000000),
  dissipated_mj bigint not null default 0 check(dissipated_mj between 0 and 20000000),
  unique(match_id, owner_id),
  foreign key(match_id, owner_id) references game_private.players(match_id, owner_id)
);
create table game_private.batches (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null,
  owner_id uuid not null,
  form text not null check(form in ('cable','wire','flakes','residue')),
  state text not null default 'available' check(state in ('available','reserved','consumed')),
  copper_g integer not null check(copper_g >= 0),
  hdpe_g integer not null check(hdpe_g >= 0),
  dirt_g integer not null check(dirt_g >= 0),
  observation_id uuid references game_private.observations(id),
  source_job_id uuid,
  output_role text check(output_role in ('conductor','insulation','residue')),
  unique(source_job_id, output_role),
  foreign key(match_id, owner_id) references game_private.players(match_id, owner_id),
  check(copper_g + hdpe_g + dirt_g > 0),
  check((form = 'cable' and observation_id is not null and source_job_id is null and output_role is null)
     or (form <> 'cable' and observation_id is null and source_job_id is not null and output_role is not null))
);
create index game_batches_owner on game_private.batches(match_id, owner_id);
create table game_private.jobs (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null,
  owner_id uuid not null,
  machine_id uuid not null references game_private.machines(id),
  input_batch_id uuid not null references game_private.batches(id),
  recipe_version text not null default 'dump-v1',
  state text not null default 'running' check(state in ('running','paused','completed','cancelled')),
  pause_reason text check(pause_reason in ('requested','power')),
  cancellation_reason text check(cancellation_reason in ('requested','machine_destroyed','match_abandoned')),
  duration_ms integer not null check(duration_ms > 0),
  work_ms integer not null default 0 check(work_ms >= 0 and work_ms <= duration_ms),
  energy_mj bigint not null default 0 check(energy_mj >= 0 and energy_mj = work_ms::bigint * 500),
  last_tick_ms bigint not null,
  plan jsonb not null,
  foreign key(match_id, owner_id) references game_private.players(match_id, owner_id)
);
alter table game_private.batches add foreign key(source_job_id) references game_private.jobs(id);
create unique index game_one_machine_job on game_private.jobs(machine_id) where state in ('running','paused');
create unique index game_one_batch_job on game_private.jobs(input_batch_id) where state in ('running','paused');
create index game_jobs_due on game_private.jobs(match_id) where state = 'running';
create index game_jobs_owner on game_private.jobs(match_id, owner_id);
create table game_private.commands (
  owner_id uuid not null references auth.users(id),
  command_id uuid not null,
  match_id uuid not null references game_private.matches(id),
  operation text not null,
  request jsonb not null,
  result jsonb not null,
  primary key(owner_id, command_id)
);
create index game_commands_match_owner on game_private.commands(match_id, owner_id);

-- Deny by default even if this schema is accidentally exposed later.
alter table game_private.runtime enable row level security;
alter table game_private.matches enable row level security;
alter table game_private.players enable row level security;
alter table game_private.deposits enable row level security;
alter table game_private.observations enable row level security;
alter table game_private.machines enable row level security;
alter table game_private.batches enable row level security;
alter table game_private.jobs enable row level security;
alter table game_private.commands enable row level security;
revoke all on all tables in schema game_private from public, anon, authenticated, service_role;

create function game_private.now_ms() returns bigint language sql volatile set search_path='' as $$
  select floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;
create function game_private.fail(p_code text) returns void language plpgsql set search_path='' as $$
begin raise exception using errcode='P0001', message='OI_GAME:' || p_code; end;
$$;
create function game_private.is_uuid(p_value jsonb) returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='string' and (p_value #>> '{}') ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',false);
$$;
-- Pure integer partition from tower-defense's strip-cable balance fixture.
-- It assigns no conductivity, alloy grade, or other unmeasured property.
create function game_private.plan_cable(p_copper integer,p_hdpe integer,p_dirt integer)
returns jsonb language plpgsql immutable set search_path='' as $$
declare conductor integer; insulation integer; mass integer;
begin
  if p_copper is null or p_hdpe is null or p_dirt is null or p_copper < 0 or p_hdpe < 0 or p_dirt < 0
    or p_copper::bigint+p_hdpe+p_dirt not between 1 and 10000
    or p_copper::bigint*2 < p_copper::bigint+p_hdpe+p_dirt then
    perform game_private.fail('INVALID_FEEDSTOCK');
  end if;
  mass:=p_copper+p_hdpe+p_dirt;
  conductor:=p_copper*19/20; insulation:=p_hdpe*6/7;
  return jsonb_build_object('duration_ms',mass*2,'energy_mj',mass::bigint*1000,
    'outputs',jsonb_build_array(
      jsonb_build_object('role','conductor','form','wire','copper_g',conductor,'hdpe_g',0,'dirt_g',0),
      jsonb_build_object('role','insulation','form','flakes','copper_g',0,'hdpe_g',insulation,'dirt_g',0),
      jsonb_build_object('role','residue','form','residue','copper_g',p_copper-conductor,'hdpe_g',p_hdpe-insulation,'dirt_g',p_dirt)));
end;
$$;
create function game_private.seed_player(p_match uuid,p_owner uuid,p_slot smallint)
returns void language plpgsql set search_path='' as $$
declare copper integer:=5000+get_byte(uuid_send(gen_random_uuid()),0)*8;
begin
  insert into game_private.players values(p_match,p_owner,p_slot);
  insert into game_private.deposits(match_id,owner_id,copper_g,hdpe_g) values(p_match,p_owner,copper,9500-copper);
  insert into game_private.machines(match_id,owner_id) values(p_match,p_owner);
end;
$$;
create function game_private.cancel_job(p_job uuid,p_reason text)
returns void language plpgsql set search_path='' as $$
declare j game_private.jobs;
begin
  select * into j from game_private.jobs where id=p_job and state in ('running','paused');
  if not found then return; end if;
  update game_private.batches set state='available' where id=j.input_batch_id;
  update game_private.jobs set state='cancelled',pause_reason=null,cancellation_reason=p_reason where id=j.id;
end;
$$;
-- Every entry point takes the match lock first, including the scheduler. All
-- progress, battery use, input consumption and output inserts share one commit.
create function game_private.advance(p_match uuid) returns void
language plpgsql set search_path='' as $$
declare m game_private.matches; j game_private.jobs; machine game_private.machines;
  clock_ms bigint; delta integer; output jsonb; changed boolean:=false;
begin
  select * into m from game_private.matches where id=p_match for update;
  if not found then return; end if;
  clock_ms:=greatest(game_private.now_ms(),m.last_advanced_ms);
  if m.status='waiting' and m.invite_expires_at <= clock_timestamp() then
    update game_private.matches set status='abandoned',invite_code=null,revision=revision+1 where id=p_match;
    return;
  end if;
  if m.status<>'active' then return; end if;
  for j in select * from game_private.jobs where match_id=p_match and state='running' order by id loop
    select * into strict machine from game_private.machines where id=j.machine_id;
    delta:=least(j.duration_ms-j.work_ms,greatest(0,clock_ms-j.last_tick_ms),machine.energy_mj/machine.power_w)::integer;
    if delta > 0 then
      update game_private.machines set energy_mj=energy_mj-delta::bigint*machine.power_w where id=machine.id;
      j.work_ms:=j.work_ms+delta; j.energy_mj:=j.energy_mj+delta::bigint*machine.power_w;
      changed:=true;
    end if;
    if j.work_ms=j.duration_ms then
      j.state:='completed'; changed:=true;
      update game_private.batches set state='consumed' where id=j.input_batch_id and state='reserved';
      if not found then perform game_private.fail('INVARIANT_FAILED'); end if;
      for output in select value from jsonb_array_elements(j.plan->'outputs') loop
        if (output->>'copper_g')::integer+(output->>'hdpe_g')::integer+(output->>'dirt_g')::integer > 0 then
          insert into game_private.batches(match_id,owner_id,form,copper_g,hdpe_g,dirt_g,source_job_id,output_role)
          values(j.match_id,j.owner_id,output->>'form',(output->>'copper_g')::integer,
            (output->>'hdpe_g')::integer,(output->>'dirt_g')::integer,j.id,output->>'role');
        end if;
      end loop;
    elsif machine.energy_mj-delta::bigint*machine.power_w < machine.power_w then
      j.state:='paused'; j.pause_reason:='power'; changed:=true;
    end if;
    update game_private.jobs set work_ms=j.work_ms,energy_mj=j.energy_mj,state=j.state,
      pause_reason=j.pause_reason,last_tick_ms=greatest(last_tick_ms,clock_ms) where id=j.id;
  end loop;
  update game_private.matches set last_advanced_ms=clock_ms,revision=revision+case when changed then 1 else 0 end where id=p_match;
end;
$$;
create function game_private.snapshot(p_match uuid,p_owner uuid) returns jsonb
language sql set search_path='' as $$
  select jsonb_build_object('match_id',m.id,'revision',m.revision,'status',m.status,
    'server_time_ms',greatest(game_private.now_ms(),m.last_advanced_ms),
    'scheduler_healthy',coalesce((select last_tick_ms >= game_private.now_ms()-15000 from game_private.runtime),false),
    'players',(select jsonb_agg(jsonb_build_object('slot',p.slot,'you',p.owner_id=p_owner) order by p.slot)
      from game_private.players p where p.match_id=m.id),
    'deposits',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'collected',d.collected,'observation',
      case when o.id is null then null else jsonb_build_object('id',o.id,'sensor','cable-assay-v1',
        'copper_g',d.copper_g,'hdpe_g',d.hdpe_g,'dirt_g',d.dirt_g) end) order by d.id)
      from game_private.deposits d left join game_private.observations o on o.deposit_id=d.id and o.owner_id=p_owner
      where d.match_id=m.id and d.owner_id=p_owner),'[]'::jsonb),
    'machines',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'kind','cable-separator','status',x.status,
      'power_w',x.power_w,'energy_mj',x.energy_mj,'dissipated_mj',x.dissipated_mj) order by x.id)
      from game_private.machines x where x.match_id=m.id and x.owner_id=p_owner),'[]'::jsonb),
    'batches',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'form',b.form,'state',b.state,
      'copper_g',b.copper_g,'hdpe_g',b.hdpe_g,'dirt_g',b.dirt_g,'observation_id',b.observation_id,
      'source_job_id',b.source_job_id,'output_role',b.output_role,
      'grade',case when b.form='cable' then 'assayed-feedstock' else 'recovered-ungraded' end) order by b.id)
      from game_private.batches b where b.match_id=m.id and b.owner_id=p_owner),'[]'::jsonb),
    'jobs',coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'machine_id',j.machine_id,'input_batch_id',j.input_batch_id,
      'recipe','strip-cable','recipe_version',j.recipe_version,'state',j.state,'pause_reason',j.pause_reason,
      'cancellation_reason',j.cancellation_reason,'duration_ms',j.duration_ms,'work_ms',j.work_ms,'energy_mj',j.energy_mj) order by j.id)
      from game_private.jobs j where j.match_id=m.id and j.owner_id=p_owner),'[]'::jsonb))
  from game_private.matches m where m.id=p_match
    and exists(select 1 from game_private.players p where p.match_id=m.id and p.owner_id=p_owner);
$$;

-- Invoker-only scheduler, granted to no API role. pg_cron runs this as the
-- migration/deployment owner. SKIP LOCKED bounds contention with player commands.
create function game_private.tick() returns integer language plpgsql set search_path='' as $$
declare m record; processed integer:=0;
begin
  update game_private.runtime set last_tick_ms=game_private.now_ms();
  for m in select id from game_private.matches x where
    (x.status='active' and exists(select 1 from game_private.jobs j where j.match_id=x.id and j.state='running'))
    or (x.status='waiting' and x.invite_expires_at <= clock_timestamp())
    order by last_advanced_ms,id limit 100 for update skip locked
  loop
    perform game_private.advance(m.id); processed:=processed+1;
  end loop;
  return processed;
end;
$$;

-- SECURITY DEFINER is necessary only here: callers cannot modify inventory or
-- inspect private tables themselves. Identity always comes from verified JWT
-- claims (auth.uid), never from request fields. No dynamic SQL or external I/O.
create function game_private.dispatch(p_operation text,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); cmd uuid; mid uuid; args text[]; key text;
  m game_private.matches; cached game_private.commands; d game_private.deposits;
  b game_private.batches; machine game_private.machines; j game_private.jobs;
  observation uuid; plan jsonb; result jsonb; invite uuid;
begin
  if uid is null then perform game_private.fail('AUTH_REQUIRED'); end if;
  if p_operation is null or p_operation not in ('create','join','read','inspect_deposit','collect_deposit',
    'start_processing','pause_job','resume_job','cancel_job','dismantle_machine','abandon_match')
    or jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>8192
    or p_request->'version' is distinct from '1'::jsonb then perform game_private.fail('INVALID_REQUEST'); end if;
  args:=case p_operation when 'create' then array['version','command_id']
    when 'join' then array['version','command_id','match_id','invite_code']
    when 'read' then array['version','match_id']
    else array['version','command_id','match_id','expected_revision'] ||
      case when p_operation in ('inspect_deposit','collect_deposit') then array['deposit_id']
      when p_operation='start_processing' then array['batch_id','machine_id']
      when p_operation in ('pause_job','resume_job','cancel_job') then array['job_id']
      when p_operation='dismantle_machine' then array['machine_id'] else array[]::text[] end end;
  if not (p_request ?& args) or exists(select 1 from jsonb_object_keys(p_request) k where k <> all(args)) then
    perform game_private.fail('INVALID_REQUEST');
  end if;
  foreach key in array args loop
    if key not in ('version','expected_revision') and not game_private.is_uuid(p_request->key) then
      perform game_private.fail('INVALID_REQUEST');
    end if;
  end loop;
  if p_request ? 'expected_revision' and
    (jsonb_typeof(p_request->'expected_revision')<>'number' or p_request->>'expected_revision' !~ '^[1-9][0-9]{0,8}$') then
    perform game_private.fail('INVALID_REQUEST');
  end if;
  cmd:=(p_request->>'command_id')::uuid; mid:=(p_request->>'match_id')::uuid;
  if p_operation<>'read' then
    -- Serializes identical IDs even before a match exists. Collisions only wait.
    perform pg_advisory_xact_lock(hashtextextended(uid::text || cmd::text,0));
    select * into cached from game_private.commands where owner_id=uid and command_id=cmd;
    if found then
      if cached.operation<>p_operation or cached.request<>p_request then perform game_private.fail('COMMAND_ID_REUSED'); end if;
      return cached.result;
    end if;
  end if;
  if p_operation='create' then
    -- Serialize account creation quotas across distinct command IDs.
    perform pg_advisory_xact_lock(hashtextextended('game-account:' || uid::text,0));
    if (select count(*) from game_private.matches where host_id=uid and created_at>clock_timestamp()-interval '1 day') >= 20
      or (select count(*) from game_private.players p join game_private.matches x on x.id=p.match_id
        where p.owner_id=uid and (x.status='active' or (x.status='waiting' and x.invite_expires_at>clock_timestamp()))) >= 3 then
      perform game_private.fail('LIMIT_REACHED');
    end if;
  else
    select * into m from game_private.matches where id=mid and
      (p_operation='join' or exists(select 1 from game_private.players where match_id=mid and owner_id=uid)) for update;
    if not found then perform game_private.fail('NOT_AVAILABLE'); end if;
    if p_operation='join' then
      if m.status<>'waiting' or m.host_id=uid or m.invite_code is distinct from (p_request->>'invite_code')::uuid
        or m.invite_expires_at<=clock_timestamp() then perform game_private.fail('NOT_AVAILABLE'); end if;
      -- Acquire account quota lock after the match lock; create never takes an
      -- existing match lock, so concurrent joins and creates cannot form a cycle.
      perform pg_advisory_xact_lock(hashtextextended('game-account:' || uid::text,0));
      if (select count(*) from game_private.players p join game_private.matches x on x.id=p.match_id
        where p.owner_id=uid and (x.status='active' or (x.status='waiting' and x.invite_expires_at>clock_timestamp()))) >= 3 then
        perform game_private.fail('LIMIT_REACHED');
      end if;
    elsif p_operation<>'read' and m.revision<>(p_request->>'expected_revision')::integer then
      perform game_private.fail('CONFLICT');
    end if;
    perform game_private.advance(mid);
    if p_operation='read' then
      return jsonb_build_object('version',1,'balance_version','dump-v1','snapshot',game_private.snapshot(mid,uid));
    end if;
    select * into m from game_private.matches where id=mid;
    if p_operation not in ('join','abandon_match') and m.status<>'active' then perform game_private.fail('MATCH_INACTIVE'); end if;
    if p_operation='abandon_match' and m.status='abandoned' then perform game_private.fail('MATCH_INACTIVE'); end if;
    if p_operation<>'abandon_match' and (select count(*) from game_private.commands where match_id=mid and owner_id=uid)>=256 then
      perform game_private.fail('LIMIT_REACHED');
    end if;
  end if;
  if p_operation not in ('pause_job','cancel_job','dismantle_machine','abandon_match')
    and not coalesce((select last_tick_ms>=game_private.now_ms()-15000 from game_private.runtime),false) then
    perform game_private.fail('SCHEDULER_UNAVAILABLE');
  end if;
  case p_operation
    when 'create' then
      insert into game_private.matches(host_id) values(uid) returning id,invite_code into mid,invite;
      perform game_private.seed_player(mid,uid,1::smallint);
    when 'join' then
      perform game_private.seed_player(mid,uid,2::smallint);
      update game_private.matches set status='active',invite_code=null where id=mid;
    when 'inspect_deposit','collect_deposit' then
      select * into d from game_private.deposits where id=(p_request->>'deposit_id')::uuid and match_id=mid and owner_id=uid;
      if not found then perform game_private.fail('NOT_AVAILABLE'); end if;
      if d.collected then perform game_private.fail('DEPOSIT_EMPTY'); end if;
      select id into observation from game_private.observations where deposit_id=d.id and owner_id=uid;
      if p_operation='inspect_deposit' then
        if observation is null then
          insert into game_private.observations(deposit_id,owner_id) values(d.id,uid) returning id into observation;
        end if;
      else
        if observation is null then perform game_private.fail('INSPECTION_REQUIRED'); end if;
        update game_private.deposits set collected=true where id=d.id;
        insert into game_private.batches(match_id,owner_id,form,copper_g,hdpe_g,dirt_g,observation_id)
          values(mid,uid,'cable',d.copper_g,d.hdpe_g,d.dirt_g,observation);
      end if;
    when 'start_processing' then
      select * into machine from game_private.machines where id=(p_request->>'machine_id')::uuid and match_id=mid and owner_id=uid;
      if not found then perform game_private.fail('NOT_AVAILABLE'); end if;
      select * into b from game_private.batches where id=(p_request->>'batch_id')::uuid and match_id=mid and owner_id=uid;
      if not found then perform game_private.fail('NOT_AVAILABLE'); end if;
      if machine.status<>'ready' or machine.energy_mj<500 or b.state<>'available' or b.form<>'cable'
        or exists(select 1 from game_private.jobs where machine_id=machine.id and state in ('running','paused')) then
        perform game_private.fail('NOT_READY');
      end if;
      if not exists(select 1 from game_private.observations o join game_private.deposits x on x.id=o.deposit_id
        where o.id=b.observation_id and o.owner_id=uid and x.owner_id=uid and x.match_id=mid and x.collected
        and x.copper_g=b.copper_g and x.hdpe_g=b.hdpe_g and x.dirt_g=b.dirt_g) then perform game_private.fail('INSPECTION_REQUIRED'); end if;
      plan:=game_private.plan_cable(b.copper_g,b.hdpe_g,b.dirt_g);
      update game_private.batches set state='reserved' where id=b.id;
      insert into game_private.jobs(match_id,owner_id,machine_id,input_batch_id,duration_ms,last_tick_ms,plan)
        values(mid,uid,machine.id,b.id,(plan->>'duration_ms')::integer,greatest(game_private.now_ms(),m.last_advanced_ms),plan);
    when 'pause_job','resume_job','cancel_job' then
      select * into j from game_private.jobs where id=(p_request->>'job_id')::uuid and match_id=mid and owner_id=uid;
      if not found then perform game_private.fail('NOT_AVAILABLE'); end if;
      if j.state not in ('running','paused') then perform game_private.fail('NOT_READY'); end if;
      if p_operation='cancel_job' then perform game_private.cancel_job(j.id,'requested');
      elsif p_operation='pause_job' then
        update game_private.jobs set state='paused',pause_reason='requested' where id=j.id;
      else
        if j.state<>'paused' or not exists(select 1 from game_private.machines where id=j.machine_id and status='ready' and energy_mj>=500) then
          perform game_private.fail('NOT_READY');
        end if;
        update game_private.jobs set state='running',pause_reason=null,last_tick_ms=greatest(game_private.now_ms(),m.last_advanced_ms) where id=j.id;
      end if;
    when 'dismantle_machine' then
      select * into machine from game_private.machines where id=(p_request->>'machine_id')::uuid and match_id=mid and owner_id=uid;
      if not found then perform game_private.fail('NOT_AVAILABLE'); end if;
      if machine.status<>'ready' then perform game_private.fail('NOT_READY'); end if;
      for j in select * from game_private.jobs where machine_id=machine.id and state in ('running','paused') loop
        perform game_private.cancel_job(j.id,'machine_destroyed');
      end loop;
      update game_private.machines set status='destroyed',dissipated_mj=dissipated_mj+energy_mj,energy_mj=0 where id=machine.id;
    when 'abandon_match' then
      for j in select * from game_private.jobs where match_id=mid and state in ('running','paused') loop
        perform game_private.cancel_job(j.id,'match_abandoned');
      end loop;
      update game_private.matches set status='abandoned',invite_code=null where id=mid;
  end case;
  if p_operation<>'create' then update game_private.matches set revision=revision+1 where id=mid; end if;
  result:=jsonb_build_object('version',1,'balance_version','dump-v1','command_id',cmd,'snapshot',game_private.snapshot(mid,uid));
  if p_operation='create' then result:=result || jsonb_build_object('invite_code',invite); end if;
  insert into game_private.commands values(uid,cmd,mid,p_operation,p_request,result);
  return result;
end;
$$;
-- Thin public RPC: privileged implementation stays outside exposed schemas.
create function public.game_runtime(p_operation text,p_request jsonb) returns jsonb
language sql security invoker set search_path='' as $$
  select game_private.dispatch(p_operation,p_request);
$$;
revoke all on all functions in schema game_private from public, anon, authenticated, service_role;
grant usage on schema game_private to authenticated;
grant execute on function game_private.dispatch(text,jsonb) to authenticated;
revoke all on function public.game_runtime(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.game_runtime(text,jsonb) to authenticated;
