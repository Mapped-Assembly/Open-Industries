import { createServer } from 'node:http';
import { once } from 'node:events';
import { sceneLinkDB } from './scene-link-db.ts';

/** Local Supabase HTTP facade. Queries, RPCs and object access use real migrations/RLS. */
export async function sceneTestService() {
  const { db, asUser, rpc } = await sceneLinkDB();
  const objects = new Map<string, Buffer>();
  const tokens = new Map<string, string>();
  let queue = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next;
  }
  const orders: Record<string, string[]> = {
    prepare_asset_upload: ['p_asset_key', 'p_name', 'p_source_kind', 'p_metadata', 'p_files'],
    finish_asset_upload: ['p_id'],
    save_workspace_scene: ['p_id', 'p_name', 'p_document', 'p_expected_revision', 'p_write_id'],
    get_workspace_scene: ['p_id', 'p_revision', 'p_share_token'],
    list_scene_revisions: ['p_id', 'p_before_revision', 'p_limit'],
    restore_workspace_scene: ['p_id', 'p_revision', 'p_expected_revision', 'p_write_id'],
    delete_workspace_scene: ['p_id', 'p_expected_revision'],
    duplicate_workspace_scene: ['p_source_id', 'p_new_id', 'p_name'],
  };
  let failNextUpload = false;
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, 'http://localhost');
    const owner = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, '')) ?? null;
    const json = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data)); };
    try {
      if (url.pathname === '/auth/v1/user') {
        if (!owner) { json({ message: 'Invalid test session' }, 401); return; }
        json({ id: owner, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }); return;
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.split('/').at(-1)!; const args = JSON.parse(body.toString());
        if (!orders[name]) throw new Error(`Unsupported test RPC: ${name}`);
        json(await serialized(() => asUser(owner, () => rpc(name, orders[name].map(key => args[key]))))); return;
      }
      if (url.pathname === '/rest/v1/assets' && req.method === 'POST') {
        const records = JSON.parse(body.toString());
        for (const row of records) await serialized(() => asUser(owner, () => db.query(`insert into public.assets(owner_id,asset_key,name,source_kind,metadata) values($1,$2,$3,$4,$5)
          on conflict(owner_id,asset_key) do update set name=excluded.name,source_kind=excluded.source_kind,metadata=excluded.metadata`, [row.owner_id,row.asset_key,row.name,row.source_kind,JSON.stringify(row.metadata)])));
        json(null); return;
      }
      if (url.pathname === '/rest/v1/scenes' || url.pathname === '/rest/v1/asset_file_versions') {
        const table = url.pathname.split('/').at(-1)!;
        const filters: string[] = []; const values: unknown[] = [];
        for (const key of ['id', 'owner_id', 'state']) {
          const value = url.searchParams.get(key); if (!value) continue;
          if (!value.startsWith('eq.')) throw new Error('Unsupported test filter');
          values.push(value.slice(3)); filters.push(`t.${key}=$${values.length}`);
        }
        const select = table === 'scenes' ? 'to_jsonb(t) as data' : "to_jsonb(t)||jsonb_build_object('asset',jsonb_build_object('asset_key',a.asset_key,'name',a.name,'source_kind',a.source_kind)) as data";
        const join = table === 'scenes' ? '' : 'join public.assets a on a.id=t.asset_id';
        const limit = Number(url.searchParams.get('limit') ?? 200), offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isInteger(limit) || !Number.isInteger(offset)) throw new Error('Invalid test pagination');
        const rows = await serialized(() => asUser(owner, () => db.query(`select ${select} from public.${table} t ${join} ${filters.length ? 'where ' + filters.join(' and ') : ''} order by t.id limit ${limit} offset ${offset}`, values)));
        const data = rows.rows.map((row: any) => row.data);
        json(req.headers.accept?.includes('vnd.pgrst.object') ? data[0] ?? null : data); return;
      }
      if (url.pathname.startsWith('/storage/v1/object/')) {
        const path = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\/object\/(authenticated\/)?astra-assets\//, ''));
        if (req.method === 'POST') {
          if (failNextUpload) { failNextUpload = false; json({ message: 'Injected interruption', statusCode: '503' }, 503); return; }
          let bytes = body; let mime = req.headers['content-type'] ?? '';
          if (mime.startsWith('multipart/')) {
            const form = await new Request(url, { method: 'POST', headers: { 'content-type': mime }, body }).formData();
            const blob = [...form.values()].find(value => value instanceof Blob) as Blob;
            bytes = Buffer.from(await blob.arrayBuffer()); mime = blob.type;
          }
          if (objects.has(path)) { json({ message: 'Object already exists', statusCode: '409' }, 409); return; }
          await serialized(() => asUser(owner, () => db.query("insert into storage.objects(bucket_id,name,metadata) values('astra-assets',$1,$2)", [path, JSON.stringify({ size: bytes.length, mimetype: mime })])));
          objects.set(path, bytes); json({ Key: `astra-assets/${path}` }); return;
        }
        const rows = await serialized(() => asUser(owner, () => db.query("select name from storage.objects where bucket_id='astra-assets' and name=$1", [path])));
        if (!rows.rows.length || !objects.has(path)) { json({ message: 'Object unavailable' }, 404); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(objects.get(path)); return;
      }
      json({ message: 'Unsupported test endpoint' }, 404);
    } catch (error) { const e=error as any; json({ message:e.message,code:e.code,details:e.detail,hint:e.hint }, 400); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function account(id: string) {
    await serialized(() => db.query('insert into auth.users values($1)', [id]));
    const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), Buffer.from('fixture-signature').toString('base64url')].join('.');
    tokens.set(jwt, id);
    return { access_token: jwt, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: { id, aud: 'authenticated', role: 'authenticated', user_metadata: {}, app_metadata: {} } };
  }
  return { db, origin, account, objects, interruptUpload: () => { failNextUpload = true; },
    sql: <T = any>(sql: string, values: unknown[] = []) => serialized(() => db.query<T>(sql, values)),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await db.close(); } };
}
