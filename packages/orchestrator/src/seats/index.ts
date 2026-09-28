import type { SeatConfig, Verdict } from "@conclave/core";
import {
  CliInvocationError,
  invokeCliSeat,
  type CommandCapture,
  type ProviderUsage,
} from "./cliAdapter.js";
import { invokeFakeSeat } from "./fakeAdapter.js";
import { invokeXeniaSeat } from "./xeniaAdapter.js";

export interface SeatInvocation {
  seat: SeatConfig;
  prompt: string;
  cwd: string;
  mode?: "audit" | "execute";
  /** Set only when this invocation is scoped to verifying one specific finding. */
  findingId?: string;
  signal?: AbortSignal;
  /** Xenia only; ignored by the other adapters. */
  xeniaBaseUrl?: string;
  /**
   * Xenia only; ignored by the other adapters, which read the worktree themselves. A xenia seat has
   * no shell or filesystem, so this excerpt is its only view of the repository.
   */
  repoContext?: string;
}

export interface SeatOutcome {
  verdict: Verdict;
  usage: ProviderUsage | null;
  commandRuns: CommandCapture[];
}

/**
 * Single entry point for invoking a seat, whatever backs it. Everything above this line — the
 * phase machine, the session driver — deals only in seats and verdicts and never learns whether a
 * seat is a subprocess, an HTTP call, or an in-process stub.
 */
export async function invokeSeat(input: SeatInvocation): Promise<SeatOutcome> {
  switch (input.seat.adapter) {
    case "cli":
      return await invokeCliSeat({
        seat: input.seat,
        prompt: input.prompt,
        cwd: input.cwd,
        mode: input.mode,
        findingId: input.findingId,
        signal: input.signal,
      });
    case "fake":
      return await invokeFakeSeat({
        seat: input.seat,
        prompt: input.prompt,
        cwd: input.cwd,
        mode: input.mode ?? "audit",
        findingId: input.findingId,
        signal: input.signal,
      });
    case "xenia":
      return await invokeXeniaSeat({
        seat: input.seat,
        prompt: input.prompt,
        baseUrl: input.xeniaBaseUrl,
        repoContext: input.repoContext,
        signal: input.signal,
      });
    default: {
      const exhaustive: never = input.seat.adapter;
      throw new CliInvocationError(
        (input.seat as SeatConfig).id,
        `unsupported seat adapter: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Fans a prompt out to every enabled seat concurrently. Settled rather than all-or-nothing: one
 * provider being down must reduce the active council, not abort the round.
 */
export async function invokeCouncil(
  seats: SeatConfig[],
  prompt: string,
  cwd: string,
  signal?: AbortSignal,
  options?: { mode?: "audit" | "execute"; xeniaBaseUrl?: string; repoContext?: string },
): Promise<PromiseSettledResult<SeatOutcome>[]> {
  return await Promise.allSettled(
    seats
      .filter((seat) => seat.enabled)
      .map((seat) =>
        invokeSeat({
          seat,
          prompt,
          cwd,
          signal,
          mode: options?.mode,
          xeniaBaseUrl: options?.xeniaBaseUrl,
          repoContext: options?.repoContext,
        }),
      ),
  );
}

export { CliCancelledError, CliInvocationError, type CommandCapture, type ProviderUsage } from "./cliAdapter.js";
export { clearFakeSeats, registerFakeSeat, scriptFakeSeat, type FakeSeatResponse } from "./fakeAdapter.js";
export { DEFAULT_XENIA_BASE_URL, invokeXeniaSeat } from "./xeniaAdapter.js";
