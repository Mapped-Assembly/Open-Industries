import { scrubCloudData } from './cloud-storage';
import { makeManifest, type Workspace } from './workspace';
import type { GifMetadata } from './gif';

export type AnimationFeedback = {
  format: 'astra.animation-feedback';
  version: 1;
  createdAt: string;
  instruction: string;
  scene: ReturnType<typeof makeManifest>;
  review: GifMetadata;
};

export function makeAnimationFeedback(workspace: Workspace, review: GifMetadata, instruction: string): AnimationFeedback {
  if (review.motion !== 'animation' || !review.frames?.length) throw new Error('Render an authored timeline animation before sending feedback to Form.');
  const text = instruction.trim();
  if (!text || text.length > 4000) throw new Error('Describe the animation feedback in 1–4,000 characters.');
  return scrubCloudData({
    format: 'astra.animation-feedback', version: 1, createdAt: new Date().toISOString(),
    instruction: text, scene: makeManifest(workspace), review,
  }) as AnimationFeedback;
}
