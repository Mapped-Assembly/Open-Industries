-- Run deliberately as the database deployment owner, after migrations.
-- Requires a PostgreSQL deployment with pg_cron in shared_preload_libraries.
-- Supabase supports seconds schedules on Postgres 15.1.1.61+.
begin;
create extension if not exists pg_cron;
select cron.schedule('oi-game-runtime-v1', '1 second', 'select game_private.tick()');
select game_private.tick();
commit;
-- Check cron.job_run_details for failures; a 15s stale heartbeat prevents new work.
