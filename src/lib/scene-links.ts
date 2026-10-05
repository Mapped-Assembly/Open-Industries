export type SceneLink = { id: string; revision?: number; token?: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Query routing works on both static hosts and the local workbench server. */
export function readSceneLink(url: URL): SceneLink | null {
  if (!url.searchParams.has('sceneId')) return null;
  const id = url.searchParams.get('sceneId')!;
  const rawRevision = url.searchParams.get('revision');
  const revision = rawRevision === null ? undefined : Number(rawRevision);
  const token = new URLSearchParams(url.hash.slice(1)).get('share') ?? undefined;
  if (!uuid.test(id) || (rawRevision !== null && (!/^[1-9]\d*$/.test(rawRevision) || !Number.isSafeInteger(revision) || revision! > 2147483647))
    || (token !== undefined && (!/^[a-f0-9]{64}$/.test(token) || revision === undefined))) throw new Error('Invalid scene link. Ask the owner for a new URL.');
  return { id, revision, token };
}
export function sceneURLs(id: string, revision: number, base?: string) {
  const head = `/?sceneId=${encodeURIComponent(id)}`;
  const pinned = `${head}&revision=${revision}`;
  return { head_url: base ? new URL(head, base).href : head, revision_url: base ? new URL(pinned, base).href : pinned };
}
