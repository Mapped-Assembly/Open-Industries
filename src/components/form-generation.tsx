import { useEffect, useState } from 'react';
import { getFormHealth, type FormHealth, type GenerationRequest } from '../lib/form-generation';

export function FormGeneration({ busy, generate }: { busy: boolean; generate: (request: GenerationRequest) => Promise<void> }) {
  const enabled = (import.meta.env.VITE_FORM_GENERATION_ENABLED ?? import.meta.env.VITE_FORMA_GENERATION_ENABLED) !== 'false';
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<FormHealth | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [request, setRequest] = useState<GenerationRequest>({ prompt: 'A small 5V laboratory temperature monitor with a display', mode: 'simulation', provider: 'openai', model: '' });
  useEffect(() => {
    if (!open || !enabled) return;
    let current = true;
    setHealth(null);
    void getFormHealth().then(value => { if (current) setHealth(value); }).catch(error => { if (current) setHealth({ available: false, message: error.message }); });
    return () => { current = false; };
  }, [open, enabled, attempt]);
  const ready = health?.available && request.prompt.trim() && (request.mode === 'simulation' || (request.provider.trim() && request.model.trim()));
  return <section aria-label="Forma generation">
    <button aria-expanded={open} aria-controls="forma-generation" onClick={() => setOpen(value => !value)}>Generate Forma project</button>
    <details id="forma-generation" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Build with Form</summary>
      {!enabled ? <p>This deployment supports project import and export. To generate equipment, run the local OpenIndustries workbench with Forma installed, then import its project here.</p> : <>
        <p role="status" aria-label="Forma availability">{health?.message ?? 'Checking local Forma installation…'}</p>
        {health && !health.available && <button disabled={busy} onClick={() => setAttempt(value => value + 1)}>Check again</button>}
        <form onSubmit={event => { event.preventDefault(); if (ready && !busy) void generate(request); }}>
          <label>Project description<textarea maxLength={12000} required disabled={busy} value={request.prompt} onChange={event => setRequest({ ...request, prompt: event.target.value })} /></label>
          <label>Generation mode<select disabled={busy} value={request.mode} onChange={event => setRequest({ ...request, mode: event.target.value as GenerationRequest['mode'] })}><option value="simulation">Deterministic demo</option><option value="live">Live generation</option></select></label>
          {request.mode === 'live' ? <><label>Provider<input required maxLength={160} disabled={busy} value={request.provider} onChange={event => setRequest({ ...request, provider: event.target.value })} /></label><label>Model<input required maxLength={160} disabled={busy} value={request.model} onChange={event => setRequest({ ...request, model: event.target.value })} /></label><p>Uses provider credentials configured on the local server.</p></> : <p>Creates a sample Forma project without an AI provider. Choose Live generation to build from your description with a model.</p>}
          <button type="submit" disabled={busy || !ready}>Build and import →</button>
        </form>
      </>}
      <p><a href="https://github.com/caid-technologies/Open-Industries/blob/main/docs/development.md#local-form-generation" target="_blank" rel="noreferrer">Local generation setup</a></p>
    </details>
  </section>;
}
