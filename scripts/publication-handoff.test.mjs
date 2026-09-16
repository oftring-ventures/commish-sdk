import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateRawSync, gzipSync } from "node:zlib";
import { candidateScopes } from "./public-candidate.mjs";
import { acceptHandoff, fetchEvidence, readZipMembers, verifyMainAncestry } from "./publication-handoff.mjs";

const hash = (data, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(data).digest(encoding);
const repository = "oftring-ventures/commish-sdk", source = "b".repeat(40), mainHead = "c".repeat(40);

function zip(entries, { deflate = false } = {}) {
  const locals = [], central = []; let offset = 0;
  for (const [name, data] of entries) {
    const body = deflate ? deflateRawSync(data) : data, nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body); central.push(entry, nameBytes); offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function candidate(mutate = () => {}) {
  const artifacts = ["sdk", "next"].map((pkg) => {
    const payload = Buffer.from(JSON.stringify({ name: `@commish/${pkg}`, version: "0.1.0-beta.10" })), header = Buffer.alloc(512);
    header.write("package/package.json"); header.write("0000644", 100); header.write(payload.length.toString(8).padStart(11, "0"), 124);
    const bytes = gzipSync(Buffer.concat([header, payload, Buffer.alloc((512 - payload.length % 512) % 512 + 1024)])); bytes[9] = 255;
    return { name: `@commish/${pkg}`, version: "0.1.0-beta.10", file: `commish-${pkg}-0.1.0-beta.10.tgz`, bytes, sha512: hash(bytes, "sha512") };
  });
  const manifest = { source, status: "local-artifacts-verified", npmPublished: false, hostedAccepted: false, node: "v24.15.0",
    consumerScopes: candidateScopes, artifacts: artifacts.map(({ name, version, file, bytes, sha512 }) => ({ name, version, file, bytes: bytes.length, sha512 })) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const ci = { repository, source, manifestSha256: hash(manifestBytes), job: "source", runId: "42", runAttempt: "1", npmPublished: false,
    hostedAccepted: false, artifacts: manifest.artifacts.map(({ file, bytes, sha512 }) => ({ file, bytes, sha512 })) };
  const files = new Map([["manifest.json", manifestBytes], ["ci-receipt.json", Buffer.from(JSON.stringify(ci))],
    ["SHA512SUMS", Buffer.from(manifest.artifacts.map((item) => `${item.sha512}  ${item.file}\n`).join(""))],
    ...artifacts.map((item) => [item.file, item.bytes])]);
  const evidence = { mainHead,
    run: { id: 42, run_attempt: 1, status: "completed", conclusion: "success", event: "push", head_sha: source, path: ".github/workflows/public-source.yml",
      repository: { full_name: repository }, head_repository: { full_name: repository } },
    comparison: { status: "behind", merge_base_commit: { sha: source } },
    artifact: { id: 7, name: `public-candidate-${source}-42-1`, expired: false, workflow_run: { id: 42, head_sha: source } } };
  mutate({ files, evidence, ci, manifestBytes });
  evidence.zip = zip([...files]); evidence.artifact.digest ??= `sha256:${hash(evidence.zip)}`;
  return { evidence, manifestBytes, ciBytes: files.get("ci-receipt.json") };
}

test("zip members round-trip stored and deflated entries and reject malformed archives", () => {
  const entries = [["a.txt", Buffer.from("alpha")], ["b.bin", Buffer.alloc(3000, 7)]];
  for (const deflate of [false, true]) assert.deepEqual([...readZipMembers(zip(entries, { deflate }))], entries);
  assert.throws(() => readZipMembers(zip([["a.txt", Buffer.from("1")], ["a.txt", Buffer.from("2")]])), /duplicate zip member/);
  assert.throws(() => readZipMembers(zip([["../escape", Buffer.from("x")]])), /plain file name/);
  assert.throws(() => readZipMembers(Buffer.from("not a zip")), /end-of-central-directory/);
});

test("an accepted run, ancestor of main, with a bound retained candidate yields the approval digests", () => {
  const { evidence, manifestBytes, ciBytes } = candidate();
  const handoff = acceptHandoff(evidence);
  assert.equal(handoff.source, source); assert.equal(handoff.runId, "42"); assert.equal(handoff.runAttempt, "1");
  assert.equal(handoff.manifestSha256, hash(manifestBytes)); assert.equal(handoff.ciReceiptSha256, hash(ciBytes));
  assert.equal(handoff.artifactId, "7"); assert.equal(handoff.artifactDigest, evidence.artifact.digest);
  assert.deepEqual({ ...handoff, artifacts: undefined }, { ...handoff, artifacts: undefined, mainHead, repository, npmPublished: false, hostedAccepted: false });
  assert.deepEqual(handoff.artifacts.map((item) => item.file), ["commish-sdk-0.1.0-beta.10.tgz", "commish-next-0.1.0-beta.10.tgz"]);
  assert.equal(verifyMainAncestry({ status: "identical", merge_base_commit: { sha: source } }, source), true);
});

test("every unaccepted, unbound or tampered input is refused", () => {
  const refuse = (mutate, pattern) => assert.throws(() => acceptHandoff(candidate(mutate).evidence), pattern);
  refuse(({ evidence }) => { evidence.run.conclusion = "failure"; }, /success/);
  refuse(({ evidence }) => { evidence.run.event = "workflow_dispatch"; }, /unexpected run event/);
  refuse(({ evidence }) => { evidence.run.head_repository.full_name = "fork/commish-sdk"; }, /this repository/);
  refuse(({ evidence }) => { evidence.comparison.status = "ahead"; }, /not an ancestor of main/);
  refuse(({ evidence }) => { evidence.comparison.merge_base_commit.sha = mainHead; }, /merge base/);
  refuse(({ evidence }) => { evidence.artifact.name = `public-candidate-${source}-42-2`; }, /public-candidate/);
  refuse(({ evidence }) => { evidence.artifact.expired = true; }, /expired/);
  refuse(({ evidence }) => { evidence.artifact.digest = `sha256:${"0".repeat(64)}`; }, /bytes differ from the API digest/);
  refuse(({ files }) => { files.get("commish-sdk-0.1.0-beta.10.tgz")[20] ^= 1; }, /candidate bytes changed/);
  refuse(({ files }) => { files.delete("SHA512SUMS"); }, /unexpected candidate inventory/);
  refuse(({ files, ci }) => { files.set("ci-receipt.json", Buffer.from(JSON.stringify({ ...ci, runId: "43" }))); }, /runId|43/);
  refuse(({ files, ci }) => { files.set("ci-receipt.json", Buffer.from(JSON.stringify({ ...ci, manifestSha256: "0".repeat(64) }))); }, /bind this manifest/);
  refuse(({ files, manifestBytes }) => { files.set("manifest.json", Buffer.concat([manifestBytes, Buffer.from(" ")])); }, /bind this manifest/);
});

test("evidence is fetched read-only from the four GitHub endpoints with a bearer token", async () => {
  const { evidence } = candidate(); const calls = [];
  const fetcher = async (url, init) => {
    calls.push([url, init.headers.accept, init.headers.authorization]);
    const path = url.replace("https://api.github.com", "");
    const body = { [`/repos/${repository}/actions/runs/42`]: evidence.run, [`/repos/${repository}/branches/main`]: { commit: { sha: mainHead } },
      [`/repos/${repository}/compare/main...${source}`]: evidence.comparison, [`/repos/${repository}/actions/artifacts/7`]: evidence.artifact }[path];
    if (path.endsWith("/zip")) return { status: 200, arrayBuffer: async () => evidence.zip };
    return body ? { status: 200, json: async () => body } : { status: 404 };
  };
  const fetched = await fetchEvidence({ runId: "42", artifactId: "7", token: "t0k", fetch: fetcher });
  assert.deepEqual(acceptHandoff(fetched), acceptHandoff(evidence));
  assert.equal(calls.length, 5); assert(calls.every(([, , auth]) => auth === "Bearer t0k"));
  assert.deepEqual(calls.at(-1).slice(0, 2), [`https://api.github.com/repos/${repository}/actions/artifacts/7/zip`, "application/zip"]);
  await assert.rejects(fetchEvidence({ runId: "41", artifactId: "7", fetch: fetcher }), /answered 404/);
});
