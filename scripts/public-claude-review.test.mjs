import assert from "node:assert/strict";
import test from "node:test";
import { admit, gate, legacyGate, makeReport, publish } from "./public-claude-review.mjs";

const identity = {
  repository: "oftring-ventures/commish-sdk",
  pr: 7,
  base: "a".repeat(40),
  head: "b".repeat(40),
  run_id: "123",
  run_attempt: "1",
};
const finding = {
  priority: 1,
  confidence: 0.85,
  title: "Review regression",
  body: "Explains the introduced defect.",
  path: "scripts/public-claude-review.mjs",
  start_line: 1,
  end_line: 2,
};
const cleanResult = { review_complete: true, findings: [], summary: "Review finished." };
const reportFor = (result = cleanResult, execution = {}) =>
  makeReport(identity, {
    configured: "true",
    jobResult: "success",
    conclusion: "success",
    result: typeof result === "string" ? result : JSON.stringify(result),
    ...execution,
  });

test("review closes the gate on blockers, incomplete output, and provider failure", () => {
  for (const [report, expected] of [
    [reportFor(), "passed"],
    [reportFor({ ...cleanResult, findings: [{ ...finding, priority: 0 }] }), "blocked"],
    [reportFor({ ...cleanResult, findings: [finding] }), "blocked"],
    [reportFor({ ...cleanResult, findings: [{ ...finding, priority: 2 }] }), "passed"],
    [reportFor({ ...cleanResult, findings: [{ ...finding, confidence: 0.849 }] }), "passed"],
    [reportFor({ ...cleanResult, review_complete: false }), "incomplete_review"],
    [
      reportFor({ ...cleanResult, findings: [{ ...finding, path: "../outside" }] }),
      "invalid_output",
    ],
    [reportFor({ ...cleanResult, findings: [{ ...finding, end_line: 0 }] }), "invalid_output"],
    [reportFor({ ...cleanResult, findings: [{ ...finding, extra: true }] }), "invalid_output"],
    [reportFor({ findings: [], summary: "Incomplete schema." }), "invalid_output"],
    [reportFor(""), "invalid_output"],
    [reportFor("malformed"), "invalid_output"],
    [reportFor(cleanResult, { configured: "false" }), "configuration_failure"],
    [reportFor(cleanResult, { jobResult: "cancelled" }), "execution_failure"],
    [reportFor(cleanResult, { conclusion: "failure" }), "execution_failure"],
  ]) {
    assert.equal(report.status, expected);
    assert.equal(report.billing, "claude_subscription");
  }
});

function fixture() {
  const state = {
    pull: {
      number: identity.pr,
      state: "open",
      draft: false,
      base: { ref: "main", sha: identity.base, repo: { full_name: identity.repository } },
      head: { sha: identity.head, repo: { full_name: identity.repository } },
    },
    comparison: "ahead",
    checks: [],
    mutations: [],
    evidence: [],
    failCanonicalCreation: false,
  };
  state.request = async (path, method = "GET", payload) => {
    if (method !== "GET") state.mutations.push({ path, method, payload });
    if (path === `pulls/${identity.pr}`) return state.pull;
    if (path.startsWith(`compare/${identity.base}...`)) return { status: state.comparison };
    if (path.startsWith(`commits/${identity.head}/check-runs?`)) {
      return { check_runs: state.checks };
    }
    if (method === "POST" && path === "check-runs") {
      if (state.failCanonicalCreation && payload.name === gate) throw new Error("create failed");
      const check = { ...payload, id: state.checks.length + 1, app: { id: 15368 } };
      state.checks.push(check);
      return check;
    }
    if (method === "GET" && path.startsWith("check-runs/")) {
      return state.checks.find(({ id }) => path === `check-runs/${id}`);
    }
    if (method === "PATCH" || path === `statuses/${identity.head}`) return {};
    assert.fail(`Unexpected ${method} ${path}`);
  };
  state.admit = () => admit(state.request, identity);
  state.publish = (ids, report) =>
    publish(
      state.request,
      identity,
      { checkId: String(ids.checkId), legacyId: String(ids.legacyId) },
      report,
      "https://example.invalid/run",
      (evidence) => state.evidence.push(evidence),
    );
  return state;
}

test("admission binds both check names to one head and deduplicates Claude reviews", async () => {
  const state = fixture();
  assert.deepEqual(await state.admit(), { legacyId: 1, checkId: 2 });
  assert.deepEqual(
    state.checks.map(({ name, status, head_sha, external_id }) => ({
      name,
      status,
      head_sha,
      external_id,
    })),
    [legacyGate, gate].map((name) => ({
      name,
      status: "queued",
      head_sha: identity.head,
      external_id: `public-claude-review:${identity.pr}:${identity.base}:${identity.head}`,
    })),
  );
  assert.equal(await state.admit(), undefined);
  assert.equal(state.mutations.length, 2);
});

test("admission recovers a partial write and rejects a moved head or diverged base", async () => {
  const state = fixture();
  state.failCanonicalCreation = true;
  await assert.rejects(state.admit(), /create failed/);
  state.failCanonicalCreation = false;
  assert.deepEqual(await state.admit(), { legacyId: 1, checkId: 2 });
  for (const ref of ["head", "base"]) {
    const stale = fixture();
    stale.pull[ref].sha = "c".repeat(40);
    stale.comparison = "diverged";
    await assert.rejects(stale.admit());
    assert.deepEqual(stale.mutations, []);
  }
});

test("reporting enforces the same decision on both names with exact-head annotations", async () => {
  for (const priority of [1, 2]) {
    const state = fixture();
    const ids = await state.admit();
    const allowed = priority === 2;
    const decision = allowed ? "success" : "failure";
    const report = reportFor({ ...cleanResult, findings: [{ ...finding, priority }] });
    assert.equal(await state.publish(ids, report), allowed);
    assert.deepEqual(state.evidence, [report]);
    const [, , canonical, canonicalStatus, legacy, legacyStatus] = state.mutations;
    assert.equal(
      canonical.payload.output.annotations[0].annotation_level,
      allowed ? "warning" : "failure",
    );
    assert.deepEqual(legacy.payload.output.annotations, []);
    assert.equal(canonical.payload.conclusion, decision);
    assert.equal(legacy.payload.conclusion, decision);
    assert.equal(canonicalStatus.payload.context, gate);
    assert.equal(legacyStatus.payload.context, legacyGate);
    assert.equal(canonicalStatus.payload.state, decision);
    assert.equal(legacyStatus.payload.state, decision);
  }
});

test("reporting allows forward movement of main and rejects stale pull or check identity", async () => {
  for (const movement of ["ahead", "diverged", "draft", "retarget", "new head", "wrong check"]) {
    const state = fixture();
    const ids = await state.admit();
    state.pull.base.sha = "c".repeat(40);
    if (movement === "diverged") state.comparison = "diverged";
    if (movement === "draft") state.pull.draft = true;
    if (movement === "retarget") state.pull.base.ref = "other";
    if (movement === "new head") state.pull.head.sha = "d".repeat(40);
    if (movement === "wrong check") {
      state.checks[1].external_id = "other";
      await assert.rejects(state.publish(ids, reportFor()), /Wrong admitted check/);
      assert.equal(state.mutations.length, 2);
      continue;
    }
    const allowed = movement === "ahead";
    assert.equal(await state.publish(ids, reportFor()), allowed);
    assert.equal(state.evidence[0].status, allowed ? "passed" : "identity_failure");
    assert.equal(state.mutations.at(-1).path, `statuses/${identity.head}`);
  }
});
