import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,
  db_path             TEXT NOT NULL,
  repo_path_redacted  TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
`;

export interface SessionRegistryEntry {
  sessionId: string;
  dbPath: string;
  repoPathRedacted: string;
  createdAt: string;
  updatedAt: string;
}

/** Replaces the caller's home directory prefix with `~` so listings never leak the raw machine/user path. */
export function redactRepoPath(cwd: string): string {
  const home = homedir();
  return cwd === home || cwd.startsWith(home + "/") ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * Durable, cross-repository source of truth for resolving a sessionId to the SQLite events file
 * that holds it. This is what makes session discovery survive a process restart *and* work across
 * more than one repository — a server process no longer has to "remember" the last repo it touched.
 */
export class SessionRegistry {
  private db: Database.Database;

  constructor(registryPath: string) {
    mkdirSync(dirname(registryPath), { recursive: true });
    this.db = SessionRegistry.openOrRecover(registryPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /**
   * A registry file can be corrupted by a crash mid-write, disk failure, or a stray non-SQLite file
   * landing at the path. better-sqlite3 throws synchronously on open (bad header) or on the very
   * first statement (structurally corrupt but header-valid). Either way we must not crash the server:
   * quarantine the bad file and start a fresh registry, since it is rebuildable — every session also
   * lives in its own durable per-repo event log, so losing the discovery index is recoverable, not fatal.
   */
  private static openOrRecover(registryPath: string): Database.Database {
    if (!existsSync(registryPath)) return new Database(registryPath);
    try {
      const db = new Database(registryPath);
      const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (result.length !== 1 || result[0]?.integrity_check !== "ok") {
        db.close();
        throw new Error("registry integrity_check failed");
      }
      return db;
    } catch {
      const quarantinePath = `${registryPath}.corrupt-${Date.now()}`;
      renameSync(registryPath, quarantinePath);
      return new Database(registryPath);
    }
  }

  /** Idempotent: registering the same sessionId again just refreshes updated_at. */
  register(sessionId: string, dbPath: string, cwd: string): SessionRegistryEntry {
    const now = new Date().toISOString();
    const repoPathRedacted = redactRepoPath(cwd);
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, db_path, repo_path_redacted, created_at, updated_at)
         VALUES (@sessionId, @dbPath, @repoPathRedacted, @now, @now)
         ON CONFLICT(session_id) DO UPDATE SET db_path = excluded.db_path, updated_at = excluded.updated_at`
      )
      .run({ sessionId, dbPath, repoPathRedacted, now });
    return this.get(sessionId)!;
  }

  /** Bump updated_at without changing anything else — used to keep the most-recently-active session first. */
  touch(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").run(new Date().toISOString(), sessionId);
  }

  get(sessionId: string): SessionRegistryEntry | undefined {
    const row = this.db
      .prepare("SELECT session_id, db_path, repo_path_redacted, created_at, updated_at FROM sessions WHERE session_id = ?")
      .get(sessionId) as RegistryRow | undefined;
    return row ? this.toEntry(row) : undefined;
  }

  list(limit: number, offset: number): SessionRegistryEntry[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.min(Math.trunc(limit), 1000)) : 0;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    if (safeLimit === 0) return [];
    const rows = this.db
      .prepare("SELECT session_id, db_path, repo_path_redacted, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(safeLimit, safeOffset) as RegistryRow[];
    return rows.map((row) => this.toEntry(row));
  }

  close(): void {
    this.db.close();
  }

  private toEntry(row: RegistryRow): SessionRegistryEntry {
    return {
      sessionId: row.session_id,
      dbPath: row.db_path,
      repoPathRedacted: row.repo_path_redacted,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

interface RegistryRow {
  session_id: string;
  db_path: string;
  repo_path_redacted: string;
  created_at: string;
  updated_at: string;
}
