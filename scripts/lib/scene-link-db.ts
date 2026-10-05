import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';

/** Real PostgreSQL semantics; only the Supabase-owned auth/storage schemas are stubbed. */
export async function sceneLinkDB(beforeLinks?: (db:PGlite)=>Promise<void>, beforeHistory?: (db:PGlite)=>Promise<void>) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    alter table storage.objects enable row level security;
    grant select,insert,delete on storage.objects to authenticated;
  `);
  const paths = (await readdir('supabase/migrations')).filter(path => path.endsWith('.sql')).sort();
  for (const path of paths) {
    if(path==='20260929040000_scene_revision_links.sql')await beforeLinks?.(db);
    if(path==='20260929120000_scene_history.sql')await beforeHistory?.(db);
    await db.exec(await readFile(`supabase/migrations/${path}`, 'utf8'));
  }
  async function asUser<T>(owner:string|null, work:()=>Promise<T>) {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner??'']);
    await db.exec(`set role ${owner?'authenticated':'anon'}`);
    try { return await work(); } finally { await db.exec('reset role'); }
  }
  async function rpc(name:string,args:unknown[]) {
    if(!/^[a-z_]+$/.test(name))throw new Error('Invalid RPC name');
    const result=await db.query(`select to_jsonb(public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')})) as data`,args);
    return result.rows[0].data as any;
  }
  return {db,asUser,rpc};
}
