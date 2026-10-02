import assert from "node:assert/strict";

// Change this reviewed version together with both source manifests and their
// consumer fixtures. Approval still binds source SHA, exact archives and CI.
export function stableReleaseVersion(version) {
  assert.equal(typeof version, "string");
  assert.match(version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
    "publication requires a stable semantic version");
  assert(version.split(".").every((part) => Number.isSafeInteger(Number(part))),
    "release version exceeds the supported range");
  return version;
}

export const releaseVersion = stableReleaseVersion("0.1.0");
