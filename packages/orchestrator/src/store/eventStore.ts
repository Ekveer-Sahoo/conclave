import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { EventEnvelopeSchema, type EventEnvelope, type StoredEvent } from "@conclave/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
`;

/**
 * Append-only event log. The single source of truth per the plan's
 * event-sourced data model — projections are always rebuilt from this table,
 * never written to directly.
 */
export class EventStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  append(sessionId: string, event: EventEnvelope): StoredEvent {
    const parsed = EventEnvelopeSchema.parse(event);
    const ts = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT INTO events (session_id, ts, type, payload) VALUES (?, ?, ?, ?)"
    );
    const info = stmt.run(sessionId, ts, parsed.type, JSON.stringify(parsed.payload));
    return { seq: Number(info.lastInsertRowid), sessionId, ts, type: parsed.type, payload: parsed.payload };
  }

  /** Replay every event for a session in seq order, validating each against the schema. */
  replay(sessionId: string): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT seq, session_id, ts, type, payload FROM events WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as { seq: number; session_id: string; ts: string; type: string; payload: string }[];

    return rows.map((row) => {
      const payload = JSON.parse(row.payload);
      const validated = EventEnvelopeSchema.parse({ type: row.type, payload });
      return {
        seq: row.seq,
        sessionId: row.session_id,
        ts: row.ts,
        type: validated.type,
        payload: validated.payload,
      };
    });
  }

  listSessions(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT session_id FROM events ORDER BY session_id")
      .all() as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  close(): void {
    this.db.close();
  }
}

export function newSessionId(): string {
  return randomUUID();
}
