import { cadFileReference, importForm, readFormDocument } from './form';
import { checkFile, digestBytes, type Asset } from './scene';
import { convertStep, stepToAsset, type StepOptions, type StepResult } from './step';

// References address selected files, never URLs or paths on the author's machine.
// Do not turn an inaccessible path into a basename match.
function localPath(value: string | undefined): string | undefined {
  if (!value) return;
  const path = value.replace(/\\/g, '/');
  if (/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(path) || /[\x00-\x1f]/.test(path)) return;
  const segments = path.split('/').filter(part => part && part !== '.');
  if (!segments.length || segments.includes('..')) return;
  return segments.join('/');
}

function matchCAD(project: File, reference: string | undefined, files: File[]): File | undefined {
  const path = localPath(reference);
  if (!path) return;
  const directory = localPath(project.webkitRelativePath)?.split('/').slice(0, -1).join('/');
  const target = directory ? `${directory}/${path}` : path;
  const exact = files.filter(file => localPath(file.webkitRelativePath || file.name) === target);
  // Folder paths are authoritative. An absent sibling must not silently bind to
  // another directory/project. Loose files still support the ordinary file picker.
  const fallback = files.filter(file => (!directory || !file.webkitRelativePath) && file.name === path.split('/').pop());
  const candidates = exact.length ? exact : fallback;
  if (candidates.length > 1) throw new Error(`Multiple files match ${reference}. Select only the intended CAD artifact.`);
  return candidates[0];
}

// Cache final assets, not the much larger source + intermediate CAD representations.
export class ImportService {
  private cache = new Map<string, Asset>();
  constructor(private converter: typeof convertStep = convertStep) {}

  async step(file: File, options: StepOptions, progress: (message: string) => void): Promise<Asset> {
    checkFile(file);
    const bytes = await file.arrayBuffer();
    const digest = await digestBytes(bytes);
    const key = `${digest}/${options.upAxis}/${options.scale}`;
    const cached = this.cache.get(key);
    if (cached) { progress('Reusing converted geometry…'); return { ...cached, name: file.name.replace(/\.(step|stp)$/i, ''), source: { ...cached.source, filename: file.name } }; }
    const hasUnits = /SI_UNIT\s*\([^)]*\.METRE\.|CONVERSION_BASED_UNIT\s*\(/i.test(new TextDecoder().decode(bytes));
    const result: StepResult = await this.converter(bytes, progress);
    const asset = stepToAsset(result, file.name, digest, options, hasUnits);
    if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, asset);
    return asset;
  }

  async files(files: File[], options: StepOptions, progress: (message: string) => void): Promise<Asset[]> {
    const inputs = files.filter(f => /\.(json|step|stp)$/i.test(f.name));
    if (!inputs.length) throw new Error('Choose a Form .json project or a .step / .stp file.');
    if (inputs.reduce((sum, f) => sum + f.size, 0) > 75 * 1024 * 1024) throw new Error('Import batch exceeds 75 MiB. Import fewer files at a time.');
    const jsonFiles = inputs.filter(f => /\.json$/i.test(f.name));
    // A folder may contain unrelated JSON; the canonical manifest is its entry point.
    const isManifest = (file: File) => /^(form|forma)-project\.json$/i.test(file.name);
    const projects = jsonFiles.some(isManifest) ? jsonFiles.filter(isManifest) : jsonFiles;
    const used = new Set<File>();
    const assets: Asset[] = [];
    for (const file of projects) {
      checkFile(file);
      progress(`Reading ${file.name}…`);
      const bytes = await file.arrayBuffer();
      let input: unknown;
      try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`${file.name} is not valid JSON.`); }
      const digest = await digestBytes(bytes);
      const doc = readFormDocument(input, file.name);
      const reference = cadFileReference(doc.cad);
      const cadInputs = inputs.filter(f => /\.(step|stp)$/i.test(f.name));
      const cad = matchCAD(file, reference, cadInputs);
      if (cad) {
        const exactDeclarations = doc.artifacts.filter(a => localPath(a.path) === localPath(reference));
        const declarations = exactDeclarations.length ? exactDeclarations : doc.artifacts.filter(a => localPath(a.path)?.split('/').pop() === cad.name);
        if (declarations.length > 1) throw new Error(`Ambiguous artifact declarations for ${cad.name}.`);
        const declaration = declarations[0];
        if (declaration?.sha256 !== undefined && declaration.sha256.toLowerCase() !== await digestBytes(await cad.arrayBuffer())) {
          throw new Error(`Integrity check failed for ${cad.name}: bytes do not match the Form manifest SHA-256.`);
        }
        // Form mechanical data is always Z-up; standalone STEP options do not change that contract.
        const geometry = await this.step(cad, { upAxis: 'Z', scale: 1 }, progress);
        assets.push({ ...geometry, id: `form-${digest}-${geometry.source.digest}`, name: doc.name,
          formProject: doc.project,
          source: { kind: 'form', filename: file.name, digest, projectId: doc.projectId, version: doc.version } });
        used.add(cad);
      } else {
        assets.push(importForm(input, file.name, digest));
      }
    }
    for (const file of inputs.filter(f => /\.(step|stp)$/i.test(f.name) && !used.has(f))) assets.push(await this.step(file, options, progress));
    return assets;
  }
}
