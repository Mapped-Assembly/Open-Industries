// Check the capability on every download. Do not issue reusable signed URLs or
// make the bucket public: revocation must apply to subsequent geometry requests.
export function sceneAssetHandler(reader, storage) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
  const error = (message, status) => Response.json({ error: message }, { status, headers });
  return async request => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return error('Use POST.', 405);
    try {
      const body = await request.text();
      if (body.length > 2048) return error('Request too large.', 413);
      const { sceneId, revision, token, versionId } = JSON.parse(body);
      if (typeof sceneId !== 'string' || typeof versionId !== 'string' || !Number.isSafeInteger(revision) || revision < 1 || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return error('Invalid shared scene request.', 400);
      const { data, error: denied } = await reader.rpc('get_workspace_scene', { p_id: sceneId, p_revision: revision, p_share_token: token });
      if (denied) return error('Shared link is invalid, expired, or revoked.', 403);
      const version = data.versions.find(item => item.id === versionId && item.state === 'ready');
      if (!version || !version.files.some(file => file.name === 'asset.json')) return error('Geometry unavailable for this revision.', 404);
      const { data: blob, error: missing } = await storage.from('astra-assets').download(`${version.owner_id}/${version.id}/asset.json`);
      if (missing || !blob) return error('Geometry unavailable for this revision.', 404);
      return new Response(blob, { headers: { ...headers, 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return error('Could not load shared geometry.', 400); }
  };
}
