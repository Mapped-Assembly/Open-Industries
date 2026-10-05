import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { formHealth, generationArgs, runGeneration } from './form.mjs';
import { saveAnimationFeedback } from './feedback.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = express();
const jobs = new Map();
app.disable('x-powered-by');
app.use('/api', (req, res, next) => {
  // Local workbench: don't permit other websites to trigger paid provider calls.
  const origin = req.get('origin');
  if (origin) {
    try {
      const url = new URL(origin);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return res.status(403).json({ error: 'Use the local Mergence workbench.' });
    } catch { return res.status(403).json({ error: 'Invalid origin.' }); }
  }
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '64kb' }));
app.get('/api/health', async (_req, res) => res.json(await formHealth(root)));
app.post('/api/form/feedback', async (req, res) => {
  try { return res.status(201).json(await saveAnimationFeedback(root, req.body)); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});
app.post('/api/generations', (req, res) => {
  try { generationArgs(req.body ?? {}, 'project.json'); } catch (error) { return res.status(400).json({ error: error.message }); }
  if ([...jobs.values()].some(job => job.status === 'running')) return res.status(409).json({ error: 'A Form generation is already running. Wait for it to finish.' });
  for (const [id, job] of jobs) if (Date.now() - job.createdAt > 3_600_000) jobs.delete(id);
  if (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
  const id = randomUUID();
  const job = { id, status: 'running', message: 'Checking Form installation…', mode: req.body.mode, createdAt: Date.now() };
  jobs.set(id, job);
  void runGeneration(root, req.body, job);
  res.status(202).json({ id });
});
app.get('/api/generations/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Generation not found. It may have expired or the server restarted.' });
  res.json(job);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));
app.use(express.static(resolve(root, 'dist')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve(root, 'dist/index.html')));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.type === 'entity.too.large' ? 'Request is too large.' : 'Invalid request or server error.' }));
app.listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log(`Mergence server: http://127.0.0.1:${process.env.PORT || 8787}`));
