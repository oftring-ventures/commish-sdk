import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acceptHandoff, fetchEvidence, readZipMembers } from "./publication-handoff.mjs";
import { isMissingRegistryVersion, publicRegistryArgs, publicationPlan, readPublicationCandidate,
  requirePublicationApproval } from "./publication-preflight.mjs";

export const npmTimeoutMs = 120_000;
// npm's publish-time malware scan hides a new version for typically ~5, at peak 15+ minutes.
export const registryVisibility = { timeoutMs: 30 * 60_000, intervalMs: 30_000 };
const succeeded = (result) => result.status === 0 && !result.signal && !result.error;
const npm = (args) => {
  // Capture diagnostics: subprocess output may contain authentication material.
  const env = { ...process.env }; delete env.GITHUB_TOKEN;
  return spawnSync("npm", args, { env, encoding: "utf8", timeout: npmTimeoutMs, maxBuffer: 1_000_000 });
};

// Returns the first lookup that is not a clean E404; no lookup starts after the deadline.
async function awaitVisible(lookup, { sleep, now, notify }, label) {
  const deadline = now() + registryVisibility.timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const observed = lookup();
    if (!isMissingRegistryVersion(observed)) return observed;
    const remaining = deadline - now();
    assert(remaining > 0, "published version not visible before the deadline; inspect registry before another attempt");
    if (!attempt) notify(`${label} is not visible yet; waiting for npm's publish-time scan.`);
    await sleep(Math.min(registryVisibility.intervalMs, remaining));
  }
}

export async function executePublication({ runId, artifactId, publish = false, env = process.env },
  { evidence = fetchEvidence, run = npm, sleep = delay, now = () => performance.now(),
    notify = (message) => console.error(message) } = {}) {
  assert.match(runId, /^[1-9][0-9]*$/); assert.match(artifactId, /^[1-9][0-9]*$/);
  assert.equal(typeof publish, "boolean");
  const approved = { source: env.COMMISH_NPM_APPROVED_SOURCE,
    manifestSha256: env.COMMISH_NPM_APPROVED_MANIFEST_SHA256,
    ciReceiptSha256: env.COMMISH_NPM_APPROVED_CI_RECEIPT_SHA256 };
  assert.match(approved.source, /^[a-f0-9]{40}$/);
  for (const field of ["manifestSha256", "ciReceiptSha256"]) assert.match(approved[field], /^[a-f0-9]{64}$/);
  const fetched = await evidence({ runId, artifactId, token: env.GITHUB_TOKEN });
  const accepted = acceptHandoff(fetched);
  assert.equal(accepted.runId, runId); assert.equal(accepted.artifactId, artifactId);
  for (const field of Object.keys(approved)) assert.equal(accepted[field], approved[field], "independent approval differs");
  if (publish) requirePublicationApproval(approved, env);
  const directory = mkdtempSync(join(tmpdir(), "commish-publication-"));
  try {
    // acceptHandoff has verified the exact five-file inventory and API ZIP digest.
    for (const [name, bytes] of readZipMembers(fetched.zip))
      writeFileSync(join(directory, name), bytes, { flag: "wx", mode: 0o600 });
    const candidate = readPublicationCandidate(directory, approved);
    const lookup = (item) => run(["view", `${item.name}@${item.version}`, "dist.integrity", "--json", ...publicRegistryArgs]);
    // Both versions must pass before the first upload; unknown lookup is not absence.
    const plan = publicationPlan(candidate, candidate.artifacts.map(lookup), { publish, env });
    const uploaded = [];
    for (const command of plan) {
      readPublicationCandidate(directory, approved); // Recheck bytes immediately before each execution.
      const result = run(command.argv);
      if (publish) {
        const item = candidate.artifacts.find((entry) => entry.name === command.name);
        // Only a confirmed upload waits out the scan; a failed/uncertain one gets a single readback.
        const observed = succeeded(result)
          ? await awaitVisible(() => lookup(item), { sleep, now, notify }, `${item.name}@${item.version}`)
          : lookup(item);
        assert(succeeded(observed), "publication outcome unconfirmed; inspect registry before another attempt");
        assert.equal(JSON.parse(observed.stdout), command.integrity, "published integrity differs; stop the pair");
      }
      assert(succeeded(result), "publication command failed or was uncertain; no automatic retry");
      uploaded.push(command.name);
    }
    return { source: accepted.source, runId, artifactId, artifactDigest: accepted.artifactDigest,
      manifestSha256: approved.manifestSha256, ciReceiptSha256: approved.ciReceiptSha256,
      mode: publish ? "publish" : "dry-run", executed: uploaded,
      skipped: candidate.artifacts.filter((item) => !uploaded.includes(item.name)).map((item) => item.name),
      registryIntegrityVerified: publish, hostedAccepted: false };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

// npm output, JSON parse errors and generated assertion messages may carry environment values or
// authentication material, so only the error code and an author-written assertion message are shown.
// Node appends the actual/expected diff after that message's first line; it is never printed.
export function stopDiagnostic(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "unknown";
  const reason = error instanceof assert.AssertionError && error.generatedMessage === false
    ? `: ${error.message.split("\n", 1)[0]}` : "";
  return `Publication stopped (${code}${reason}). Inspect the accepted evidence and registry before retrying; no automatic retry occurred.`;
}

if (import.meta.main) {
  try {
    const [runId, artifactId, flag] = process.argv.slice(2);
    assert(process.argv.length <= 5 && (flag === undefined || flag === "--publish"), "unexpected arguments");
    console.log(JSON.stringify(await executePublication({ runId, artifactId, publish: flag === "--publish" })));
  } catch (error) {
    console.error(stopDiagnostic(error));
    process.exitCode = 1;
  }
}
