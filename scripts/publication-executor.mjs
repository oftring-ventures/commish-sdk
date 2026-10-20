import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptHandoff, fetchEvidence, readZipMembers } from "./publication-handoff.mjs";
import {
  publicationPlan,
  publicRegistryArgs,
  readPublicationCandidate,
  requirePublicationApproval,
} from "./publication-preflight.mjs";

export const npmTimeoutMs = 120_000;
export const stagingNpmVersion = "11.21.0";
const succeeded = (result) => result.status === 0 && !result.signal && !result.error;
const npm = (args) => {
  // Capture diagnostics: subprocess output may contain authentication material.
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  return spawnSync("npm", args, {
    env,
    encoding: "utf8",
    timeout: npmTimeoutMs,
    maxBuffer: 1_000_000,
  });
};

export async function executePublication(
  { runId, artifactId, stage = false, env = process.env },
  { evidence = fetchEvidence, run = npm, checkpoint = () => {} } = {},
) {
  assert.match(runId, /^[1-9][0-9]*$/);
  assert.match(artifactId, /^[1-9][0-9]*$/);
  assert.equal(typeof stage, "boolean");
  const approved = {
    source: env.COMMISH_NPM_APPROVED_SOURCE,
    manifestSha256: env.COMMISH_NPM_APPROVED_MANIFEST_SHA256,
    ciReceiptSha256: env.COMMISH_NPM_APPROVED_CI_RECEIPT_SHA256,
  };
  assert.match(approved.source, /^[a-f0-9]{40}$/);
  for (const field of ["manifestSha256", "ciReceiptSha256"])
    assert.match(approved[field], /^[a-f0-9]{64}$/);
  const fetched = await evidence({ runId, artifactId, token: env.GITHUB_TOKEN });
  const accepted = acceptHandoff(fetched);
  assert.equal(accepted.runId, runId);
  assert.equal(accepted.artifactId, artifactId);
  for (const field of Object.keys(approved))
    assert.equal(accepted[field], approved[field], "independent approval differs");
  if (stage) requirePublicationApproval(approved, env);
  const directory = mkdtempSync(join(tmpdir(), "commish-publication-"));
  try {
    // acceptHandoff has verified the exact candidate inventory and API ZIP digest.
    for (const [name, bytes] of readZipMembers(fetched.zip))
      writeFileSync(join(directory, name), bytes, { flag: "wx", mode: 0o600 });
    const candidate = readPublicationCandidate(directory, approved);
    const version = run(["--version"]);
    assert(
      succeeded(version) && version.stdout.trim() === stagingNpmVersion,
      "unexpected npm staging toolchain",
    );
    const lookup = (item) =>
      run([
        "view",
        `${item.name}@${item.version}`,
        "dist.integrity",
        "--json",
        ...publicRegistryArgs,
      ]);
    // Every version must pass before the first upload; unknown lookup is not absence.
    const plan = publicationPlan(candidate, candidate.artifacts.map(lookup), { stage, env });
    const receipt = {
      source: accepted.source,
      runId,
      artifactId,
      artifactDigest: accepted.artifactDigest,
      manifestSha256: approved.manifestSha256,
      ciReceiptSha256: approved.ciReceiptSha256,
      hostedAcceptanceSha256: stage ? env.COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256 : null,
      mode: stage ? "stage" : "dry-run",
      status: "in-progress",
      staged: [],
      executed: [],
      skipped: candidate.artifacts
        .filter((item) => !plan.some((command) => command.name === item.name))
        .map((item) => item.name),
      unconfirmed: null,
      npmPublished: false,
      registryIntegrityVerified: false,
      hostedAccepted: false,
    };
    const record = () => checkpoint(structuredClone(receipt));
    record();
    try {
      for (const command of plan) {
        readPublicationCandidate(directory, approved);
        const item = candidate.artifacts.find((entry) => entry.name === command.name);
        // Retain which upload may have happened even if the command or its output is uncertain.
        receipt.unconfirmed = { name: item.name, version: item.version, integrity: item.integrity };
        record();
        const result = run(command.argv);
        assert(
          succeeded(result),
          "staging command failed or was uncertain; inspect npm stages before retrying",
        );
        const output = JSON.parse(result.stdout);
        assert.deepEqual(Object.keys(output), [item.name], "unexpected staging receipt inventory");
        const packed = output[item.name];
        assert.equal(packed.name, item.name, "staging receipt package differs");
        assert.equal(packed.version, item.version, "staging receipt version differs");
        assert.equal(packed.integrity, item.integrity, "staging receipt integrity differs");
        if (stage) {
          assert.match(
            packed.stageId,
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
            "staging receipt id missing or invalid",
          );
          assert(
            !receipt.staged.some((entry) => entry.stageId === packed.stageId),
            "staging receipt id reused",
          );
          receipt.staged.push({ ...receipt.unconfirmed, stageId: packed.stageId, tag: "latest" });
        } else assert.equal(packed.stageId, undefined, "dry-run unexpectedly staged a package");
        receipt.executed.push(item.name);
        receipt.unconfirmed = null;
        record();
      }
      receipt.status = stage
        ? receipt.staged.length
          ? "awaiting-maintainer-approval"
          : "already-published"
        : "dry-run-complete";
      record();
      return receipt;
    } catch (error) {
      receipt.status = "stopped";
      record();
      throw error;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// npm output, JSON parse errors and generated assertion messages may carry environment values or
// authentication material, so only the error code and an author-written assertion message are shown.
// Node appends the actual/expected diff after that message's first line; it is never printed.
export function stopDiagnostic(error) {
  const code =
    typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : "unknown";
  const reason =
    error instanceof assert.AssertionError && error.generatedMessage === false
      ? `: ${error.message.split("\n", 1)[0]}`
      : "";
  return `Publication stopped (${code}${reason}). Inspect the accepted evidence, npm stages and registry before retrying; no automatic retry occurred.`;
}

if (import.meta.main) {
  let receipt;
  try {
    const [runId, artifactId, flag] = process.argv.slice(2);
    assert(
      process.argv.length <= 5 && (flag === undefined || flag === "--stage"),
      "unexpected arguments",
    );
    receipt = await executePublication(
      { runId, artifactId, stage: flag === "--stage" },
      {
        checkpoint: (value) => {
          receipt = value;
        },
      },
    );
  } catch (error) {
    console.error(stopDiagnostic(error));
    process.exitCode = 1;
  } finally {
    if (receipt) console.log(JSON.stringify(receipt));
  }
}
