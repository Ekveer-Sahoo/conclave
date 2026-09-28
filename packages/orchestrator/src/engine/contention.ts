import { createHash } from "node:crypto";
import type { Finding, Severity, Verdict } from "@conclave/core";

/**
 * Severity ordering used everywhere a contention needs a single representative severity or a
 * materiality test. "Material" means BLOCKER or MAJOR: only those gate phase advancement, so only
 * those can open a contention. MINOR/NIT disagreements are recorded as findings and left alone —
 * forcing the council to arbitrate nits would burn rounds without changing the outcome.
 */
const SEVERITY_RANK: Record<Severity, number> = { BLOCKER: 3, MAJOR: 2, MINOR: 1, NIT: 0 };
const MATERIAL_RANK = SEVERITY_RANK.MAJOR;

export const isMaterial = (severity: Severity): boolean => SEVERITY_RANK[severity] >= MATERIAL_RANK;
export const maxSeverity = (severities: Severity[]): Severity =>
  severities.reduce((worst, next) => (SEVERITY_RANK[next] > SEVERITY_RANK[worst] ? next : worst), "NIT");

/**
 * Synthetic target for a seat that rejects the work as a whole without filing a structured finding
 * anyone else can point at. Without this, a bare REJECT would vanish: there is no target to group
 * on, so no contention would open and the dissent would be silently outvoted.
 */
export const OVERALL_TARGET = "__overall__";

export interface ContentionCandidate {
  contentionId: string;
  targets: string[];
  category: string;
  severity: Severity;
  findingIds: string[];
  /** Seats that filed a material finding on this target. */
  claimants: string[];
  /** Active seats that filed nothing material on this target and approved anyway. */
  dissenters: string[];
}

export interface DetectContentionsInput {
  verdicts: Verdict[];
  /** Seats currently eligible to speak. Verdicts from seats outside this set are ignored. */
  activeSeatIds: Set<string>;
}

/**
 * Contention ids are derived from the target rather than randomly generated, so detecting the same
 * disagreement twice (across rounds, or when a log is replayed) yields the same id instead of a
 * duplicate contention. Event sourcing makes this a correctness requirement, not a nicety.
 */
export const contentionIdFor = (target: string): string =>
  `c-${createHash("sha256").update(target).digest("hex").slice(0, 12)}`;

/**
 * Opens a contention for every target where the council genuinely *disagrees* — not merely where a
 * defect was found.
 *
 * The distinction drives the whole phase machine: a defect every active seat agrees on needs
 * remediation, not deliberation, and routing it through arbitration would waste a round to
 * re-derive what the seats already unanimously said. A contention therefore requires a material
 * finding AND someone who does not share the concern: either a seat that approved without filing
 * on that target, or a seat that filed on it but called it immaterial.
 */
export function detectContentions(input: DetectContentionsInput): ContentionCandidate[] {
  const verdicts = input.verdicts.filter((verdict) => input.activeSeatIds.has(verdict.seat));
  if (verdicts.length === 0) return [];

  const byTarget = new Map<string, Finding[]>();
  for (const verdict of verdicts) {
    for (const finding of verdict.findings) {
      const bucket = byTarget.get(finding.target);
      if (bucket) bucket.push(finding);
      else byTarget.set(finding.target, [finding]);
    }
    // A seat that rejects outright without filing anything still dissents; give it a target.
    if (verdict.overall_verdict === "REJECT" && verdict.findings.length === 0) {
      const bucket = byTarget.get(OVERALL_TARGET) ?? [];
      bucket.push({
        id: `${verdict.seat}:${OVERALL_TARGET}`,
        seat: verdict.seat,
        role: "SPEC_FIDELITY",
        target: OVERALL_TARGET,
        category: "unstructured-rejection",
        severity: "BLOCKER",
        description: verdict.verdict_reasoning,
        falsifiable_test: null,
        confidence: 0.5,
      });
      byTarget.set(OVERALL_TARGET, bucket);
    }
  }

  const contentions: ContentionCandidate[] = [];
  for (const [target, findings] of [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const material = findings.filter((finding) => isMaterial(finding.severity));
    if (material.length === 0) continue;

    const claimants = [...new Set(material.map((finding) => finding.seat))].sort();
    // A seat that filed only MINOR/NIT findings on this target is actively saying it is not
    // material — that is disagreement, even though it did file something.
    const downplayers = [...new Set(
      findings.filter((finding) => !isMaterial(finding.severity)).map((finding) => finding.seat),
    )].filter((seat) => !claimants.includes(seat));
    const silentApprovers = verdicts
      .filter((verdict) => verdict.overall_verdict === "APPROVE")
      .map((verdict) => verdict.seat)
      .filter((seat) => !claimants.includes(seat) && !downplayers.includes(seat));

    const dissenters = [...new Set([...downplayers, ...silentApprovers])].sort();
    // Unanimous material concern among the seats that spoke: a defect, not a dispute.
    if (dissenters.length === 0) continue;

    contentions.push({
      contentionId: contentionIdFor(target),
      targets: [target],
      category: dominantCategory(material),
      severity: maxSeverity(material.map((finding) => finding.severity)),
      findingIds: material.map((finding) => finding.id).sort(),
      claimants,
      dissenters,
    });
  }
  return contentions;
}

/** Most-filed category on a target, ties broken alphabetically so the result is replay-stable. */
function dominantCategory(findings: Finding[]): string {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([aName, aCount], [bName, bCount]) => bCount - aCount || aName.localeCompare(bName))[0][0];
}

/**
 * Material defects every active seat agrees on. These bypass deliberation and go straight to
 * remediation — the complement of detectContentions over the same verdict set.
 */
export function uncontestedDefects(input: DetectContentionsInput): Finding[] {
  const contested = new Set(detectContentions(input).flatMap((contention) => contention.targets));
  const verdicts = input.verdicts.filter((verdict) => input.activeSeatIds.has(verdict.seat));
  return verdicts
    .flatMap((verdict) => verdict.findings)
    .filter((finding) => isMaterial(finding.severity) && !contested.has(finding.target))
    .sort((a, b) => a.id.localeCompare(b.id));
}
