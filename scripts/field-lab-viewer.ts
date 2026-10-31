import { createServer } from 'vite';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FieldLabDatabase } from '../server/simulation/field-lab-runtime.js';
import { recordLab } from '../server/field-lab-recording.js';

// Operator-local simulated station. No physical device or cloud credentials.
const root = resolve(process.env.FIELD_LAB_VIEWER_STATE_DIR ?? resolve(homedir(), '.local/share/open-industries/field-lab'));
const installed = process.env.FIELD_LAB_INSTALLED === 'true';
const initialize = process.argv.includes('--init-only');
const configPath = resolve(root, 'operator.json');
if (installed && !initialize && (!existsSync(configPath) || !existsSync(resolve(root, 'lab.sqlite'))))
  throw Error('LOCAL_STATE_MISSING: initialize explicitly or restore a complete backup; refusing to create a replacement task.');
if (!existsSync(configPath) && existsSync(resolve(root, 'lab.sqlite')))
  throw Error('LOCAL_IDENTITY_MISSING: restore operator.json from a complete backup.');
mkdirSync(root, { recursive: true, mode: 0o700 });
/** Atomically replace private metadata; never expose secrets in HTTP responses. */
function saveConfig(path: string, value: unknown): void {
  writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
  const file = openSync(path + '.tmp', 'r');
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(path + '.tmp', path);
  if (process.platform !== 'win32') {
    const directory = openSync(root, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
const credentials = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8'))
  : { username: 'local-viewer', password: randomUUID() + randomUUID(), instanceId: '' };
if (!existsSync(configPath)) saveConfig(configPath, credentials);
if (credentials.instanceId && !existsSync(resolve(root, 'lab.sqlite')))
  throw Error('LOCAL_DATABASE_MISSING: restore the matching database; refusing to replace the saved instance.');
const db = new FieldLabDatabase(resolve(root, 'lab.sqlite'));
const sessionPath = resolve(root, 'session.json');
let session: {token: string; expires_at_ms: number};
try {
  session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  db.identity(session.token);
} catch {
  const accountExists = !!db.db.prepare('SELECT 1 FROM accounts WHERE username=?').get(credentials.username);
  session = await db.authenticate({ username: credentials.username, password: credentials.password }, !accountExists);
  saveConfig(sessionPath, session);
}
if (!credentials.instanceId) {
  if (installed && !initialize) throw Error('LOCAL_INITIALIZATION_INCOMPLETE: rerun --init-only.');
  const result = db.create(session.token, { command_id: 'viewer-lab-v1', scenario: 'baseline', dispatch: 'automatic' }) as any;
  credentials.instanceId = result.snapshot.instance_id;
  saveConfig(configPath, credentials);
}
// Validate the binding before serving anything; never replace a missing instance.
db.read(session.token, credentials.instanceId);
const assets = resolve(root, 'assets');
if (initialize || !installed) {
  mkdirSync(assets, {recursive: true, mode: 0o700});
  for (const name of ['field-lab-pipette.form.json', 'field-lab.oi.json', 'pipette-motion.json'])
    if (!existsSync(resolve(assets, name))) copyFileSync(resolve('benchmarks/field-lab/fixtures', name), resolve(assets, name));
}
if (installed) for (const name of ['field-lab-pipette.form.json', 'field-lab.oi.json', 'pipette-motion.json'])
  if (!existsSync(resolve(assets, name))) throw Error('LOCAL_ASSETS_MISSING: restore a complete station backup.');
const revision = existsSync('RELEASE') ? readFileSync('RELEASE', 'utf8').trim()
  : execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()
    + (execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim() ? '+dirty' : '');
if (initialize) {
  const clientPath = resolve(root, 'client.json');
  if (!existsSync(clientPath)) saveConfig(clientPath, { origin: `http://127.0.0.1:${process.env.FIELD_LAB_VIEWER_PORT ?? 4193}`, token: randomUUID() + randomUUID() });
  console.log(`Initialized local FIELD-LAB in ${root}; instance ${credentials.instanceId}`);
  db.close(); process.exit(0);
}
const client = installed ? JSON.parse(readFileSync(resolve(root, 'client.json'), 'utf8')) : null;
let refreshSession: Promise<void> | undefined;
const port = Number(process.env.FIELD_LAB_VIEWER_PORT ?? 4193);
const origin = `http://127.0.0.1:${port}`;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('INVALID_LOCAL_PORT');
/** Shared local boundary for the development viewer and installed static service. */
async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
  if (!req.url?.startsWith('/lab-') && req.url !== '/health') return next();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const send = (status: number, data: unknown): void => { res.statusCode = status; res.end(JSON.stringify(data)); };
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)
    || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'LOCAL_ORIGIN_REQUIRED' });
  if (req.url?.startsWith('/lab-api/') && (!client || req.headers.origin || req.headers.authorization !== `Bearer ${client.token}`))
    return send(401, {error: 'AUTH_REQUIRED'});
  try {
    if (req.url === '/health' && req.method === 'GET') {
      let healthy = false;
      try { healthy = db.healthy(); } catch { /* Failed storage is not ready. */ }
      return send(healthy ? 200 : 503, {version: 1, scheduler_healthy: healthy});
    }
    // Refresh the server-only session; credentials never enter the browser.
    if (session.expires_at_ms - Date.now() < 60000) {
      refreshSession ??= (async () => {
        db.logout(session.token);
        session = await db.authenticate({ username: credentials.username, password: credentials.password });
        saveConfig(sessionPath, session);
      })().finally(() => { refreshSession = undefined; });
      await refreshSession;
    }
    if (req.method === 'GET' && req.url === '/lab-recording') {
      return send(200, recordLab(db, session.token, credentials.instanceId, revision, assets));
    }
    if (req.method === 'GET' && req.url === '/lab-api/read') return send(200, {snapshot: db.read(session.token, credentials.instanceId)});
    if (req.method === 'POST' && (req.url === '/lab-api/command' || req.url === '/lab-api/history' || (req.url === '/lab-control' && req.headers.origin === origin))
      && req.headers['content-type'] === 'application/json') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) return send(413, { error: 'BODY_TOO_LARGE' }); }
      const command = JSON.parse(body);
      if (command.instance_id && command.instance_id !== credentials.instanceId) return send(403, {error: 'NOT_AVAILABLE'});
      if (req.url === '/lab-api/history') return send(200, db.historyPage(session.token, {...command, instance_id: credentials.instanceId}));
      if (!['pause', 'resume', 'fail', 'cancel'].includes(command.action)) return send(400, { error: 'UNSUPPORTED_ACTION' });
      return send(200, db.execute(session.token, { ...command, instance_id: credentials.instanceId }));
    }
    send(404, { error: 'NOT_FOUND' });
  } catch (error) {
    send(409, { error: error instanceof Error ? error.message : 'UNAVAILABLE' });
  }
}
const staticRoot = resolve('dist-field-lab');
const server = installed ? createHttpServer((req, res) => {
  void middleware(req, res, () => {
    if (req.headers.host !== `127.0.0.1:${port}` || !['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(403).end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', origin).pathname);
      const file = resolve(staticRoot, '.' + (pathname === '/' ? '/benchmarks/field-lab/runtime.html' : pathname));
      if (!file.startsWith(staticRoot + sep)) { res.writeHead(403).end(); return; }
      const data = readFileSync(file);
      res.setHeader('Content-Type', ({'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json'} as Record<string,string>)[extname(file)] ?? 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(404).end(); }
  });
}) : await createServer({server: {host:'127.0.0.1', port, strictPort:true}, plugins:[{
  name:'operator-local-field-lab', configureServer(vite) { vite.middlewares.use((req,res,next) => void middleware(req,res,next)); },
}]});
if (installed) {
  if (!existsSync(resolve(staticRoot, 'benchmarks/field-lab/runtime.html'))) throw Error('LOCAL_BUILD_MISSING: run npm run build:local-runtime.');
  await new Promise<void>((done, reject) => { (server as ReturnType<typeof createHttpServer>).once('error', reject); (server as ReturnType<typeof createHttpServer>).listen(port, '127.0.0.1', done); });
} else await (server as Awaited<ReturnType<typeof createServer>>).listen();
db.tick();
const worker = setInterval(() => { try { db.tick(); } catch { process.exitCode = 1; console.error('Lab worker failed; stopping for supervisor recovery. Check storage and compatible save version.'); void shutdown(); } }, 1000);
let stopping = false;
/** Close the worker and database coherently without deleting persisted progress. */
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true; clearInterval(worker);
  if (installed) await new Promise<void>((done) => (server as ReturnType<typeof createHttpServer>).close(() => done()));
  else await (server as Awaited<ReturnType<typeof createServer>>).close();
  db.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
console.log(`FIELD-LAB live simulated scene: ${origin}/benchmarks/field-lab/runtime.html`);

console.log(`Local state: ${root}`);
