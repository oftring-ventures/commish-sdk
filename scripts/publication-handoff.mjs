import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { candidateScopes } from "./public-candidate.mjs";

const repository = "oftring-ventures/commish-sdk";
const workflowPath = ".github/workflows/public-source.yml";
const hash = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);

// P5a: a read-only verifier that turns an accepted GitHub run, its retained
// candidate artifact and main ancestry into the approval digests that
// publication-preflight consumes. It reads; it never publishes, tags or writes
// to a registry, and it needs no credential beyond a read token for the API.

export function readZipMembers(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(end >= 0 && end + 22 <= bytes.length, "zip has no end-of-central-directory record");
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt16LE(end + 8), count, "zip spans several disks");
  assert(start + size <= end, "zip central directory overflows");
  const members = new Map();
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50, "zip central directory entry expected");
    const method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    assert.match(name, /^[A-Za-z0-9._-]+$/, "zip member name must be a plain file name");
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, "zip local header expected");
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(dataStart, dataStart + compressed);
    assert.equal(raw.length, compressed, "zip member truncated");
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: 20_000_000 }) : assert.fail("unsupported zip compression method");
    assert.equal(data.length, uncompressed, "zip member size differs from its header");
    assert(!members.has(name), "duplicate zip member");
    members.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

export function verifyRun(run, { mainHead }) {
  assert.equal(run.repository?.full_name, repository); assert.equal(run.path, workflowPath);
  assert.equal(run.status, "completed"); assert.equal(run.conclusion, "success");
  assert(["push", "pull_request", "merge_group"].includes(run.event), "unexpected run event");
  assert.match(run.head_sha, /^[a-f0-9]{40}$/); assert.match(String(run.id), /^[1-9][0-9]*$/);
  assert.match(String(run.run_attempt), /^[1-9][0-9]*$/);
  assert.equal(run.head_repository?.full_name, repository, "run head must come from this repository");
  assert.match(mainHead, /^[a-f0-9]{40}$/);
  return { runId: String(run.id), runAttempt: String(run.run_attempt), source: run.head_sha };
}

// GitHub's compare endpoint answers "identical" or "behind" only when the run head is an ancestor of main.
export function verifyMainAncestry(comparison, source) {
  assert(["identical", "behind"].includes(comparison.status), `run head ${source} is not an ancestor of main`);
  assert.equal(comparison.merge_base_commit?.sha, source, "merge base must be the run head itself");
  return true;
}

export function verifyArtifact(artifact, accepted) {
  assert.equal(artifact.name, `public-candidate-${accepted.source}-${accepted.runId}-${accepted.runAttempt}`);
  assert.equal(artifact.expired, false, "artifact expired"); assert.equal(String(artifact.workflow_run?.id), accepted.runId);
  assert.equal(artifact.workflow_run?.head_sha, accepted.source);
  assert.match(artifact.digest ?? "", /^sha256:[a-f0-9]{64}$/, "artifact digest required");
  return { artifactId: String(artifact.id), artifactDigest: artifact.digest };
}

export function acceptCandidate(members, accepted) {
  const files = ["manifest.json", "ci-receipt.json", "SHA512SUMS", "commish-sdk-0.1.0-beta.10.tgz", "commish-next-0.1.0-beta.10.tgz"];
  assert.deepEqual([...members.keys()].sort(), [...files].sort(), "unexpected candidate inventory");
  const manifestBytes = members.get("manifest.json"), ciBytes = members.get("ci-receipt.json");
  const manifest = JSON.parse(manifestBytes), ci = JSON.parse(ciBytes);
  assert.equal(manifest.source, accepted.source); assert.equal(manifest.status, "local-artifacts-verified");
  assert.equal(manifest.npmPublished, false); assert.equal(manifest.hostedAccepted, false);
  assert.deepEqual([...manifest.consumerScopes].sort(), [...candidateScopes].sort());
  assert.equal(manifest.artifacts.length, 2);
  for (const [index, item] of manifest.artifacts.entries()) {
    assert.equal(item.file, files[index + 3]);
    const bytes = members.get(item.file);
    assert.equal(bytes.length, item.bytes); assert.equal(hash(bytes, "sha512"), item.sha512, "candidate bytes changed");
  }
  assert.equal(members.get("SHA512SUMS").toString(), manifest.artifacts.map((item) => `${item.sha512}  ${item.file}\n`).join(""));
  assert.equal(ci.repository, repository); assert.equal(ci.source, accepted.source);
  assert.equal(ci.runId, accepted.runId); assert.equal(ci.runAttempt, accepted.runAttempt);
  assert.equal(ci.manifestSha256, hash(manifestBytes), "receipt does not bind this manifest");
  assert.equal(ci.job, "source"); assert.equal(ci.npmPublished, false); assert.equal(ci.hostedAccepted, false);
  assert.deepEqual(ci.artifacts, manifest.artifacts.map(({ file, bytes, sha512 }) => ({ file, bytes, sha512 })));
  return { ...accepted, manifestSha256: hash(manifestBytes), ciReceiptSha256: hash(ciBytes),
    artifacts: manifest.artifacts.map(({ name, version, file, sha512 }) => ({ name, version, file, sha512 })) };
}

// Pure composition over already-fetched evidence; the CLI below is the only network user.
export function acceptHandoff({ run, comparison, artifact, zip, mainHead }) {
  const accepted = verifyRun(run, { mainHead });
  verifyMainAncestry(comparison, accepted.source);
  const bound = verifyArtifact(artifact, accepted);
  assert.equal(`sha256:${hash(zip)}`, bound.artifactDigest, "downloaded artifact bytes differ from the API digest");
  const handoff = acceptCandidate(readZipMembers(zip), { ...accepted, ...bound });
  return { ...handoff, mainHead, repository, npmPublished: false, hostedAccepted: false };
}

export async function fetchEvidence({ runId, artifactId, token, fetch: fetcher = fetch }) {
  const api = async (path, accept = "application/vnd.github+json") => {
    const response = await fetcher(`https://api.github.com${path}`, { headers: { accept, "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    assert.equal(response.status, 200, `GitHub API ${path} answered ${response.status}`);
    return accept.endsWith("json") ? response.json() : Buffer.from(await response.arrayBuffer());
  };
  const run = await api(`/repos/${repository}/actions/runs/${runId}`);
  const main = await api(`/repos/${repository}/branches/main`);
  const comparison = await api(`/repos/${repository}/compare/main...${run.head_sha}`);
  const artifact = await api(`/repos/${repository}/actions/artifacts/${artifactId}`);
  const zip = await api(`/repos/${repository}/actions/artifacts/${artifactId}/zip`, "application/zip");
  return { run, comparison, artifact, zip, mainHead: main.commit.sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [runId, artifactId, output] = process.argv.slice(2);
  assert(runId && artifactId && output, "usage: publication-handoff.mjs <run-id> <artifact-id> <handoff.json>");
  const handoff = acceptHandoff(await fetchEvidence({ runId, artifactId, token: process.env.GITHUB_TOKEN }));
  writeFileSync(output, JSON.stringify(handoff, null, 2) + "\n", { flag: "wx" });
  console.log(`accepted ${handoff.source} from run ${handoff.runId}/${handoff.runAttempt}; approval digests written to ${output}`);
}
