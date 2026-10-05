import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GameDatabase } from './game-sqlite.mjs';
import { gameErrors, gameFail, GameToolError } from './mcp-game-contract.mjs';

export async function startGameService({ database, port = 8790, allowSignup = false, tickMs = 1000 }) {
  const db = new GameDatabase(database);
  let authPending = 0;
  const attempts = new Map();
  const server = createServer(async (req, res) => {
    const send = (status, value) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(value));
    try {
      // Server-to-server transport only. Browsers must use the game backend.
      if (req.headers.origin || req.url?.includes('?')) return send(403, { error: { code: 'INVALID_REQUEST', message: gameErrors.INVALID_REQUEST } });
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      if (req.method === 'GET' && req.url === '/health') return send(200, { scheduler_healthy: db.healthy(), registration_enabled: allowSignup, version: 3 });
      if (req.method === 'GET' && req.url === '/auth/session') { db.identity(token); return send(200, { authenticated: true }); }
      if (req.method !== 'POST' || !['/auth/login', '/auth/register', '/auth/logout', '/game'].includes(req.url)) return send(404, { error: { code: 'INVALID_REQUEST', message: gameErrors.INVALID_REQUEST } });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') gameFail('INVALID_REQUEST');
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 12288) gameFail('INVALID_REQUEST'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { gameFail('INVALID_REQUEST'); }
      if (req.url === '/auth/login' || req.url === '/auth/register') {
        if (req.url === '/auth/register' && !allowSignup) gameFail('DISABLED');
        const now = Date.now(), key = req.socket.remoteAddress;
        for (const [ip, entry] of attempts) if (entry.expires <= now) attempts.delete(ip);
        const entry = attempts.get(key) || { count: 0, expires: now + 60000 };
        attempts.set(key, entry);
        if (++entry.count > 30 || authPending >= 4) gameFail('LIMIT_REACHED');
        authPending++;
        try { return send(200, await db.authenticate(body, req.url === '/auth/register')); }
        finally { authPending--; }
      }
      db.identity(token);
      if (req.url === '/auth/logout') { db.logout(token); return send(200, { authenticated: false }); }
      if (!body || Object.keys(body).sort().join(',') !== 'arguments,name' || typeof body.name !== 'string') gameFail('INVALID_REQUEST');
      return send(200, db.dispatch(token, body.name, body.arguments));
    } catch (error) {
      const code = error instanceof GameToolError ? error.code : 'UNAVAILABLE';
      send(code === 'AUTH_REQUIRED' ? 401 : code === 'LIMIT_REACHED' ? 429 : code === 'UNAVAILABLE' ? 503 : 400,
        { error: { code, message: gameErrors[code] || gameErrors.UNAVAILABLE } });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxConnections = 128;
  try {
    db.tick();
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  } catch (error) { db.close(); throw error; }
  const timer = setInterval(() => { try { db.tick(); } catch { /* Failed ticks do not renew the heartbeat. */ } }, tickMs);
  return { db, origin: `http://127.0.0.1:${server.address().port}`,
    async close() { clearInterval(timer); server.closeAllConnections(); await new Promise(done => server.close(done)); db.close(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.ASTRA_GAME_PORT || 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_GAME_PORT');
  const service = await startGameService({ database: resolve(process.env.ASTRA_GAME_DB || '.astra/game/runtime.sqlite'), port,
    allowSignup: process.env.ASTRA_GAME_ALLOW_SIGNUP === 'true' });
  console.log(`OpenIndustries SQLite game service: ${service.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { service.close().then(() => process.exit(0)); });
}
