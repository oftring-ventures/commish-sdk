import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptHandoff, fetchEvidence, readZipMembers } from "./publication-handoff.mjs";
import { publicRegistryArgs, publicationPlan, readPublicationCandidate, requirePublicationApproval } from "./publication-preflight.mjs";

const succeeded = (result) => result.status === 0 && !result.signal && !result.error;
const npm = (args) => {
  // Capture diagnostics: subprocess output may contain authentication material.
  const env = { ...process.env }; delete env.GITHUB_TOKEN;
  return spawnSync("npm", args, { env, encoding: "utf8", timeout: 120_000, maxBuffer: 1_000_000 });
};

export async function executePublication({ runId, artifactId, publish = false, env = process.env },
  { evidence = fetchEvidence, run = npm } = {}) {
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
        const observed = lookup(item);
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

if (import.meta.main) {
  try {
    const [runId, artifactId, flag] = process.argv.slice(2);
    assert(process.argv.length <= 5 && (flag === undefined || flag === "--publish"), "unexpected arguments");
    console.log(JSON.stringify(await executePublication({ runId, artifactId, publish: flag === "--publish" })));
  } catch {
    console.error("Publication stopped. Inspect the accepted evidence and registry before retrying; no automatic retry occurred.");
    process.exitCode = 1;
  }
}
