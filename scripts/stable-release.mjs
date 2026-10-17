import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function stableReleaseVersion(version) {
  assert.equal(typeof version, "string");
  assert.match(
    version,
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
    "publication requires a stable semantic version",
  );
  assert(
    version.split(".").every((part) => Number.isSafeInteger(Number(part))),
    "release version exceeds the supported range",
  );
  return version;
}

// The release version is the SDK manifest's. The source verifier requires the Next
// manifest to carry the same version; approval still binds source SHA, exact archives and CI.
const manifest = JSON.parse(
  readFileSync(new URL("../packages/sdk/package.json", import.meta.url), "utf8"),
);
export const releaseVersion = stableReleaseVersion(manifest.version);

// The archive name pnpm pack gives a package: `@commish/sdk` → `commish-sdk-<version>.tgz`.
export const archiveName = (name, version) =>
  `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
// Every published package, in upload order. The candidate writer, CI receipt, handoff
// and preflight read names and archives from here rather than from list positions.
export const releaseArtifacts = ["@commish/sdk", "@commish/next"].map((name) => ({
  name,
  file: archiveName(name, releaseVersion),
}));
