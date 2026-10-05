import { gameContract, gameErrors, gameFail, GameToolError, validateGameRequest, validateGameResult } from './mcp-game-contract.mjs';

/** MCP is a transport only. The independently running SQLite service owns state. */
export async function callGameTool(_root: string, name: string, raw: unknown) {
  const args = validateGameRequest(name, raw);
  if (name === 'astra.game_describe') return validateGameResult(name, gameContract);
  if (process.env.ASTRA_GAME_TOOLS_ENABLED !== 'true') return gameFail('DISABLED');
  const token = process.env.ASTRA_GAME_SESSION;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return gameFail('AUTH_REQUIRED');
  let url: URL;
  try {
    url = new URL(process.env.ASTRA_GAME_SERVICE_URL || 'http://127.0.0.1:8790');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
  } catch { return gameFail('UNAVAILABLE'); }
  try {
    const response = await fetch(new URL('/game', url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, arguments: args }),
    });
    const reader = response.body?.getReader();
    if (!reader) return gameFail('OUTCOME_UNKNOWN');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 256 * 1024) { await reader.cancel(); return gameFail('INVALID_RESULT'); }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) {
      const code = data?.error?.code;
      return gameFail(typeof code === 'string' && Object.hasOwn(gameErrors, code) ? code : 'UNAVAILABLE');
    }
    return validateGameResult(name, data);
  } catch (error) {
    if (error instanceof GameToolError) throw error;
    return gameFail('OUTCOME_UNKNOWN');
  }
}
