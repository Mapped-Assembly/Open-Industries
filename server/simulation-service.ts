import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SimulationDatabase, SimulationRuntimeError } from './simulation/sqlite-runtime.js';
import { AuthorityError } from './simulation/sqlite-authority.mjs';
import { SimulationCommandError } from './simulation/commands.mjs';
import { SimulationContractError } from './simulation/registry.js';
import { SimulationJobError } from './simulation/jobs.js';
import { SimulationEventError } from './simulation/events.mjs';
import { workCellPin } from './domains/work-cell.js';

/** Server-to-server neutral service; browser/session transport remains an application concern. */
export async function startSimulationService({
  database,
  port = 8791,
  allowSignup = false,
  tickMs = 1000,
  clock = Date.now,
}: {
  database: string;
  port?: number;
  allowSignup?: boolean;
  tickMs?: number;
  clock?: () => number;
}) {
  const db = new SimulationDatabase(database, { clock });
  let authPending = 0;
  const attempts = new Map<string, { count: number; expires: number }>();
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) =>
      res
        .writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        .end(JSON.stringify(value));
    try {
      if (req.headers.origin || req.url?.includes('?'))
        throw new SimulationRuntimeError('INVALID_REQUEST');
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (req.method === 'GET' && req.url === '/health')
        return send(200, {
          version: 1,
          module: workCellPin,
          scheduler_healthy: db.healthy(),
          registration_enabled: allowSignup,
        });
      if (
        req.method !== 'POST' ||
        ![
          '/auth/register',
          '/auth/login',
          '/auth/logout',
          '/simulation/instances',
          '/simulation/read',
          '/simulation/command',
          '/simulation/history',
        ].includes(req.url ?? '')
      )
        return send(404, { error: { code: 'NOT_AVAILABLE' } });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json')
        throw new SimulationRuntimeError('INVALID_REQUEST');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 12288) throw new SimulationRuntimeError('INVALID_REQUEST');
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw new SimulationRuntimeError('INVALID_REQUEST');
      }
      if (req.url === '/auth/register' || req.url === '/auth/login') {
        if (req.url === '/auth/register' && !allowSignup)
          throw new SimulationCommandError('NOT_AVAILABLE');
        const now = clock(),
          key = req.socket.remoteAddress ?? 'unknown';
        for (const [ip, entry] of attempts) if (entry.expires <= now) attempts.delete(ip);
        const entry = attempts.get(key) ?? { count: 0, expires: now + 60000 };
        attempts.set(key, entry);
        if (++entry.count > 30 || authPending >= 4)
          throw new SimulationRuntimeError('LIMIT_REACHED');
        authPending++;
        try {
          return send(200, await db.authenticate(body, req.url === '/auth/register'));
        } finally {
          authPending--;
        }
      }
      db.identity(token);
      if (req.url === '/auth/logout') {
        db.logout(token);
        return send(200, { authenticated: false });
      }
      if (req.url === '/simulation/instances') return send(200, db.create(token, body));
      if (req.url === '/simulation/command') return send(200, db.execute(token, body));
      if (req.url === '/simulation/history') return send(200, db.historyPage(token, body));
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).join(',') !== 'instance_id' ||
        !('instance_id' in body) ||
        typeof body.instance_id !== 'string'
      )
        throw new SimulationRuntimeError('INVALID_REQUEST');
      return send(200, { snapshot: db.read(token, body.instance_id) });
    } catch (error) {
      const known =
        error instanceof AuthorityError ||
        error instanceof SimulationRuntimeError ||
        error instanceof SimulationCommandError ||
        error instanceof SimulationContractError ||
        error instanceof SimulationJobError ||
        error instanceof SimulationEventError;
      const code = known ? error.code : 'UNAVAILABLE';
      const publicCodes = new Set([
        'AUTH_REQUIRED',
        'NOT_AVAILABLE',
        'INVALID_REQUEST',
        'CONFLICT',
        'COMMAND_ID_REUSED',
        'INVALID_TRANSITION',
        'CATCHUP_REQUIRED',
        'LIMIT_REACHED',
        'CURSOR_EXPIRED',
      ]);
      const safe = publicCodes.has(code) ? code : 'UNAVAILABLE';
      return send(
        safe === 'AUTH_REQUIRED'
          ? 401
          : safe === 'LIMIT_REACHED'
            ? 429
            : safe === 'CONFLICT' || safe === 'CATCHUP_REQUIRED' || safe === 'CURSOR_EXPIRED'
              ? 409
              : safe === 'UNAVAILABLE'
                ? 503
                : 400,
        {
          error: {
            code: safe,
            message:
              safe === 'CATCHUP_REQUIRED'
                ? 'The server is catching up. Read the checkpoint and retry after the worker advances.'
                : safe === 'CURSOR_EXPIRED'
                  ? 'Fetch a fresh snapshot.'
                  : safe,
          },
        },
      );
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxConnections = 128;
  try {
    db.tick();
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', done);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const timer = setInterval(() => {
    try {
      db.tick();
    } catch {
      /* Failed ticks do not renew health. */
    }
  }, tickMs);
  return {
    db,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.ASTRA_SIMULATION_PORT ?? 8791);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('INVALID_SIMULATION_PORT');
  const service = await startSimulationService({
    database: resolve(process.env.ASTRA_SIMULATION_DB ?? '.astra/simulation/work-cell.sqlite'),
    port,
    allowSignup: process.env.ASTRA_SIMULATION_ALLOW_SIGNUP === 'true',
  });
  console.log(`OpenIndustries simulation service: ${service.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      service.close().then(() => process.exit(0));
    });
}
