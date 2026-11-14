import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repository = "oftring-ventures/commish-sdk";
export const gate = "Claude review gate";
export const legacyGate = "codex_review / Codex review gate";
const githubActionsApp = 15368;
const model = "claude-sonnet-5";
const sha = /^[0-9a-f]{40}$/;
const findingProperties = {
  priority: { type: "integer", minimum: 0, maximum: 3 },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  title: { type: "string", minLength: 1, maxLength: 120 },
  body: { type: "string", minLength: 1, maxLength: 20000 },
  path: { type: "string", minLength: 1, maxLength: 1000 },
  start_line: { type: "integer", minimum: 1, maximum: 10000000 },
  end_line: { type: "integer", minimum: 1, maximum: 10000000 },
};
const schema = {
  type: "object",
  properties: {
    review_complete: { type: "boolean" },
    findings: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: findingProperties,
        required: Object.keys(findingProperties),
        additionalProperties: false,
      },
    },
    summary: { type: "string", minLength: 1, maxLength: 20000 },
  },
  required: ["review_complete", "findings", "summary"],
  additionalProperties: false,
};

const blocks = ({ priority, confidence }) => priority <= 1 && confidence >= 0.85;
const externalId = ({ pr, base, head }) => `public-claude-review:${pr}:${base}:${head}`;
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function parseReview(raw) {
  const review = JSON.parse(raw);
  assert(exactKeys(review, schema.required), "Invalid review fields");
  assert.equal(typeof review.review_complete, "boolean");
  assert(
    typeof review.summary === "string" &&
      review.summary.trim() &&
      review.summary.length <= schema.properties.summary.maxLength,
    "Invalid review summary",
  );
  assert(Array.isArray(review.findings) && review.findings.length <= 100, "Invalid findings");
  for (const finding of review.findings) {
    assert(exactKeys(finding, Object.keys(findingProperties)), "Invalid finding fields");
    for (const [key, property] of Object.entries(findingProperties)) {
      const value = finding[key];
      if (property.type === "string") {
        assert(
          typeof value === "string" && value.trim() && value.length <= property.maxLength,
          "Invalid finding text",
        );
      } else {
        assert(
          (property.type === "integer" ? Number.isSafeInteger(value) : Number.isFinite(value)) &&
            value >= property.minimum &&
            value <= property.maximum,
          "Invalid finding number",
        );
      }
    }
    assert(
      !finding.path.includes("\\") &&
        !/\p{Cc}/u.test(finding.path) &&
        !/^[a-z]:/i.test(finding.path) &&
        !finding.path.split("/").some((part) => ["", ".", ".."].includes(part)) &&
        finding.end_line >= finding.start_line,
      "Invalid finding location",
    );
  }
  return review;
}

export function makeReport(identity, { configured, jobResult, conclusion, result }) {
  const report = {
    schema_version: 1,
    ...identity,
    gate,
    model,
    billing: "claude_subscription",
    usage: null,
    status: "execution_failure",
    findings: [],
  };
  if (configured === "false") return { ...report, status: "configuration_failure" };
  if (jobResult !== "success" || conclusion !== "success" || configured !== "true") return report;

  let review;
  try {
    review = parseReview(result);
  } catch {
    return { ...report, status: "invalid_output" };
  }
  report.summary = review.summary;
  report.findings = review.findings.map((finding) => ({
    ...finding,
    id: createHash("sha256")
      .update(JSON.stringify([identity.pr, identity.head, finding]))
      .digest("hex"),
    disposition: "untriaged",
  }));
  report.status = !review.review_complete
    ? "incomplete_review"
    : report.findings.some(blocks)
      ? "blocked"
      : "passed";
  return report;
}

async function validatePull(request, { pr, base, head }) {
  const pull = await request(`pulls/${pr}`);
  assert(
    pull.number === pr &&
      pull.state === "open" &&
      pull.draft === false &&
      pull.base.ref === "main" &&
      pull.base.repo?.full_name === repository &&
      pull.head.repo?.full_name === repository &&
      pull.head.sha === head &&
      sha.test(pull.base.sha),
    "PR no longer matches its admitted repository, target, or head",
  );
  if (pull.base.sha === base) return;
  const comparison = await request(`compare/${base}...${pull.base.sha}?per_page=1`);
  assert.equal(comparison.status, "ahead", "Main no longer descends from the admitted base");
}

function matchesCheck(check, identity, name) {
  return (
    check.name === name &&
    check.app?.id === githubActionsApp &&
    check.head_sha === identity.head &&
    check.external_id === externalId(identity) &&
    Number.isSafeInteger(check.id) &&
    check.id > 0
  );
}

export async function admit(request, identity) {
  await validatePull(request, identity);
  let legacy;
  for (let page = 1; ; page++) {
    const { check_runs: checks } = await request(
      `commits/${identity.head}/check-runs?app_id=${githubActionsApp}&filter=all&per_page=100&page=${page}`,
    );
    // Never run the model again automatically for the same head, even after failure.
    if (
      checks.some(
        (check) =>
          check.name === gate &&
          check.app?.id === githubActionsApp &&
          check.head_sha === identity.head &&
          check.external_id?.startsWith(`public-claude-review:${identity.pr}:`),
      )
    )
      return;
    legacy ??= checks.find((check) => matchesCheck(check, identity, legacyGate));
    if (checks.length < 100) break;
  }
  const create = async (name) => {
    const check = await request("check-runs", "POST", {
      name,
      head_sha: identity.head,
      status: "queued",
      external_id: externalId(identity),
    });
    assert(matchesCheck(check, identity, name), "GitHub returned a different check");
    return check.id;
  };
  // Create the legacy alias first so a failure here leaves the review eligible
  // for admission. If canonical check creation fails, reuse the queued alias.
  const legacyId = legacy?.id ?? (await create(legacyGate));
  return { legacyId, checkId: await create(gate) };
}

export async function publish(request, identity, ids, report, detailsUrl, saveEvidence) {
  assert(/^[1-9]\d*$/.test(ids.checkId) && /^[1-9]\d*$/.test(ids.legacyId), "Invalid check IDs");
  for (const [name, id] of [
    [gate, ids.checkId],
    [legacyGate, ids.legacyId],
  ]) {
    const check = await request(`check-runs/${id}`);
    assert(matchesCheck(check, identity, name) && String(check.id) === id, "Wrong admitted check");
  }
  try {
    await validatePull(request, identity);
  } catch {
    report.status = "identity_failure";
  }

  const allowed = report.status === "passed";
  const conclusion = allowed ? "success" : "failure";
  const summary = `Claude review: ${report.status}. Findings: ${report.findings.length}; blockers: ${report.findings.filter(blocks).length}. See the workflow artifact for the complete report.`;
  saveEvidence(report, summary);
  const checkBody = {
    status: "completed",
    conclusion,
    details_url: detailsUrl,
    output: { title: `Claude review: ${report.status}`, summary },
  };
  for (const [name, id] of [
    [gate, ids.checkId],
    [legacyGate, ids.legacyId],
  ]) {
    await request(`check-runs/${id}`, "PATCH", {
      ...checkBody,
      output: {
        ...checkBody.output,
        annotations:
          name === gate && report.status !== "identity_failure"
            ? report.findings.slice(0, 50).map((finding) => ({
                path: finding.path,
                start_line: finding.start_line,
                end_line: finding.end_line,
                annotation_level: blocks(finding) ? "failure" : "warning",
                title: finding.title,
                message: `[P${finding.priority}, ${Math.round(finding.confidence * 100)}%] ${finding.body}`,
              }))
            : [],
      },
    });
    await request(`statuses/${identity.head}`, "POST", {
      context: name,
      state: conclusion,
      description: `Claude review: ${report.status}`,
      target_url: detailsUrl,
    });
  }
  return allowed;
}

function prepare({ base, head }) {
  const git = (args) =>
    execFileSync("git", ["-C", "pr-head", ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  assert.equal(git(["rev-parse", "HEAD"]).trim(), head, "Wrong review checkout");
  const modes = git(["ls-tree", "-rz", "--format=%(objectmode)", head]).split("\0").filter(Boolean);
  assert(
    modes.every((mode) => mode === "100644" || mode === "100755"),
    "Review source must contain only regular files",
  );
  const mergeBase = git(["merge-base", "--all", base, head]).trim();
  assert(sha.test(mergeBase), "Expected one review merge base");
  writeFileSync(
    ".review-pr.patch",
    git(["diff", "--no-ext-diff", "--no-textconv", mergeBase, head, "--"]),
  );
}

async function main(env, mode) {
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `${repository}/.github/workflows/public-claude-review.yml@refs/heads/main`,
  );
  const identity = {
    repository,
    pr: Number(env.REVIEW_PR),
    base: env.REVIEW_BASE,
    head: env.REVIEW_HEAD,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT,
  };
  assert(
    /^[1-9]\d*$/.test(env.REVIEW_PR) &&
      Number.isSafeInteger(identity.pr) &&
      sha.test(identity.base) &&
      sha.test(identity.head),
    "Invalid review identity",
  );

  const output = (key, value) => appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  const request = async (path, method = "GET", payload) => {
    const response = await fetch(`${env.GITHUB_API_URL}/repos/${repository}/${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: payload && JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    assert(response.ok, `GitHub ${method} request failed (HTTP ${response.status})`);
    return response.json();
  };

  if (mode === "prepare") {
    output("configured", env.HAS_CLAUDE_TOKEN);
    assert.equal(
      env.HAS_CLAUDE_TOKEN,
      "true",
      "Configure the CLAUDE_CODE_OAUTH_TOKEN Actions secret",
    );
    await validatePull(request, identity);
    prepare(identity);
    output("schema", JSON.stringify(schema));
    return;
  }

  if (mode === "admit") {
    const checks = await admit(request, identity);
    if (checks) {
      output("check_id", checks.checkId);
      output("legacy_id", checks.legacyId);
    }
    return;
  }

  assert.equal(mode, "report", "Expected admit, prepare, or report");
  const report = makeReport(identity, {
    configured: env.REVIEW_CONFIGURED,
    jobResult: env.REVIEW_JOB_RESULT,
    conclusion: env.REVIEW_CONCLUSION,
    result: env.REVIEW_RESULT,
  });
  const detailsUrl = `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${identity.run_id}`;
  const allowed = await publish(
    request,
    identity,
    { checkId: env.REVIEW_CHECK_ID, legacyId: env.REVIEW_LEGACY_ID },
    report,
    detailsUrl,
    (evidence, summary) => {
      writeFileSync(env.REPORT_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    },
  );
  process.exitCode = allowed ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main(process.env, process.argv[2]);
  } catch (error) {
    // Do not print assertion values or provider responses in this public workflow.
    console.error(
      error instanceof assert.AssertionError ? error.message : "Review infrastructure failed",
    );
    process.exitCode = 1;
  }
}
