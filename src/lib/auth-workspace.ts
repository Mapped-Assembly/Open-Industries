import type { Asset, Vec3 } from './scene';
import type { Workspace } from './workspace';

type Snapshot = { assets: Asset[]; room: number[]; selected: number; positions?: Vec3[]; workspace?: Workspace; savedAt: number };
const TAB_KEY = 'astra-oauth-workspace';
async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('astra-oauth-workspace', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Cannot preserve the room for sign-in. Enable browser storage and retry.'));
  });
}
async function transact<T>(db: IDBDatabase, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite');
    const request = action(tx.objectStore('snapshots'));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = () => { db.close(); reject(new Error('Could not preserve the room for sign-in. Browser storage may be full.')); };
  });
}
export async function preserveAuthWorkspace(assets: Asset[], room: number[], selected: number, positions: Vec3[], workspace?: Workspace) {
  const key = sessionStorage.getItem(TAB_KEY) || crypto.randomUUID();
  sessionStorage.setItem(TAB_KEY, key);
  await transact(await openDatabase(), store => store.put({ assets, room, selected, positions, workspace, savedAt: Date.now() } satisfies Snapshot, key));
}
export async function restoreAuthWorkspace(): Promise<Snapshot | null> {
  const key = sessionStorage.getItem(TAB_KEY);
  if (!key) return null;
  const snapshot: Snapshot | undefined = await transact(await openDatabase(), store => store.get(key));
  await transact(await openDatabase(), store => store.delete(key));
  sessionStorage.removeItem(TAB_KEY);
  return snapshot && Date.now() - snapshot.savedAt < 3_600_000 ? snapshot : null;
}
