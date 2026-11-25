import { VerdictSchema, type SeatConfig, type Verdict } from "@conclave/core";
import type { CommandCapture, ProviderUsage } from "./cliAdapter.js";
import { CliCancelledError, CliInvocationError } from "./cliAdapter.js";

export interface FakeInvocation {
  seat: SeatConfig;
  prompt: string;
  cwd: string;
  mode: "audit" | "execute";
  findingId?: string;
  signal?: AbortSignal;
}

export type FakeSeatResponse =
  | { kind: "verdict"; verdict: Partial<Verdict> & Pick<Verdict, "overall_verdict">; usage?: ProviderUsage | null; commandRuns?: CommandCapture[]; model?: string }
  /** Rejects like a provider that failed — the seat is dropped from the active set for the run. A
   * failure can still carry what the call cost (a timeout, an unusable answer are billed too). */
  | { kind: "error"; message: string; usage?: ProviderUsage | null }
  /** Never settles until the signal aborts. Exists so cancellation paths are testable in-process. */
  | { kind: "hang" };

export type FakeSeatHandler = (input: FakeInvocation) => FakeSeatResponse | Promise<FakeSeatResponse>;

/**
 * Scripted responses per seat id. Deliberately module-level rather than threaded through
 * SeatConfig: a seat's configuration is persisted into the event log (SessionConfigured), and a
 * closure is not serializable, so scripting has to live beside the adapter rather than inside the
 * durable config.
 */
const handlers = new Map<string, FakeSeatHandler>();

export function registerFakeSeat(seatId: string, handler: FakeSeatHandler): void {
  handlers.set(seatId, handler);
}
export function clearFakeSeats(): void {
  handlers.clear();
}

/** Responses consumed in order, one per invocation; the last one repeats once the list runs out. */
export function scriptFakeSeat(seatId: string, responses: FakeSeatResponse[]): void {
  if (responses.length === 0) throw new Error("scriptFakeSeat requires at least one response");
  let index = 0;
  registerFakeSeat(seatId, () => responses[Math.min(index++, responses.length - 1)]);
}

const DEFAULT_USAGE = (seatId: string): ProviderUsage => ({
  promptTokens: 100,
  completionTokens: 50,
  costUsd: 0,
  source: "fake",
});

/**
 * In-process deterministic seat. Unregistered seats approve with no findings, so a council of fake
 * seats reaches consensus without any setup; tests that need disagreement script it explicitly.
 *
 * Cost is reported as exactly 0 rather than omitted: a fake seat genuinely spends nothing, and
 * reporting usage as unavailable would instead exercise the "provider gave us no usage" path.
 */
export async function invokeFakeSeat(input: FakeInvocation): Promise<{
  verdict: Verdict;
  usage: ProviderUsage | null;
  commandRuns: CommandCapture[];
  model?: string;
}> {
  if (input.seat.adapter !== "fake") {
    throw new CliInvocationError(input.seat.id, "seat is not a fake adapter");
  }
  if (input.signal?.aborted) {
    throw new CliCancelledError(input.seat.id, "cancelled before invocation");
  }

  const handler = handlers.get(input.seat.id);
  const response: FakeSeatResponse = handler
    ? await handler(input)
    : { kind: "verdict", verdict: { overall_verdict: "APPROVE", verdict_reasoning: `${input.seat.id} approves` } };

  if (response.kind === "error") {
    throw new CliInvocationError(input.seat.id, response.message, [], response.usage ?? null);
  }
  if (response.kind === "hang") {
    return await new Promise((_resolve, reject) => {
      if (input.signal?.aborted) return reject(new CliCancelledError(input.seat.id, "cancelled"));
      input.signal?.addEventListener(
        "abort",
        () => reject(new CliCancelledError(input.seat.id, "cancelled")),
        { once: true },
      );
    });
  }

  const verdict = VerdictSchema.parse({
    findings: [],
    verdict_reasoning: `${input.seat.id} (fake)`,
    raw_usage: { promptTokens: 100, completionTokens: 50 },
    ...response.verdict,
    // The seat id always comes from configuration, never from the response, matching the CLI
    // adapter's rule that a provider cannot claim to be a different seat.
    seat: input.seat.id,
  });
  return {
    verdict,
    usage: response.usage === undefined ? DEFAULT_USAGE(input.seat.id) : response.usage,
    commandRuns: response.commandRuns ?? [],
    model: response.model,
  };
}
