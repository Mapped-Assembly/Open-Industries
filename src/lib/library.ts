import type { Asset } from './scene';
import type { GifMetadata } from './gif';

export type LibraryEntry = { id: string; asset: Asset; updatedAt: number; preview?: Blob; previewMetadata?: GifMetadata };
const DB = 'astra-asset-library';
async function openLibrary(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('assets', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open the local asset library. Check browser storage permissions.'));
    request.onblocked = () => reject(new Error('Close other Mergence tabs and retry opening the asset library.'));
  });
}
async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('assets', mode);
    const request = operation(tx.objectStore('assets'));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = () => { db.close(); reject(new Error('Could not update the asset library. Browser storage may be full or unavailable.')); };
    tx.onerror = () => { /* onabort reports failure after rollback */ };
  });
}
export async function listLibrary(): Promise<LibraryEntry[]> {
  const entries = await transaction('readonly', store => store.getAll());
  return (entries as LibraryEntry[]).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function saveLibrary(entry: LibraryEntry) {
  await transaction('readwrite', store => store.put(entry));
}
export async function deleteLibrary(id: string) {
  await transaction('readwrite', store => store.delete(id));
}
