#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { clients, loadWorkflow, startClient, connectWorkflow, updateRequest } from './lib/mcp-scene-workflows.mjs';

const usage = `Replay an authored MCP fixture without an LLM:
  npm run demo:mcp-scene -- --client codex --print-request
  npm run demo:mcp-scene -- --client codex --create
  npm run demo:mcp-scene -- --client chatgpt --update SCENE_UUID --base-revision 1
Options: --request-id UUID preserves a write identity for an identical retry.
Create/update write to your configured Supabase using the existing CLI sign-in.
Clients (${clients.join(', ')}) are fixture labels, not live vendor integrations.`;

let client;
try {
  const { values } = parseArgs({ options: {
    client: { type: 'string', default: 'codex' }, create: { type: 'boolean' }, update: { type: 'string' },
    'base-revision': { type: 'string' }, 'request-id': { type: 'string' }, 'print-request': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); } else {
    if ([values.create, values.update, values['print-request']].filter(Boolean).length !== 1) throw new Error(usage);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const base = Number(values['base-revision']);
    if (values.update && (!uuid.test(values.update) || !Number.isSafeInteger(base) || base < 1)) throw new Error('--update requires a scene UUID and an explicit positive --base-revision.');
    if (!values.update && values['base-revision']) throw new Error('--base-revision is only used with --update.');
    if (values['request-id'] && !uuid.test(values['request-id'])) throw new Error('--request-id must be a UUID.');
    const profile = await loadWorkflow(values.client);
    const requestId = values['request-id'] ?? (values['print-request'] ? profile.create.request_id : randomUUID());
    if (values['print-request']) {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'astra.create_scene', arguments: { ...profile.createRequest, request_id: requestId } } }, null, 2));
    } else {
      // Print only IDs needed for recovery, never session files or raw provider data.
      console.error(`Request ID: ${requestId}${values.create ? `; scene ID: ${requestId}` : `; scene ID: ${values.update}; base revision: ${base}`}`);
      client = startClient(profile);
      const mcp = await connectWorkflow(client, profile);
      await mcp.call('list_scene_assets', { version: 1 });
      let result;
      if (values.create) {
        for (const id of ['cleanroom-architecture', 'cleanroom-robot', 'cleanroom-desk']) await mcp.call('inspect_scene_asset', { version: 1, asset: { kind: 'example', id } });
        result = await mcp.call('create_scene', { ...profile.createRequest, request_id: requestId });
      } else {
        const saved = await mcp.call('read_scene', { version: 1, scene_id: values.update, revision_id: base });
        result = await mcp.call('update_scene', updateRequest(profile, saved, requestId));
      }
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (error) {
  console.error(`${error.code ? `${error.code}: ` : ''}${error.message}${error.currentRevision ? ` Current revision: ${error.currentRevision}.` : ''}`);
  process.exitCode = 1;
} finally { await client?.close(); }
