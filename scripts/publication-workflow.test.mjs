import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { npmTimeoutMs, stagingNpmVersion } from "./publication-executor.mjs";
import { releaseArtifacts } from "./stable-release.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/publish-packages.yml", import.meta.url),
  "utf8",
);
test("publication requires manual release-tag dispatch and the protected environment", () => {
  const triggers = workflow.split("on:\n")[1].split("permissions:\n")[0];
  assert.match(triggers, /^  workflow_dispatch:\n/);
  assert.doesNotMatch(
    triggers,
    /^  (push|pull_request|pull_request_target|schedule|workflow_run|workflow_call):/m,
  );
  assert(
    workflow.includes(
      "if: github.repository == 'oftring-ventures/commish-sdk' && startsWith(github.ref, 'refs/tags/v')",
    ),
  );
  assert.match(workflow, /environment: npm-publication\n/);
  assert.match(workflow, /group: npm-publication\n  cancel-in-progress: false/);
  assert.match(workflow, /jobs:\n  publish:/);
});

test("only the staging job receives OIDC and installs only its pinned CLI", () => {
  const [beforeJobs, jobs] = workflow.split("jobs:\n");
  assert.doesNotMatch(beforeJobs, /id-token|write/);
  assert.match(
    jobs,
    /permissions:\n      contents: read\n      actions: read\n      id-token: write\n/,
  );
  assert.doesNotMatch(
    workflow,
    /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|registry-url:|pnpm install|npm publish|npm stage approve|contents: write/,
  );
  const installs = workflow.split("\n").filter((line) => line.includes("npm install"));
  assert.deepEqual(installs, [
    `        run: npm install --global --ignore-scripts --registry=https://registry.npmjs.org npm@${stagingNpmVersion}`,
  ]);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version-file: \.node-version/);
  for (const match of workflow.matchAll(/uses: ([^\n]+)/g))
    assert.match(match[1], /@[a-f0-9]{40}(?: |$)/);
});

test("approval is independent of artifact inputs and shell receives IDs through environment only", () => {
  for (const name of ["SOURCE", "MANIFEST_SHA256", "CI_RECEIPT_SHA256"])
    assert(
      workflow.includes(
        "COMMISH_NPM_APPROVED_" + name + ": ${{ vars.COMMISH_NPM_APPROVED_" + name + " }}",
      ),
    );
  assert(
    workflow.includes(
      "COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256: ${{ vars.COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256 }}",
    ),
  );
  assert(workflow.includes("CANDIDATE_RUN_ID: ${{ inputs.candidate_run_id }}"));
  assert(workflow.includes("CANDIDATE_ARTIFACT_ID: ${{ inputs.candidate_artifact_id }}"));
  const commands = workflow.split("\n").filter((line) => line.trimStart().startsWith("run:"));
  assert.equal(commands.length, 2);
  assert(commands.every((line) => !line.includes("${{")));
  assert(
    commands[1].includes(
      'node scripts/publication-executor.mjs "$CANDIDATE_RUN_ID" "$CANDIDATE_ARTIFACT_ID" --stage',
    ),
  );
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/publication-receipt.json/);
  assert.match(workflow, /if: always\(\)\n        uses: actions\/upload-artifact/);
});

test("the staging job outlasts every preflight and upload", () => {
  const minutes = workflow.match(
    /\n  publish:\n(?:    .*\n)*?    timeout-minutes: ([1-9][0-9]*)\n/,
  )?.[1];
  // One toolchain check, one preflight lookup and one stage upload per package,
  // plus setup and artifact retrieval time.
  const count = releaseArtifacts.length;
  const required = (1 + 2 * count) * npmTimeoutMs + 5 * 60_000;
  assert(
    Number(minutes) * 60_000 >= required,
    "staging job timeout cannot fit every preflight and upload",
  );
});
