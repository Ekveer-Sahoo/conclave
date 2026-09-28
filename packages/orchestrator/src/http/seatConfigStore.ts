import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CLI_SEATS, SeatConfigSchema, type SeatConfig } from "@conclave/core";

export interface SeatConfigSnapshot {
  version: number;
  seats: SeatConfig[];
}

/**
 * Durable, versioned storage for the seat configuration used to start new sessions. Backed by a
 * single JSON file written atomically (write-to-tmp + rename), so a crash mid-write never leaves
 * a corrupt config and a restart always resumes from the last saved version instead of silently
 * reverting to defaults via in-memory module state.
 */
export class SeatConfigStore {
  private readonly path: string;
  private cached: SeatConfigSnapshot;
  /** Why an existing config file was rejected in favor of the defaults, if it was. */
  private loadProblem: string | undefined;

  constructor(path: string) {
    this.path = path;
    this.cached = this.load();
  }

  private load(): SeatConfigSnapshot {
    const defaults = (): SeatConfigSnapshot => ({ version: 0, seats: DEFAULT_CLI_SEATS.map((seat) => ({ ...seat })) });
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return defaults(); // No durable config on disk yet.
    }
    try {
      const raw = JSON.parse(text) as { version?: unknown; seats?: unknown };
      if (!raw || typeof raw !== "object" || typeof raw.version !== "number" || !Array.isArray(raw.seats)) {
        throw new Error('expected {"version": <number>, "seats": [...]}');
      }
      // Validated here, at load time, so a typo (an unknown adapter, a missing field) is reported by
      // `doctor` and the web UI rather than surfacing as a crash halfway through a council run.
      const seats = SeatConfigSchema.array().parse(raw.seats);
      return { version: raw.version, seats };
    } catch (error) {
      this.loadProblem = `${this.path} is invalid and was ignored in favor of the default seats: ${error instanceof Error ? error.message : String(error)}`;
      return defaults();
    }
  }

  get(): SeatConfigSnapshot {
    return this.cached;
  }

  problem(): string | undefined {
    return this.loadProblem;
  }

  save(seats: SeatConfig[]): SeatConfigSnapshot {
    const next: SeatConfigSnapshot = { version: this.cached.version + 1, seats };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.path);
    this.cached = next;
    this.loadProblem = undefined;
    return next;
  }
}
