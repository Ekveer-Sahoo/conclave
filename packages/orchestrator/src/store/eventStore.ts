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

  /**
   * Runs `work` in one write transaction (BEGIN IMMEDIATE), so a read-check-append sequence cannot
   * interleave with another process's appends to the same store.
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }

  /** Replay every event for a session in seq order, validating each against the schema. */
  replay(sessionId: string): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT seq, session_id, ts, type, payload FROM events WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as { seq: number; session_id: string; ts: string; type: string; payload: string }[];
    return rows.map((row) => this.toStoredEvent(row));
  }

  /**
   * Events for a session strictly after `afterSeq`, in seq order, capped at `limit`. `seq` is a
   * global monotonic id (SQLite AUTOINCREMENT), so it doubles as the SSE Last-Event-ID: a client
   * can reconnect with the last id it saw and replay exactly the events it missed, with no gaps
   * or duplicates.
   */
  replaySince(sessionId: string, afterSeq: number, limit = 500, types?: readonly string[]): StoredEvent[] {
    // The type filter belongs in SQL: filtering after LIMIT would let a run of other event types
    // fill the page, returning an empty page mid-stream that a client reads as "no more events".
    const typeClause = types?.length ? ` AND type IN (${types.map(() => "?").join(", ")})` : "";
    const rows = this.db
      .prepare(`SELECT seq, session_id, ts, type, payload FROM events WHERE session_id = ? AND seq > ?${typeClause} ORDER BY seq ASC LIMIT ?`)
      .all(sessionId, afterSeq, ...(types ?? []), limit) as { seq: number; session_id: string; ts: string; type: string; payload: string }[];
    return rows.map((row) => this.toStoredEvent(row));
  }

  private toStoredEvent(row: { seq: number; session_id: string; ts: string; type: string; payload: string }): StoredEvent {
    const payload = JSON.parse(row.payload);
    const validated = EventEnvelopeSchema.parse({ type: row.type, payload });
    return { seq: row.seq, sessionId: row.session_id, ts: row.ts, type: validated.type, payload: validated.payload };
  }

  /** Distinct session ids, most-recently-active first, page-able for session history in the UI. */
  listSessions(limit?: number, offset = 0): string[] {
    const query =
      "SELECT session_id, MAX(seq) AS last_seq FROM events GROUP BY session_id ORDER BY last_seq DESC" +
      (typeof limit === "number" ? " LIMIT ? OFFSET ?" : "");
    const rows = (
      typeof limit === "number"
        ? this.db.prepare(query).all(limit, offset)
        : this.db.prepare(query).all()
    ) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  /** Aggregate BudgetSpent events by seat since the given ISO timestamp (inclusive). */
  usageSince(cutoffIso: string): Array<{ seat: string; promptTokens: number; completionTokens: number; costUsd: number }> {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE type = 'BudgetSpent' AND ts >= ?")
      .all(cutoffIso) as { payload: string }[];
    const bySeat = new Map<string, { promptTokens: number; completionTokens: number; costUsd: number }>();
    // A BudgetSpent without authoritative usage omits the numeric fields entirely. Summing those as
    // undefined would turn every total into NaN — and `NaN >= limit` is false, which would silently
    // disable spend-limit enforcement for the whole window. Absent means "nothing known", i.e. 0.
    const amount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { seat?: string; promptTokens?: number; completionTokens?: number; costUsd?: number };
      const seat = payload.seat ?? "(unattributed)";
      const entry = bySeat.get(seat) ?? { promptTokens: 0, completionTokens: 0, costUsd: 0 };
      entry.promptTokens += amount(payload.promptTokens);
      entry.completionTokens += amount(payload.completionTokens);
      entry.costUsd += amount(payload.costUsd);
      bySeat.set(seat, entry);
    }
    return [...bySeat.entries()].map(([seat, usage]) => ({ seat, ...usage }));
  }

  close(): void {
    this.db.close();
  }
}

export function newSessionId(): string {
  return randomUUID();
}
