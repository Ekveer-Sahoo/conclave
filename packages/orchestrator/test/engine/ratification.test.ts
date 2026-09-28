import assert from "node:assert/strict";
import test from "node:test";
import { tallyRatification, type TallyInput } from "../../dist/engine/ratification.js";

const tally = (over: Partial<TallyInput> = {}) =>
  tallyRatification({
    votes: [],
    missing: [],
    activeSeatIds: new Set(["a", "b", "c"]),
    minQuorum: 2,
    openContentionSeverities: [],
    ...over,
  });

test("unanimous approval from every active seat ratifies", () => {
  const result = tally({ votes: [{ seat: "a", vote: "APPROVE" }, { seat: "b", vote: "APPROVE" }, { seat: "c", vote: "APPROVE" }] });
  assert.equal(result.ratified, true);
  assert.equal(result.approvals, 3);
});

test("a single REJECT blocks ratification however many seats approve", () => {
  const result = tally({ votes: [{ seat: "a", vote: "APPROVE" }, { seat: "b", vote: "APPROVE" }, { seat: "c", vote: "REJECT" }] });
  assert.equal(result.ratified, false);
  assert.match(result.reason, /REJECT/);
});

test("a missing vote is never counted as assent, even above quorum", () => {
  const result = tally({
    votes: [{ seat: "a", vote: "APPROVE" }, { seat: "b", vote: "APPROVE" }],
    missing: [{ seat: "c", reason: "UNAVAILABLE" }],
  });
  assert.equal(result.ratified, false, "a silent seat is indistinguishable from a lost objection");
  assert.equal(result.missing, 1);
  assert.match(result.reason, /did not vote/);
});

test("below quorum is reported as non-quorate rather than resolved either way", () => {
  const result = tally({ votes: [{ seat: "a", vote: "APPROVE" }], activeSeatIds: new Set(["a", "b", "c"]) });
  assert.equal(result.ratified, false);
  assert.match(result.reason, /quorum not met/);
});

test("an open material contention blocks ratification even on a unanimous approve", () => {
  const result = tally({
    votes: [{ seat: "a", vote: "APPROVE" }, { seat: "b", vote: "APPROVE" }, { seat: "c", vote: "APPROVE" }],
    openContentionSeverities: ["MAJOR"],
  });
  assert.equal(result.ratified, false);
  assert.match(result.reason, /material contention/);
});

test("an open NIT contention does not block an otherwise unanimous approval", () => {
  const result = tally({
    votes: [{ seat: "a", vote: "APPROVE" }, { seat: "b", vote: "APPROVE" }, { seat: "c", vote: "APPROVE" }],
    openContentionSeverities: ["NIT"],
  });
  assert.equal(result.ratified, true);
});

test("approve-with-changes ratifies only when nothing at all is still open", () => {
  const clean = tally({
    votes: [{ seat: "a", vote: "APPROVE_WITH_CHANGES" }, { seat: "b", vote: "APPROVE" }, { seat: "c", vote: "APPROVE" }],
  });
  assert.equal(clean.ratified, true);
  assert.equal(clean.conditional, 1);

  const withNit = tally({
    votes: [{ seat: "a", vote: "APPROVE_WITH_CHANGES" }, { seat: "b", vote: "APPROVE" }, { seat: "c", vote: "APPROVE" }],
    openContentionSeverities: ["NIT"],
  });
  assert.equal(withNit.ratified, false, '"approve, but fix this first" is not approval of unfixed work');
});

test("a re-cast vote in the same round corrects rather than double-counts", () => {
  const result = tally({
    votes: [
      { seat: "a", vote: "REJECT" },
      { seat: "a", vote: "APPROVE" },
      { seat: "b", vote: "APPROVE" },
      { seat: "c", vote: "APPROVE" },
    ],
  });
  assert.equal(result.ratified, true);
  assert.equal(result.approvals, 3);
  assert.equal(result.rejections, 0);
});

test("votes and missing entries from inactive seats are ignored", () => {
  const result = tally({
    votes: [{ seat: "a", vote: "APPROVE" }, { seat: "b", vote: "APPROVE" }, { seat: "ghost", vote: "REJECT" }],
    missing: [{ seat: "ghost", reason: "UNAVAILABLE" }],
    activeSeatIds: new Set(["a", "b"]),
  });
  assert.equal(result.ratified, true);
  assert.equal(result.missing, 0);
});

test("an empty electorate never ratifies by vacuous unanimity", () => {
  const result = tally({ activeSeatIds: new Set() });
  assert.equal(result.ratified, false);
  assert.match(result.reason, /no active seats/);
});
