import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const automation = [
  ".github/workflows/public-source.yml",
  ".github/workflows/public-review.yml",
  ".github/workflows/public-review-merge-group.yml",
  "scripts/verify-public-source.mjs",
  "scripts/verify-public-source.test.mjs",
];
const bootstrap = {
  ".gitignore": "e8e70120c7fb8891ed746bb896e739a62f7f6ea1df6225461506760c146f6614",
  LICENSE: "03f0077d06d3281e364be7f1cbb440d6996c65d3a6a19a73de41a7c6d02be702",
  "README.md": "e54066163aa6be032484c7193f096cbcd0d9a57b55d65a9b4d4c8bc27382972e",
};

export function inspect(files) {
  const allowed = [...Object.keys(bootstrap), ...automation];
  assert.equal(files.size, allowed.length, "only the exact bootstrap is supported");
  for (const [name, file] of files) {
    assert(allowed.includes(name), "package or unexpected source is not supported");
    assert.equal(file.mode, "100644", "invalid bootstrap source mode");
    if (bootstrap[name]) {
      const hash = createHash("sha256").update(file.data).digest("hex");
      assert.equal(hash, bootstrap[name], "bootstrap bytes differ");
    }
  }
  return [];
}

export function verify(root, expectedSha) {
  const git = (...args) => execFileSync("git", args, { cwd: root });
  const head = git("rev-parse", "HEAD").toString().trim();
  assert(
    /^[a-f0-9]{40}$/.test(expectedSha ?? "") && head === expectedSha,
    "checked-out SHA does not match expected SHA",
  );
  assert.equal(
    git("status", "--porcelain", "--untracked-files=all").length,
    0,
    "source checkout must be clean",
  );
  assert.equal(process.versions.node, "24.15.0", "Node must be 24.15.0");
  const files = new Map(
    git("ls-tree", "-rz", "HEAD")
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const [metadata, name] = entry.split("\t"),
          [mode, type, oid] = metadata.split(" ");
        assert.equal(type, "blob", "source must contain only regular files");
        return [name, { mode, data: git("cat-file", "blob", oid) }];
      }),
  );
  inspect(files);
  return {
    sha: head,
    scope: "exact-bootstrap-and-automation",
    packages: [],
    consumerChecks: false,
    publication: false,
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(verify(process.cwd(), process.env.EXPECTED_SHA)));
  } catch {
    console.error("Public source verification failed; no acceptance receipt issued.");
    process.exitCode = 1;
  }
}
