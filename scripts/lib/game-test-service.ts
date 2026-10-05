import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';

/** Real game migration/RPC/ACLs; only Supabase HTTP auth is a test facade. */
export async function gameTestService(directory?: string) {
  const db = new PGlite(directory);
  if (!(await db.query<{ exists: boolean }>("select to_regnamespace('game_private') is not null as exists")).rows[0].exists) {
    await db.exec([
      'create role anon; create role authenticated; create role service_role;',
      'create schema auth; create table auth.users(id uuid primary key);',
      "create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;",
      'grant usage on schema public,auth to anon,authenticated,service_role;',
    ].join('\n'));
    for (const path of (await readdir('supabase/migrations')).filter(p => p.endsWith('_authoritative_game_runtime.sql'))) {
      await db.exec(await readFile('supabase/migrations/' + path, 'utf8'));
    }
  }
  const tokens = new Map<string, string>();
  let queue = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next;
  }
  const sql = <T = any>(query: string, values: unknown[] = []) => serialized(() => db.query<T>(query, values));
  const rpc = (owner: string | null, operation: string, request: unknown) => serialized(() => db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [owner ?? '']);
    await tx.exec(owner ? 'set local role authenticated' : 'set local role anon');
    const result = await tx.query<{ data: any }>('select public.game_runtime($1,$2::jsonb) as data', [operation, JSON.stringify(request)]);
    return result.rows[0].data;
  }));
  let dropResponse = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const owner = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, '')) ?? null;
    const send = (data: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    try {
      if (req.url === '/auth/v1/user') {
        send(owner ? { id: owner, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} } : { message: 'Invalid fixture session' }, owner ? 200 : 401);
      } else if (req.url === '/rest/v1/rpc/game_runtime') {
        const args = JSON.parse(Buffer.concat(chunks).toString());
        const data = await rpc(owner, args.p_operation, args.p_request);
        if (dropResponse) { dropResponse = false; res.destroy(); } else send(data);
      } else send({ message: 'Unsupported fixture endpoint' }, 404);
    } catch (error) { const e = error as any; send({ message: e.message, code: e.code, details: e.detail }, 400); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  return { db, origin, sql, rpc,
    async account(id: string) {
      await sql('insert into auth.users values($1) on conflict do nothing', [id]);
      const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
        Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), Buffer.from('fixture-signature').toString('base64url')].join('.');
      tokens.set(jwt, id);
      return { access_token: jwt, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600, token_type: 'bearer', user: { id, aud: 'authenticated', role: 'authenticated', user_metadata: {}, app_metadata: {} } };
    },
    loseNextResponse: () => { dropResponse = true; },
    tick: () => sql('select game_private.tick()'),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await queue; await db.close();
    },
  };
}
