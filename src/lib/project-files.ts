import type { Asset } from './scene';
import { scrubPortableData } from './portable-data.mjs';
import { makeManifest, type Workspace } from './workspace';

export function projectFilename(name: string, kind: 'oi' | 'forma') {
  const stem = name.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project';
  return `${stem}.${kind}.json`;
}

// Forma's own JSON download is the Hardware IR, not a room/scene wrapper.
export function formaProjectJSON(asset: Asset): string {
  const project = asset.formProject;
  if (!project) throw new Error('Select a Forma equipment project to export.');
  const ir = { ...project.ir,
    // Namespace metadata may carry a null revision; raw IR requires a revision label or number.
    ...(project.revision ? { revision: project.revision } : {}),
    ...(project.agent ? { agent: project.agent } : {}),
    ...(project.artifacts?.length ? { artifacts: project.artifacts } : {}),
    assembly_metadata: { ...project.ir.assembly_metadata,
      ...(project.projectId ? { project_id: project.projectId } : {}),
    },
  };
  return JSON.stringify(scrubPortableData(ir), null, 2);
}

export function oiProjectJSON(workspace: Workspace): string {
  // Keep the existing versioned contract so old scene files, CLI and MCP still work.
  const json = JSON.stringify(makeManifest(workspace, true));
  if (new Blob([json]).size > 75 * 1024 * 1024) throw new Error('This OI project exceeds the 75 MiB import limit. Split it into smaller projects before exporting.');
  return json;
}

export function downloadProject(json: string, filename: string) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
