export type GenerationRequest = { prompt: string; mode: 'simulation' | 'live'; provider: string; model: string };
export type FormHealth = { available: boolean; message: string };

async function apiJSON(path: string, options?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetch(path, { ...options, signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error('The local Forma server is not responding. Check that npm run dev is running, then retry.'); }
  let data: Record<string, unknown>;
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    data = value as Record<string, unknown>;
  } catch { throw new Error('Forma generation is unavailable on this deployment. Run the local workbench with npm run dev.'); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The Forma server could not complete the request.');
  return data;
}

export async function getFormHealth(): Promise<FormHealth> {
  const health = await apiJSON('/api/health');
  if (typeof health.available !== 'boolean' || typeof health.message !== 'string') throw new Error('The server did not return Forma availability.');
  return { available: health.available, message: health.message };
}

export async function generateFormProject(request: GenerationRequest, progress: (message: string) => void, isCurrent: () => boolean): Promise<object | undefined> {
  const data = await apiJSON('/api/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  if (!isCurrent()) return;
  if (typeof data.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(data.id)) throw new Error('The Forma server did not return a generation ID.');
  const deadline = Date.now() + 660_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (!isCurrent()) return;
    const job = await apiJSON(`/api/generations/${encodeURIComponent(data.id)}`);
    if (!isCurrent()) return;
    if (job.status === 'failed') throw new Error(typeof job.message === 'string' ? job.message : 'Forma generation failed.');
    if (typeof job.message === 'string') progress(job.message);
    if (job.status === 'succeeded') {
      if (!job.project || typeof job.project !== 'object' || Array.isArray(job.project)) throw new Error('Forma finished without a usable project.');
      return job.project;
    }
    if (job.status !== 'running') throw new Error('The Forma server returned an unknown generation status.');
  }
  throw new Error('Forma generation timed out. Check the local server before trying again.');
}
