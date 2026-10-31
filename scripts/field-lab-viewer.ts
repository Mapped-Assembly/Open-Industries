import { createServer } from 'vite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FieldLabDatabase } from '../server/simulation/field-lab-runtime.js';
import { recordLab } from '../server/field-lab-recording.js';

// Operator-local simulated station. No physical device or cloud credentials.
const root = resolve(process.env.FIELD_LAB_VIEWER_STATE_DIR ?? '.astra/field-lab-viewer');
mkdirSync(root, { recursive: true, mode: 0o700 });
const configPath = resolve(root, 'operator.json');
const credentials = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8'))
  : { username: 'local-viewer', password: randomUUID() + randomUUID(), instanceId: '' };
const db = new FieldLabDatabase(resolve(root, 'lab.sqlite'));
let session = await db.authenticate({ username: credentials.username, password: credentials.password }, !existsSync(configPath));
if (!credentials.instanceId) {
  const result = db.create(session.token, { command_id: 'viewer-lab-v1', scenario: 'baseline', dispatch: 'automatic' }) as any;
  credentials.instanceId = result.snapshot.instance_id;
  writeFileSync(configPath, JSON.stringify(credentials), { mode: 0o600 });
}
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  + (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() ? '+dirty' : '');
let authenticatedAt = Date.now();
const port = Number(process.env.FIELD_LAB_VIEWER_PORT ?? 4193);
const origin = `http://127.0.0.1:${port}`;
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true }, plugins: [{
  name: 'operator-local-field-lab',
  configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/lab-')) return next();
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      const send = (status: number, data: unknown): void => { res.statusCode = status; res.end(JSON.stringify(data)); };
      if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)
        || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'LOCAL_ORIGIN_REQUIRED' });
      try {
        // Refresh the server-only session; credentials never enter the browser.
        if (Date.now() - authenticatedAt > 3600000) {
          session = await db.authenticate({ username: credentials.username, password: credentials.password });
          authenticatedAt = Date.now();
        }
        if (req.method === 'GET' && req.url === '/lab-recording') {
          return send(200, recordLab(db, session.token, credentials.instanceId, revision));
        }
        if (req.method === 'POST' && req.url === '/lab-control' && req.headers.origin === origin
          && req.headers['content-type'] === 'application/json') {
          let body = '';
          for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(413, { error: 'BODY_TOO_LARGE' }); }
          const command = JSON.parse(body);
          if (!['pause', 'resume', 'fail', 'cancel'].includes(command.action)) return send(400, { error: 'UNSUPPORTED_ACTION' });
          return send(200, db.execute(session.token, { ...command, instance_id: credentials.instanceId }));
        }
        send(404, { error: 'NOT_FOUND' });
      } catch (error) {
        send(409, { error: error instanceof Error ? error.message : 'UNAVAILABLE' });
      }
    });
  },
}] });
const worker = setInterval(() => { try { db.tick(); } catch { console.error('Lab worker failed; stopping'); void shutdown(); } }, 1000);
let stopping = false;
/** Close the worker and database coherently without deleting persisted progress. */
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true; clearInterval(worker); await server.close(); db.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await server.listen();
console.log(`FIELD-LAB live simulated scene: ${origin}/benchmarks/field-lab/runtime.html`);
