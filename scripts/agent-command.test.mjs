import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { markers } from "../packages/sdk/bin/agent-command.mjs";

const executable = fileURLToPath(new URL("../packages/sdk/bin/init.mjs", import.meta.url));
const source = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const { version } = JSON.parse(source("packages/sdk/package.json"));
const skill = ".claude/skills/commish/SKILL.md";
function repository(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "commish-agent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries({
    "package.json": '{"name":"shop"}',
    "pnpm-lock.yaml": "",
    ...files,
  })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  return root;
}
const run = (root, ...args) =>
  spawnSync(process.execPath, [executable, "agent", "setup", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH },
  });
function receipt(root, ...args) {
  const result = run(root, ...args, "--json");
  assert.deepEqual([result.status, result.stderr], [0, ""], result.stderr);
  return JSON.parse(result.stdout);
}
const statuses = (output) => output.files.map(({ path, status }) => `${path}: ${status}`);
const text = (root, name) => readFileSync(join(root, name), "utf8");
const tree = (root) => readdirSync(root, { recursive: true }).sort();
// The playbook sections, read the way a person would: by heading.
function playbook(root, heading) {
  const { stdout } = spawnSync(process.execPath, [executable, "init"], {
    cwd: root,
    encoding: "utf8",
  });
  return stdout.split(`## ${heading}\n`)[1].split("\n## ")[0].trim();
}

test("the default run plans both files and writes nothing", (t) => {
  const root = repository(t, { ".env": "SECRET=private-fixture" });
  const before = tree(root);
  const plan = receipt(root);
  assert.equal(plan.status, "plan");
  assert.equal(plan.action, "install");
  assert.equal(plan.sdkVersion, version);
  assert.deepEqual(
    [plan.mutations, plan.networkRequests, plan.integrationVerified],
    [false, false, false],
  );
  assert.deepEqual(statuses(plan), ["AGENTS.md: create", `${skill}: create`]);
  assert.deepEqual(plan.nextSteps, ["rerun_the_same_arguments_with_--write"]);
  assert.equal(plan.claudeMd, "absent");
  assert.match(run(root).stdout, /^Commish agent guidance plan \(use --write to apply\)/);
  assert.deepEqual(tree(root), before);
});

test("--write creates the section and the skill from the playbook, and a rerun changes nothing", (t) => {
  const root = repository(t, { ".env": "SECRET=private-fixture" });
  const written = receipt(root, "--write");
  assert.equal(written.status, "files_installed");
  assert.equal(written.mutations, true);
  assert.deepEqual(statuses(written), ["AGENTS.md: created", `${skill}: created`]);
  const agents = text(root, "AGENTS.md"),
    body = text(root, skill);
  assert(agents.startsWith(`${markers.begin}\n## Commish\n`));
  assert(agents.endsWith(`\n${markers.end}\n`));
  // One source: every rule, the report line and the steps are the playbook's own text.
  const rules = playbook(root, "Rules");
  assert.equal(rules.split("\n").length, 4);
  for (const output of [agents, body]) {
    assert(output.includes(rules));
    assert(output.includes(playbook(root, "Report")));
    assert(!output.includes("private-fixture"));
  }
  for (const heading of ["Steps", "References"])
    assert(body.includes(`## ${heading}\n\n${playbook(root, heading)}\n`), heading);
  // Version-matched: the skill names this release and pins nothing else.
  assert.match(body, /^---\nname: commish\ndescription: [^\n]+\n---\n/);
  assert(body.includes(`# Commish ${version}\n`));
  assert(agents.includes(`\`@commish/sdk@${version}\``));
  for (const pin of `${agents}${body}`.match(/@commish\/(?:sdk|next)@[0-9][^\s`]*|blob\/v[^/]+/g))
    assert(pin.endsWith(`@${version}`) || pin === `blob/v${version}`, pin);
  assert(body.includes("pnpm exec commish agent setup --write"));
  const again = receipt(root, "--write");
  assert.equal(again.mutations, false);
  assert.deepEqual(statuses(again), ["AGENTS.md: unchanged", `${skill}: unchanged`]);
  assert.deepEqual(again.nextSteps, []);
  assert.deepEqual([text(root, "AGENTS.md"), text(root, skill)], [agents, body]);
  assert.deepEqual(tree(root), [
    ".claude",
    ".claude/skills",
    ".claude/skills/commish",
    skill,
    ".env",
    "AGENTS.md",
    "package.json",
    "pnpm-lock.yaml",
  ]);
});

test("an existing AGENTS.md keeps every byte outside the markers, through update and removal", (t) => {
  for (const existing of [
    "# Shop\n\nUse pnpm.\n",
    "# Shop\r\n\r\nUse pnpm.\r\n",
    "# Shop\n\nNo final newline",
  ]) {
    const root = repository(t, { "AGENTS.md": existing });
    const eol = existing.includes("\r\n") ? "\r\n" : "\n";
    assert.deepEqual(statuses(receipt(root, "--write")), [
      "AGENTS.md: updated",
      `${skill}: created`,
    ]);
    const installed = text(root, "AGENTS.md");
    const [before, section] = installed.split(markers.begin);
    assert.equal(before, existing.endsWith(eol) ? existing + eol : existing + eol + eol);
    assert(section.endsWith(markers.end + eol));
    assert.equal(installed.includes("\r\n"), eol === "\r\n");
    assert.equal(installed.replaceAll("\r\n", "\n").includes("\r"), false);
    // A stale or hand-edited section is replaced in place; text around it stays.
    const moved = `${before}${markers.begin}${eol}old text${eol}${markers.end}${eol}${eol}## After${eol}`;
    writeFileSync(join(root, "AGENTS.md"), moved);
    assert.deepEqual(statuses(receipt(root)), ["AGENTS.md: update", `${skill}: unchanged`]);
    assert.equal(statuses(receipt(root, "--write"))[0], "AGENTS.md: updated");
    assert.equal(text(root, "AGENTS.md"), `${installed}${eol}## After${eol}`);
    writeFileSync(join(root, "AGENTS.md"), installed);
    const removed = receipt(root, "--remove", "--write");
    assert.equal(removed.status, "files_removed");
    assert.deepEqual(statuses(removed), ["AGENTS.md: updated", `${skill}: deleted`]);
    assert.equal(text(root, "AGENTS.md"), existing.endsWith(eol) ? existing : existing + eol);
    assert(!existsSync(join(root, ".claude")));
    assert.deepEqual(statuses(receipt(root, "--remove", "--write")), [
      "AGENTS.md: unchanged",
      `${skill}: absent`,
    ]);
  }
});

test("removal restores a repository that had neither file and leaves other skills alone", (t) => {
  const root = repository(t);
  const before = tree(root);
  receipt(root, "--write");
  assert.deepEqual(statuses(receipt(root, "--remove")), ["AGENTS.md: delete", `${skill}: delete`]);
  assert(existsSync(join(root, skill)));
  assert.deepEqual(statuses(receipt(root, "--remove", "--write")), [
    "AGENTS.md: deleted",
    `${skill}: deleted`,
  ]);
  assert.deepEqual(tree(root), before);
  const shared = repository(t, { ".claude/skills/other/SKILL.md": "custom" });
  receipt(shared, "--write");
  receipt(shared, "--remove", "--write");
  assert.deepEqual(readdirSync(join(shared, ".claude/skills")), ["other"]);
  // A skill this command did not write is neither replaced nor removed.
  const custom = repository(t, { [skill]: "my own skill\n" });
  assert.equal(statuses(receipt(custom, "--remove", "--write"))[1], `${skill}: unchanged`);
  assert.equal(text(custom, skill), "my own skill\n");
});

test("conflicts change no file and report a reason without echoing content", (t) => {
  const target = repository(t, { "REAL.md": "private-fixture\n" });
  symlinkSync("REAL.md", join(target, "AGENTS.md"));
  for (const [root, path, reason] of [
    [repository(t, { [skill]: "private-fixture\n" }), skill, "not_written_by_commish"],
    [
      repository(t, { "AGENTS.md": `${markers.end}\nprivate-fixture\n${markers.begin}\n` }),
      "AGENTS.md",
      "markers_malformed",
    ],
    [
      repository(t, { "AGENTS.md": `${markers.begin}\n${markers.begin}\n${markers.end}\n` }),
      "AGENTS.md",
      "markers_malformed",
    ],
    [
      repository(t, { "AGENTS.md": `private-fixture ${markers.begin}\n` }),
      "AGENTS.md",
      "markers_malformed",
    ],
    [target, "AGENTS.md", "unsafe_file_path"],
  ]) {
    const before = tree(root).map((name) => [name, existsSync(join(root, name))]);
    const contents = text(root, path);
    for (const args of [["--json"], ["--write", "--json"], ["--write"]]) {
      const result = run(root, ...args);
      assert.deepEqual([result.status, result.stdout], [1, ""], `${reason} ${args}`);
      assert(!result.stderr.includes("private-fixture"));
      if (!args.includes("--json")) continue;
      const error = JSON.parse(result.stderr);
      assert.equal(error.code, "agent_guidance_conflict");
      assert.deepEqual(
        error.files.find((file) => file.status === "conflict"),
        { path, status: "conflict", reason },
      );
    }
    assert.deepEqual(
      tree(root).map((name) => [name, existsSync(join(root, name))]),
      before,
    );
    assert.equal(text(root, path), contents);
  }
});

test("a linked skill directory is refused before anything is written", (t) => {
  const root = repository(t, { "elsewhere/keep": "" });
  symlinkSync("elsewhere", join(root, ".claude"));
  const result = run(root, "--write", "--json");
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr).files, [
    { path: "AGENTS.md", status: "create" },
    { path: skill, status: "conflict", reason: "unsafe_file_path" },
  ]);
  assert(!existsSync(join(root, "AGENTS.md")));
  assert.deepEqual(readdirSync(join(root, "elsewhere")), ["keep"]);
});

test("CLAUDE.md is reported and never edited", (t) => {
  for (const [body, state] of [
    ["# Claude\n", "agents_md_not_referenced"],
    ["@AGENTS.md\n", "references_agents_md"],
  ]) {
    const root = repository(t, { "CLAUDE.md": body });
    const written = receipt(root, "--write");
    assert.equal(written.claudeMd, state);
    assert.equal(
      written.nextSteps.includes("reference_agents_md_from_claude_md"),
      state === "agents_md_not_referenced",
    );
    assert.equal(
      /CLAUDE\.md does not mention AGENTS\.md/.test(run(root).stdout),
      state === "agents_md_not_referenced",
    );
    assert.equal(text(root, "CLAUDE.md"), body);
    assert.deepEqual(receipt(root, "--remove").nextSteps, [
      "rerun_the_same_arguments_with_--write",
    ]);
  }
  const linked = repository(t);
  symlinkSync("AGENTS.md", join(linked, "CLAUDE.md"));
  assert.equal(receipt(linked).claudeMd, "references_agents_md");
});

test("arguments are closed, help is local, and the CLI lists the command", (t) => {
  const root = repository(t);
  const before = tree(root);
  for (const args of [
    ["--private-fixture"],
    ["private-fixture"],
    ["--write", "--write"],
    ["--help", "--write"],
  ]) {
    const refused = run(root, ...args, "--json");
    assert.deepEqual([refused.status, refused.stdout], [1, ""]);
    assert.deepEqual(JSON.parse(refused.stderr), { status: "error", code: "invalid_arguments" });
  }
  assert.match(run(root, "--bad").stderr, /^Usage: commish agent setup \[--write\]/);
  const help = run(root, "--help");
  assert.deepEqual([help.status, help.stderr], [0, ""]);
  assert.match(help.stdout, /^Usage: commish agent setup \[--write\] \[--remove\] \[--json\]\n/);
  const described = receipt(root, "-h");
  assert.equal(described.status, "help");
  assert.deepEqual(described.files, ["AGENTS.md", skill]);
  assert.deepEqual(described.markers, markers);
  const cli = (...args) =>
    spawnSync(process.execPath, [executable, ...args], { cwd: root, encoding: "utf8" });
  assert(JSON.parse(cli("--help", "--json").stdout).commands.includes(described.command));
  assert.match(cli("--help").stdout, /\ncommish agent setup \[--write\] — /);
  assert.match(cli("init").stdout, /`pnpm exec commish agent setup` plans/);
  // The workflow guide keeps its command.
  assert.equal(JSON.parse(cli("agent", "--json").stdout).guideVersion, 2);
  assert.deepEqual(tree(root), before);
});
