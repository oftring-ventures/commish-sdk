import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/publish-packages.yml", import.meta.url), "utf8");
test("publication requires manual fixed-tag dispatch and the protected environment", () => {
  const triggers = workflow.split("on:\n")[1].split("permissions:\n")[0];
  assert.match(triggers, /^  workflow_dispatch:\n/);
  assert.doesNotMatch(triggers, /^  (push|pull_request|pull_request_target|schedule|workflow_run|workflow_call):/m);
  assert.match(workflow, /if: github.repository == 'oftring-ventures\/commish-sdk' && github.ref == 'refs\/tags\/v0\.1\.0-beta\.10'/);
  assert.match(workflow, /environment: npm-publication\n/);
  assert.match(workflow, /group: npm-publication-beta10\n  cancel-in-progress: false/);
  assert.match(workflow, /jobs:\n  publish:/);
});

test("only the publication job receives OIDC; no package install or token fallback runs", () => {
  const [beforeJobs, jobs] = workflow.split("jobs:\n");
  assert.doesNotMatch(beforeJobs, /id-token|write/);
  assert.match(jobs, /permissions:\n      contents: read\n      actions: read\n      id-token: write\n/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|registry-url:|npm install|pnpm install|npm publish|contents: write/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: 24\.15\.0/);
  for (const match of workflow.matchAll(/uses: ([^\n]+)/g)) assert.match(match[1], /@[a-f0-9]{40}(?: |$)/);
});

test("approval is independent of artifact inputs and shell receives IDs through environment only", () => {
  for (const name of ["SOURCE", "MANIFEST_SHA256", "CI_RECEIPT_SHA256"])
    assert(workflow.includes("COMMISH_NPM_APPROVED_" + name + ": ${{ vars.COMMISH_NPM_APPROVED_" + name + " }}"));
  assert(workflow.includes("COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256: ${{ vars.COMMISH_NPM_HOSTED_ACCEPTANCE_SHA256 }}"));
  assert(workflow.includes("CANDIDATE_RUN_ID: ${{ inputs.candidate_run_id }}"));
  assert(workflow.includes("CANDIDATE_ARTIFACT_ID: ${{ inputs.candidate_artifact_id }}"));
  const commands = workflow.split("\n").filter((line) => line.trimStart().startsWith("run:"));
  assert.equal(commands.length, 1); assert(!commands[0].includes("${{"));
  assert(commands[0].includes('node scripts/publication-executor.mjs "$CANDIDATE_RUN_ID" "$CANDIDATE_ARTIFACT_ID" --publish'));
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/publication-receipt.json/);
});
