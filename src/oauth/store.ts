import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { fail, index, seal, unseal } from "./crypto.js";
import { type Keys, privatePath, statePath } from "./keys.js";

type Row = {
  id: string;
  model: string;
  expires: number;
  payload: Uint8Array;
  consumed: number;
};
export type RecordValue = Record<string, unknown>;
const MAX_BYTES = 32 * 1024 * 1024;
export class Store {
  private db: DatabaseSync;
  private depth = 0;
  private closed = false;
  readonly file: string;
  constructor(
    readonly dir: string,
    private keys: Keys,
    readonly now = () => Date.now(),
  ) {
    this.file = statePath(dir);
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(this.file + suffix))
        privatePath(this.file + suffix, false);
    const old = process.umask(0o077);
    try {
      this.db = new DatabaseSync(this.file, {
        allowExtension: false,
        timeout: 1000,
      });
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=4096; PRAGMA journal_size_limit=8388608;",
      );
      const version = this.db
        .prepare("PRAGMA user_version")
        .get()?.user_version;
      if (version !== 0 && version !== 1) fail();
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS records (model TEXT NOT NULL,id TEXT NOT NULL,expires INTEGER NOT NULL,payload BLOB NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(model,id)); CREATE TABLE IF NOT EXISTS links(model TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(model,id,kind)); CREATE INDEX IF NOT EXISTS lookup ON links(model,kind,value); PRAGMA user_version=1;",
      );
      this.db.enableLoadExtension(false);
      this.db.setAuthorizer((action) =>
        [
          constants.SQLITE_ATTACH,
          constants.SQLITE_DETACH,
          constants.SQLITE_PRAGMA,
        ].includes(action)
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      chmodSync(this.file, 0o600);
      if (this.get("KeyCheck", "key")) {
        /* authenticated read verified keys */
      } else if (this.count() === 0)
        this.put("KeyCheck", "key", { valid: true }, Number.MAX_SAFE_INTEGER);
      else fail();
    } catch {
      // The constructor may throw before assigning a handle.
      if (Object.hasOwn(this, "db")) this.close();
      fail();
    } finally {
      process.umask(old);
    }
  }
  private digest(model: string, id: string) {
    return index(this.keys.lookup, `${model}:${id}`);
  }
  private aad(model: string, id: string, expires: number) {
    return `1:${model}:${id}:${expires}`;
  }
  private check() {
    if (this.closed) fail();
  }
  transaction<T>(fn: () => T): T {
    this.check();
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }
  count() {
    return Number(
      this.db.prepare("SELECT count(*) AS n FROM records").get()?.n,
    );
  }
  private capacity(newRecord: boolean, internal: boolean) {
    let size = 0;
    for (const f of readdirSync(this.dir)) {
      if (
        ![
          "authorization.sqlite",
          "authorization.sqlite-wal",
          "authorization.sqlite-shm",
        ].includes(f)
      )
        fail();
      const stat = lstatSync(join(this.dir, f));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) fail();
      size += stat.size;
    }
    if (
      !internal &&
      ((newRecord && this.count() >= 1000) || size >= MAX_BYTES - 1024 * 1024)
    )
      fail();
    if (size >= MAX_BYTES) fail();
  }
  get(model: string, id: string): RecordValue | undefined {
    this.check();
    const digest = this.digest(model, id);
    const row = this.db
      .prepare("SELECT * FROM records WHERE model=? AND id=?")
      .get(model, digest) as Row | undefined;
    if (!row || row.expires <= this.now()) return;
    const value = unseal(
      this.keys.encryption,
      this.aad(model, digest, row.expires),
      row.payload,
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    return {
      ...(value as RecordValue),
      ...(row.consumed ? { consumed: row.consumed } : {}),
    };
  }
  put(
    model: string,
    id: string,
    value: RecordValue,
    expires: number,
    links: Record<string, string> = {},
    internal = false,
  ) {
    if (!Number.isSafeInteger(expires) || expires <= this.now()) fail();
    return this.transaction(() => {
      this.cleanup();
      const digest = this.digest(model, id);
      const existing = this.db
        .prepare("SELECT 1 FROM records WHERE model=? AND id=?")
        .get(model, digest);
      this.capacity(!existing, internal);
      const payload = seal(
        this.keys.encryption,
        this.aad(model, digest, expires),
        value,
      );
      this.db
        .prepare(
          "INSERT INTO records(model,id,expires,payload) VALUES(?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET expires=excluded.expires,payload=excluded.payload",
        )
        .run(model, digest, expires, payload);
      this.db
        .prepare("DELETE FROM links WHERE model=? AND id=?")
        .run(model, digest);
      for (const [kind, v] of Object.entries(links))
        this.db
          .prepare("INSERT INTO links VALUES(?,?,?,?)")
          .run(model, digest, kind, this.digest(kind, v));
    });
  }
  find(model: string, kind: string, value: string) {
    const row = this.db
      .prepare(
        "SELECT r.* FROM records r JOIN links l ON r.model=l.model AND r.id=l.id WHERE l.model=? AND l.kind=? AND l.value=?",
      )
      .get(model, kind, this.digest(kind, value)) as Row | undefined;
    if (!row || row.expires <= this.now()) return;
    const v = unseal(
      this.keys.encryption,
      this.aad(model, row.id, row.expires),
      row.payload,
    );
    return {
      ...(v as RecordValue),
      ...(row.consumed ? { consumed: row.consumed } : {}),
    };
  }
  consume(model: string, id: string) {
    this.transaction(() => {
      const r = this.db
        .prepare(
          "UPDATE records SET consumed=? WHERE model=? AND id=? AND consumed=0 AND expires>?",
        )
        .run(
          Math.floor(this.now() / 1000),
          model,
          this.digest(model, id),
          this.now(),
        );
      if (r.changes !== 1) fail();
    });
  }
  insert(model: string, id: string, value: RecordValue, expires: number) {
    this.transaction(() => {
      if (this.get(model, id)) fail();
      this.put(model, id, value, expires);
    });
  }
  remove(model: string, id: string) {
    this.transaction(() => {
      const d = this.digest(model, id);
      this.db.prepare("DELETE FROM links WHERE model=? AND id=?").run(model, d);
      this.db
        .prepare("DELETE FROM records WHERE model=? AND id=?")
        .run(model, d);
    });
  }
  revoke(grantId: string) {
    this.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM records WHERE (model,id) IN (SELECT model,id FROM links WHERE kind='grantId' AND value=?)",
        )
        .run(this.digest("grantId", grantId));
      this.db
        .prepare(
          "DELETE FROM links WHERE NOT EXISTS (SELECT 1 FROM records r WHERE r.model=links.model AND r.id=links.id)",
        )
        .run();
      this.remove("Grant", grantId);
    });
  }
  clearAuthorization() {
    this.transaction(() => {
      this.db.prepare("DELETE FROM records WHERE model != 'KeyCheck'").run();
      this.db.exec("DELETE FROM links");
    });
  }
  // Bounded encrypted application records. Never expose database handles or
  // hashed lookup keys; hosted lifecycle records carry their own opaque IDs.
  values(model: string): RecordValue[] {
    this.check();
    const rows = this.db.prepare("SELECT * FROM records WHERE model=? AND expires>? LIMIT 1001")
      .all(model, this.now()) as Row[];
    if (rows.length > 1000) fail();
    return rows.map(row => unseal(this.keys.encryption,
      this.aad(model, row.id, row.expires), row.payload) as RecordValue);
  }
  cleanup() {
    this.db
      .prepare(
        "DELETE FROM records WHERE rowid IN (SELECT rowid FROM records WHERE expires<=? LIMIT 100)",
      )
      .run(this.now());
    this.db
      .prepare(
        "DELETE FROM links WHERE NOT EXISTS (SELECT 1 FROM records r WHERE r.model=links.model AND r.id=links.id)",
      )
      .run();
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
