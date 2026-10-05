import { loadEnv, sessionClient } from '../cli/session.mjs';
import { gameContract, gameErrors, gameFail, GameToolError, validateGameRequest, validateGameResult } from './mcp-game-contract.mjs';

const operations: Record<string, string> = {
  'astra.game_create_match': 'create',
  'astra.game_join_match': 'join',
  'astra.game_read_match': 'read',
};

/** Postgres is the only game authority. No local file state or client simulation. */
export async function callGameTool(root: string, name: string, raw: unknown) {
  const args = validateGameRequest(name, raw) as Record<string, unknown>;
  if (name === 'astra.game_describe') return validateGameResult(name, gameContract);
  loadEnv(root);
  if (process.env.ASTRA_GAME_TOOLS_ENABLED !== 'true') return gameFail('DISABLED');
  const signal = AbortSignal.timeout(30000);
  let auth: Awaited<ReturnType<typeof sessionClient>>;
  try { auth = await sessionClient({ root, signal }); }
  catch { return gameFail('AUTH_REQUIRED'); }
  const { action, ...request } = args;
  try {
    const { data, error } = await auth.supabase.rpc('game_runtime', {
      p_operation: name === 'astra.game_command' ? action : operations[name],
      p_request: request,
    });
    if (error) {
      if (signal.aborted) return gameFail('OUTCOME_UNKNOWN');
      const code = /^OI_GAME:([A-Z_]+)$/.exec(error.message)?.[1];
      if (code && Object.hasOwn(gameErrors, code)) return gameFail(code);
      // A network interruption is indistinguishable from a lost commit response.
      return gameFail(error.code ? 'UNAVAILABLE' : 'OUTCOME_UNKNOWN');
    }
    return validateGameResult(name, data);
  } catch (error) {
    if (error instanceof GameToolError) throw error;
    return gameFail('OUTCOME_UNKNOWN');
  }
}
