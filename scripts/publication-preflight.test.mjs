import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { candidateScopes } from "./public-candidate.mjs";
import { isMissingRegistryVersion, publicationPlan, readPublicationCandidate, requirePublicationApproval } from "./publication-preflight.mjs";

const hash = (data, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(data).digest(encoding);
const missing = { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) };
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "commish-publication-test-")), source = "a".repeat(40);
  const artifacts = ["sdk", "next"].map((pkg) => {
    const metadata = { name: `@commish/${pkg}`, version: "0.1.0-beta.10", license: "MIT",
      repository: { url: "git+https://github.com/oftring-ventures/commish-sdk.git" }, publishConfig: { access: "public", tag: "beta" },
      ...(pkg === "next" ? { peerDependencies: { "@commish/sdk": "0.1.0-beta.10" } } : {}) };
    const payload = Buffer.from(JSON.stringify(metadata)), header = Buffer.alloc(512);
    header.write("package/package.json"); header.write("0000644", 100);
    header.write(payload.length.toString(8).padStart(11, "0"), 124); header.write("0", 156); header.fill(32, 148, 156);
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0"), 148);
    const bytes = gzipSync(Buffer.concat([header, payload, Buffer.alloc((512 - payload.length % 512) % 512 + 1024)])); bytes[9] = 255;
    const file = `commish-${pkg}-${metadata.version}.tgz`; writeFileSync(join(directory, file), bytes);
    return { name: metadata.name, version: metadata.version, file, bytes: bytes.length, sha512: hash(bytes, "sha512"),
      integrity: `sha512-${hash(bytes, "sha512", "base64")}`,
      members: [{ name: "package/package.json", bytes: payload.length, mode: 0o644, sha512: hash(payload, "sha512") }] };
  });
  const manifest = { source, status: "local-artifacts-verified", npmPublished: false, hostedAccepted: false,
    node: "v24.15.0", consumerScopes: candidateScopes, artifacts };
  const save = (file, value) => writeFileSync(join(directory, file), JSON.stringify(value));
  save("manifest.json", manifest);
  writeFileSync(join(directory, "SHA512SUMS"), artifacts.map((a) => `${a.sha512}  ${a.file}\n`).join(""));
  const ci = { repository: "oftring-ventures/commish-sdk", source, manifestSha256: hash(readFileSync(join(directory, "manifest.json"))),
    node: manifest.node, runner: { os: "Linux", arch: "X64" }, job: "source", runId: "123", runAttempt: "1",
    npmPublished: false, hostedAccepted: false, artifacts: artifacts.map(({ file, bytes, sha512 }) => ({ file, bytes, sha512 })) };
  save("ci-receipt.json", ci);
  const approved = { source, manifestSha256: ci.manifestSha256, ciReceiptSha256: hash(readFileSync(join(directory, "ci-receipt.json"))) };
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: ci.repository, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_JOB: "publish",
    RUNNER_OS: "Linux", RUNNER_ARCH: "X64", COMMISH_NPM_ENVIRONMENT: "npm-publication", GITHUB_SHA: source, GITHUB_WORKFLOW_SHA: source,
    GITHUB_REF: "refs/tags/v0.1.0-beta.10", GITHUB_WORKFLOW_REF: `${ci.repository}/.github/workflows/publish-packages.yml@refs/tags/v0.1.0-beta.10`,
    COMMISH_NPM_APPROVED_SOURCE: source, COMMISH_NPM_APPROVED_MANIFEST_SHA256: approved.manifestSha256,
    COMMISH_NPM_APPROVED_CI_RECEIPT_SHA256: approved.ciReceiptSha256, COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256: "b".repeat(64) };
  try { run({ directory, approved, env, manifest, save }); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("accepted candidate binds pair, every member and CI receipt; plans default to dry-run", () => fixture(({ directory, approved }) => {
  const candidate = readPublicationCandidate(directory, approved), plan = publicationPlan(candidate, [missing, missing]);
  assert.deepEqual(plan.map((p) => p.name), ["@commish/sdk", "@commish/next"]);
  for (const item of plan) assert.deepEqual(item.argv.slice(2), ["--ignore-scripts", "--access=public", "--tag=beta", "--dry-run", "--registry=https://registry.npmjs.org"]);
  assert.throws(() => publicationPlan(candidate, [missing, missing], { publish: true }));
}));

test("changed approval, archive, receipt, inventory, checksums and symlinks are rejected", () => {
  for (const mutate of [
    (f) => { f.approved.source = "b".repeat(40); },
    (f) => { f.approved.manifestSha256 = "b".repeat(64); },
    (f) => { f.approved.ciReceiptSha256 = "b".repeat(64); },
    (f) => writeFileSync(join(f.directory, f.manifest.artifacts[0].file), "changed"),
    (f) => writeFileSync(join(f.directory, "SHA512SUMS"), "changed"),
    (f) => writeFileSync(join(f.directory, "extra"), "extra"),
    (f) => { const path = join(f.directory, "SHA512SUMS"); rmSync(path); symlinkSync("manifest.json", path); },
    (f) => { f.manifest.artifacts[0].members[0].mode = 0o755; f.save("manifest.json", f.manifest);
      f.approved.manifestSha256 = hash(readFileSync(join(f.directory, "manifest.json"))); },
  ]) fixture((f) => { mutate(f); assert.throws(() => readPublicationCandidate(f.directory, f.approved)); });
});

test("publication requires each exact protected identity and separate acceptance field", () => fixture(({ directory, approved, env }) => {
  const candidate = readPublicationCandidate(directory, approved); requirePublicationApproval(candidate, env);
  for (const key of Object.keys(env)) assert.throws(() => requirePublicationApproval(candidate, { ...env, [key]: "wrong" }), key);
  assert.throws(() => requirePublicationApproval(candidate, { ...env, GITHUB_REF: "refs/tags/unrelated",
    GITHUB_WORKFLOW_REF: "oftring-ventures/commish-sdk/.github/workflows/publish-packages.yml@refs/tags/unrelated" }));
  const plan = publicationPlan(candidate, [missing, missing], { publish: true, env });
  assert(plan.every((p) => p.argv.includes("--provenance") && !p.argv.includes("--dry-run")));
}));

test("whole-pair registry preflight refuses mismatch and resumes only identical existing versions", () => fixture(({ directory, approved, env }) => {
  const candidate = readPublicationCandidate(directory, approved), same = candidate.artifacts.map((a) => ({ status: 0, stdout: JSON.stringify(a.integrity) }));
  assert.deepEqual(publicationPlan(candidate, same, { publish: true, env }), []);
  assert.deepEqual(publicationPlan(candidate, [same[0], missing], { publish: true, env }).map((p) => p.name), ["@commish/next"]);
  assert.deepEqual(publicationPlan(candidate, [missing, same[1]], { publish: true, env }).map((p) => p.name), ["@commish/sdk"]);
  for (const bad of [{ status: 0, stdout: '"sha512-different"' }, { status: 0, stdout: "bad JSON" },
    { status: 1, stderr: "network unavailable" }, { ...same[1], signal: "SIGTERM" }])
    assert.throws(() => publicationPlan(candidate, [missing, bad], { publish: true, env }));
  assert.throws(() => publicationPlan(candidate, [missing]));
}));

test("registry absence requires structured E404 without process failure or contradictory errors", () => {
  assert(isMissingRegistryVersion(missing)); assert(isMissingRegistryVersion({ status: 1, stderr: missing.stdout }));
  assert(isMissingRegistryVersion({ ...missing, stderr: "npm error E404" }));
  for (const result of [{ status: 0, stdout: missing.stdout }, { ...missing, signal: "SIGTERM" },
    { ...missing, error: new Error("spawn") }, { ...missing, stderr: '{"error":{"code":"E401"}}' },
    { status: 1, stdout: "invalid" }, { status: 1, stderr: '{"error":{"code":"E503"}}' }])
    assert.equal(isMissingRegistryVersion(result), false);
});
