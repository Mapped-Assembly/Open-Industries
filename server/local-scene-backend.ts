import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCloudBundle, type CloudVersion } from '../src/lib/cloud-storage.ts';
import type { Asset } from '../src/lib/scene.ts';
import { canonicalJSON, hydrateManifest, makeManifest, readManifest, type SceneManifest } from '../src/lib/workspace.ts';
import type { AssetSummary, SavedScene, SceneBackend, SceneDocument } from './scene-backend.ts';
import { SceneToolError } from './mcp-scene-contract.mjs';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const unavailable = (): never => { throw new SceneToolError('SCENE_UNAVAILABLE', 'Local scene or revision not found.'); };
/** Single-user local persistence. SQLite serializes writers; blobs are immutable and hash checked. */
export class LocalSceneBackend implements SceneBackend {
  readonly kind = 'local';
  private readonly db: DatabaseSync;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(join(this.directory, 'assets'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.directory, 'scenes.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
    if (version !== 0 && version !== 1) { this.db.close(); throw new SceneToolError('CONFIGURATION', 'Unsupported local scene database version.'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenes(id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(scene_id TEXT NOT NULL REFERENCES scenes(id), revision INTEGER NOT NULL,
        write_id TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL, PRIMARY KEY(scene_id,revision));
      PRAGMA user_version=1;
    `);
  }
  /** Release handles after each CLI/MCP operation so subsequent processes can reopen the store. */
  close(): void { this.db.close(); }
  async head(id: string): Promise<SavedScene | null> {
    const row = this.db.prepare('SELECT snapshot FROM revisions JOIN scenes ON scenes.id=revisions.scene_id AND scenes.revision=revisions.revision WHERE scenes.id=?').get(id);
    return row ? JSON.parse(String(row.snapshot)) : null;
  }
  async read(id: string, revision?: number): Promise<SavedScene> {
    if (revision === undefined) return (await this.head(id)) ?? unavailable();
    const row = this.db.prepare('SELECT snapshot FROM revisions WHERE scene_id=? AND revision=?').get(id, revision);
    return row ? JSON.parse(String(row.snapshot)) : unavailable();
  }
  /** Commit the head, immutable snapshot and retry receipt in one transaction. */
  async save(id: string, name: string, document: SceneDocument, base: number, writeId: string): Promise<SavedScene> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.db.prepare('SELECT snapshot FROM revisions WHERE write_id=?').get(writeId);
      if (receipt) {
        const saved: SavedScene = JSON.parse(String(receipt.snapshot));
        if (saved.id !== id || saved.document.authoring.request_digest !== document.authoring.request_digest)
          throw new SceneToolError('REQUEST_ID_REUSED', 'This request ID already names a different write.');
        this.db.exec('COMMIT'); return saved;
      }
      const head = this.db.prepare('SELECT revision FROM scenes WHERE id=?').get(id);
      if ((!head && base !== 0) || (head && head.revision !== base))
        throw new SceneToolError(head ? 'CONFLICT' : 'SCENE_UNAVAILABLE', 'Read the current scene before retrying.', head ? { current_revision: head.revision } : {});
      for (const instance of document.instances) {
        if (!instance.cloudVersionId || !this.db.prepare('SELECT id FROM assets WHERE id=?').get(instance.cloudVersionId))
          throw new SceneToolError('MISSING_ASSETS', 'A referenced local asset version is missing.');
      }
      const saved: SavedScene = { id, name, revision: base + 1, last_write_id: writeId, document };
      this.db.prepare('INSERT INTO scenes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision').run(id, saved.revision);
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(id, saved.revision, writeId, JSON.stringify(saved));
      this.db.exec('COMMIT'); return saved;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async list(offset: number): Promise<AssetSummary[]> {
    return this.db.prepare('SELECT metadata FROM assets ORDER BY id LIMIT 25 OFFSET ?').all(offset).map(row => {
      const version: CloudVersion = JSON.parse(String(row.metadata));
      return { id: version.id, asset: version.asset! };
    });
  }
  async asset(id: string): Promise<CloudVersion | null> {
    const row = this.db.prepare('SELECT metadata FROM assets WHERE id=?').get(id);
    return row ? JSON.parse(String(row.metadata)) : null;
  }
  async geometry(version: CloudVersion): Promise<string> {
    const file = version.files.find(file => file.name === 'asset.json');
    if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || file.size > 25 * 1024 * 1024)
      throw new SceneToolError('ASSET_UNAVAILABLE', 'Invalid local asset metadata.');
    const path = join(this.directory, 'assets', `${file.sha256}.json`);
    if (statSync(path).size !== file.size) throw new SceneToolError('ASSET_UNAVAILABLE', 'Local geometry size mismatch.');
    const text = readFileSync(path, 'utf8');
    if (sha256(text) !== file.sha256) throw new SceneToolError('ASSET_UNAVAILABLE', 'Local geometry checksum mismatch.');
    return text;
  }
  /** Validate and sanitize a bundle before storing geometry; repeated imports deduplicate. */
  async persistAsset(input: Asset): Promise<string> {
    const asset = parseCloudBundle(JSON.stringify({ schemaVersion: 1, asset: input })).asset;
    const text = canonicalJSON({ schemaVersion: 1, asset }), fingerprint = sha256(text);
    if (Buffer.byteLength(text) > 25 * 1024 * 1024) throw new SceneToolError('PAYLOAD_TOO_LARGE', 'Local geometry exceeds 25 MiB.');
    const path = join(this.directory, 'assets', `${fingerprint}.json`);
    // Serialize blob publication with metadata across local processes. A failed write never creates a ready version.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      try { writeFileSync(path, text, { flag: 'wx', mode: 0o600, flush: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (statSync(path).size !== Buffer.byteLength(text) || sha256(readFileSync(path, 'utf8')) !== fingerprint)
        throw new SceneToolError('ASSET_UNAVAILABLE', 'Existing local geometry is corrupt; restore it from backup.');
      const version: CloudVersion = { id: randomUUID(), owner_id: 'local', asset_id: asset.id, state: 'ready', fingerprint,
        files: [{ name: 'asset.json', mime: 'application/json', size: Buffer.byteLength(text), sha256: fingerprint }],
        created_at: new Date().toISOString(), asset: { name: asset.name, asset_key: asset.id, source_kind: asset.source.kind } };
      this.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?)').run(version.id, fingerprint, JSON.stringify(version));
      const id = String(this.db.prepare('SELECT id FROM assets WHERE fingerprint=?').get(fingerprint)!.id);
      this.db.exec('COMMIT'); return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Local identifiers deliberately do not masquerade as Supabase workbench links. */
  urls(id: string, revision: number): { head_url: string; revision_url: string } {
    return { head_url: `oi-local://scene/${id}`, revision_url: `oi-local://scene/${id}?revision=${revision}` };
  }
  /** Produce the existing portable scene format, including verified geometry and authoring provenance. */
  async exportScene(id: string, revision?: number): Promise<SceneManifest & { authoring: SceneDocument['authoring'] }> {
    const saved = await this.read(id, revision), manifest = readManifest(saved.document);
    const versions = new Map<string, Asset>();
    for (const instance of manifest.instances) {
      const versionId = instance.cloudVersionId!;
      if (versions.has(versionId)) continue;
      const version = await this.asset(versionId);
      if (!version) throw new SceneToolError('MISSING_ASSETS', 'Local geometry metadata is missing.');
      versions.set(versionId, parseCloudBundle(await this.geometry(version)).asset);
    }
    return { ...makeManifest(hydrateManifest(manifest, [], versions), true), authoring: saved.document.authoring };
  }
}
