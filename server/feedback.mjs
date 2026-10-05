import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function saveAnimationFeedback(root, payload) {
  if (!payload || payload.format !== 'astra.animation-feedback' || payload.version !== 1) throw new Error('Unsupported Mergence animation feedback package.');
  if (typeof payload.instruction !== 'string' || !payload.instruction.trim() || payload.instruction.length > 4000) throw new Error('Animation feedback needs a short instruction.');
  if (!payload.scene || payload.scene.format !== 'astra.scene' || !payload.review || payload.review.motion !== 'animation') throw new Error('Animation feedback must include a scene and authored animation review.');
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, 'utf8') > 5 * 1024 * 1024) throw new Error('Animation feedback exceeds the 5 MiB local limit.');
  const directory = resolve(root, '.astra', 'feedback');
  await mkdir(directory, { recursive: true });
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  await writeFile(resolve(directory, `${id}.json`), json, 'utf8');
  await writeFile(resolve(directory, 'latest.json'), json, 'utf8');
  let forwarded = false;
  const feedbackUrl = process.env.FORM_FEEDBACK_URL?.trim() || process.env.FORMA_FEEDBACK_URL?.trim();
  if (feedbackUrl) {
    const response = await fetch(feedbackUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Form feedback adapter returned HTTP ${response.status}.`);
    forwarded = true;
  }
  return { accepted: true, id, forwarded, message: forwarded ? 'Animation feedback sent to the configured Form adapter.' : 'Animation feedback saved locally for the Form/OpenCode feedback loop.' };
}
