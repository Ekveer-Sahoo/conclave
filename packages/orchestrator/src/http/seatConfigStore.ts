import { copyFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CLI_SEATS, SeatConfigSchema, type SeatConfig } from "@conclave/core";

export interface SeatConfigSnapshot {
  version: number;
  seats: SeatConfig[];
}

/** The file on disk is invalid; saving over it would silently replace the operator's seats. */
export class SeatConfigInvalidError extends Error {}

/** The file changed since the caller read it (another process saved); the save was not written. */
export class SeatConfigConflictError extends Error {}

const KNOWN_SEAT_KEYS = new Set(Object.keys(SeatConfigSchema.shape));

/**
 * Durable, versioned storage for the seat configuration used to start new sessions. Backed by a
 * single JSON file written atomically (write-to-tmp + rename), so a crash mid-write never leaves
 * a corrupt config and a restart always resumes from the last saved version instead of silently
 * reverting to defaults via in-memory module state.
 *
 * The CLI and the web server share this file, so every read checks whether it changed on disk
 * since it was loaded, and a save is refused when it would overwrite a newer version or an
 * invalid file the operator has not seen reported.
 */
export class SeatConfigStore {
  private readonly path: string;
  private cached!: SeatConfigSnapshot;
  /** Why an existing config file was rejected in favor of the defaults, if it was. */
  private loadProblem: string | undefined;
  /** Keys in the file that no seat setting has (usually typos); they have no effect. */
  private loadWarnings: string[] = [];
  /** The version number an invalid file claimed, so a replacement never goes backwards. */
  private invalidVersion = 0;
  /** mtime and size of the file when it was last read; "missing" when there was none. */
  private stamp = "";

  constructor(path: string) {
    this.path = path;
    this.reload();
  }

  private currentStamp(): string {
    try {
      const stat = statSync(this.path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  private reload(): void {
    this.stamp = this.currentStamp();
    this.loadProblem = undefined;
    this.loadWarnings = [];
    this.invalidVersion = 0;
    this.cached = this.load();
  }

  /** Picks up a save made by another process (the CLI while the web server runs, or vice versa). */
  private refresh(): void {
    if (this.currentStamp() !== this.stamp) this.reload();
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
      if (raw && typeof raw === "object" && typeof raw.version === "number" && Number.isFinite(raw.version)) this.invalidVersion = raw.version;
      if (!raw || typeof raw !== "object" || typeof raw.version !== "number" || !Array.isArray(raw.seats)) {
        throw new Error('expected {"version": <number>, "seats": [...]}');
      }
      // Validated here, at load time, so a typo (an unknown adapter, a missing field) is reported by
      // `doctor` and the web UI rather than surfacing as a crash halfway through a council run.
      const seats = SeatConfigSchema.array().parse(raw.seats);
      for (const entry of raw.seats as unknown[]) {
        if (!entry || typeof entry !== "object") continue;
        const unknown = Object.keys(entry).filter((key) => !KNOWN_SEAT_KEYS.has(key));
        const id = (entry as { id?: unknown }).id;
        if (unknown.length) this.loadWarnings.push(`seat "${String(id)}" has unknown setting(s) ${unknown.join(", ")}, which are ignored (a typo?)`);
      }
      this.invalidVersion = 0;
      return { version: raw.version, seats };
    } catch (error) {
      this.loadProblem = `${this.path} is invalid and was ignored in favor of the default seats: ${error instanceof Error ? error.message : String(error)}`;
      return defaults();
    }
  }

  get(): SeatConfigSnapshot {
    this.refresh();
    return this.cached;
  }

  problem(): string | undefined {
    this.refresh();
    return this.loadProblem;
  }

  warnings(): string[] {
    this.refresh();
    return this.loadWarnings;
  }

  /**
   * Writes a new version. Refused (nothing written) when the seats don't validate, when the file
   * changed since `expectedVersion` was read, or when the file on disk is invalid — saving then would
   * replace the operator's seats with edited defaults. `replaceInvalid` does that deliberately, after
   * keeping the invalid file as `<path>.invalid-<timestamp>`.
   */
  save(seats: SeatConfig[], options: { expectedVersion?: number; replaceInvalid?: boolean } = {}): SeatConfigSnapshot {
    this.refresh();
    const valid = SeatConfigSchema.array().parse(seats);
    if (this.loadProblem && !options.replaceInvalid) {
      throw new SeatConfigInvalidError(`${this.loadProblem}. Fix the file, or replace it deliberately (its current contents are kept as a backup).`);
    }
    if (options.expectedVersion !== undefined && options.expectedVersion !== this.cached.version) {
      throw new SeatConfigConflictError(`the seat configuration changed (now version ${this.cached.version}, you edited version ${options.expectedVersion}); reload and try again`);
    }
    mkdirSync(dirname(this.path), { recursive: true });
    if (this.loadProblem) copyFileSync(this.path, `${this.path}.invalid-${Date.now()}`);
    const next: SeatConfigSnapshot = { version: Math.max(this.cached.version, this.invalidVersion) + 1, seats: valid };
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.path);
    this.reload();
    return this.cached;
  }
}
