import assert from "node:assert/strict";
import test from "node:test";
import { releaseVersion, stableReleaseVersion } from "./stable-release.mjs";

test("stable releases have one exact semantic version without a prerelease tag", () => {
  assert.equal(releaseVersion, "0.1.0");
  for (const version of ["0.1.0", "0.2.0", "1.0.0", "12.34.56"])
    assert.equal(stableReleaseVersion(version), version);
  for (const version of [undefined, 1, "", "latest", "1.0", "v1.0.0", "01.0.0",
    "1.0.0-beta.1", "1.0.0+build", "1.0.0\n", "1.0.0/../../file", "9007199254740992.0.0"])
    assert.throws(() => stableReleaseVersion(version));
});
