import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
const authorityFail = (code) => {
  throw new AuthorityError(code);
};
/** Native authentication errors carry only stable public codes. */
export class AuthorityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = 'AuthorityError';
  }
}

const derive = promisify(scrypt);
const hash = (value) => createHash('sha256').update(value).digest('hex');
/** Shared native account/session authority. Domains choose supported database versions. */
export class SqliteAuthority {
  constructor(path, { clock = Date.now, supportedVersions = [0] } = {}) {
    this.clock = clock;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
    );
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (!supportedVersions.includes(version)) {
      this.db.close();
      throw new Error(
        'UNSUPPORTED_SQLITE_SCHEMA: restore a compatible backup or use the runtime that wrote this database; no upgrade was attempted.',
      );
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(id),expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner);
      CREATE TABLE IF NOT EXISTS runtime(id INTEGER PRIMARY KEY CHECK(id=1),heartbeat INTEGER);
      INSERT OR IGNORE INTO runtime VALUES(1,NULL);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async authenticate(credentials, register = false) {
    if (
      !credentials ||
      Object.keys(credentials).sort().join(',') !== 'password,username' ||
      typeof credentials.username !== 'string' ||
      !/^[a-zA-Z0-9_-]{3,40}$/.test(credentials.username) ||
      typeof credentials.password !== 'string' ||
      credentials.password.length < 12 ||
      credentials.password.length > 256
    )
      authorityFail('AUTH_REQUIRED');
    const username = credentials.username.toLowerCase();
    const account = this.db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
    const salt = register || !account ? randomBytes(16).toString('hex') : account.salt;
    const password = await derive(credentials.password, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return this.transaction(() => {
      let owner = account?.id;
      if (register) {
        if (
          this.db.prepare('SELECT 1 FROM accounts WHERE username=?').get(username) ||
          this.db.prepare('SELECT count(*) n FROM accounts').get().n >= 1000
        )
          authorityFail('AUTH_REQUIRED');
        owner = randomUUID();
        this.db
          .prepare('INSERT INTO accounts VALUES(?,?,?,?)')
          .run(owner, username, salt, password.toString('hex'));
      } else if (!account || !timingSafeEqual(password, Buffer.from(account.password_hash, 'hex')))
        authorityFail('AUTH_REQUIRED');
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.clock());
      if (this.db.prepare('SELECT count(*) n FROM sessions WHERE owner=?').get(owner).n >= 16)
        authorityFail('LIMIT_REACHED');
      const token = randomBytes(32).toString('hex'),
        expires = this.clock() + 8 * 60 * 60 * 1000;
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), owner, expires);
      return { token, expires_at_ms: expires };
    });
  }

  /** Resolve the current native session; callers never supply a trusted principal directly. @param {unknown} token @returns {string} */
  identity(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) authorityFail('AUTH_REQUIRED');
    const session = this.db
      .prepare('SELECT owner FROM sessions WHERE token_hash=? AND expires>?')
      .get(hash(token), this.clock());
    if (!session || typeof session.owner !== 'string') authorityFail('AUTH_REQUIRED');
    return session.owner;
  }

  logout(token) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token || ''));
  }

  healthy() {
    const heartbeat = this.db.prepare('SELECT heartbeat FROM runtime WHERE id=1').get().heartbeat;
    return heartbeat !== null && Math.abs(this.clock() - heartbeat) <= 15000;
  }

  close() {
    this.db.close();
  }
}
