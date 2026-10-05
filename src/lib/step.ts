import { finalizeAsset, type Asset, type AssetNode, type Vec3 } from './scene';

export type StepResult = {
  success: boolean;
  root: { name: string; meshes: number[]; children: StepResult['root'][] };
  meshes: { name?: string; color?: Vec3; attributes: { position: { array: number[] } }; index: { array: number[] } }[];
};
export type StepOptions = { upAxis: 'Z' | 'Y'; scale: number };
export function stepToAsset(result: StepResult, filename: string, digest: string, options: StepOptions, hasUnits = true): Asset {
  if (!result.success || !result.meshes?.length) throw new Error('STEP contains no renderable geometry.');
  if (!Number.isFinite(options.scale) || options.scale <= 0 || options.scale > 1e6) throw new Error('STEP scale correction must be greater than 0 and at most 1,000,000.');
  const id = `step-${digest}-${options.upAxis}-${options.scale}`;
  const scale = options.scale / 1000;
  const parts = result.meshes.map((mesh, index) => {
    const raw = mesh.attributes.position.array;
    const vertices: number[] = [];
    for (let i = 0; i < raw.length; i += 3) {
      if (options.upAxis === 'Z') vertices.push(raw[i] * scale, raw[i + 2] * scale, -raw[i + 1] * scale);
      else vertices.push(raw[i] * scale, raw[i + 1] * scale, raw[i + 2] * scale);
    }
    return { id: `${id}/part/${index}`, name: mesh.name || `Part ${index + 1}`, vertices, indices: mesh.index.array, color: mesh.color,
      metadata: { representation: 'STEP CAD surface', sourceIndex: String(index) } };
  });
  const hierarchy = (node: StepResult['root'], path: string): AssetNode => ({
    id: `${id}/node/${path}`, name: node.name || 'Assembly', partIds: node.meshes.map(i => parts[i]?.id).filter(Boolean),
    children: node.children.map((child, i) => hierarchy(child, `${path}/${i}`)),
  });
  return finalizeAsset({ id, name: filename.replace(/\.(step|stp)$/i, ''), source: { kind: 'step', filename, digest }, parts,
    hierarchy: hierarchy(result.root, '0'), warnings: hasUnits ? [] : ['No explicit STEP length unit was detected. OpenCascade defaults to millimeters; use scale correction if dimensions are wrong.'] });
}

export async function convertStep(bytes: ArrayBuffer, onProgress: (message: string) => void): Promise<StepResult> {
  const header = new TextDecoder().decode(bytes.slice(0, 4096));
  if (!header.includes('ISO-10303-21;')) throw new Error('Not a STEP Part 21 file (missing ISO-10303-21 header).');
  return new Promise((resolve, reject) => {
    const worker = new Worker('/step-worker.js');
    const stop = () => { clearTimeout(timeout); worker.terminate(); };
    const timeout = setTimeout(() => { stop(); reject(new Error('STEP conversion timed out after 120 seconds. Try a simpler model.')); }, 120_000);
    worker.onerror = () => { stop(); reject(new Error('CAD worker failed. Check that npm install completed and retry with a smaller STEP file.')); };
    worker.onmessage = ({ data }) => {
      if (data.status) onProgress(data.status);
      if (data.error) { stop(); reject(new Error(data.error)); }
      if (data.result) { stop(); resolve(data.result); }
    };
    worker.postMessage({ bytes }, [bytes]);
  });
}
