import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { frameworkRegistryBinHash, verifyFrameworkPackage } from "./verify-framework-package.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");
// Fixed pinned-pnpm output, reconstructed independently from the retained actual shim hash.
const template = readFileSync(new URL("./fixtures/next-peer-bin.txt", import.meta.url), "utf8");
function fixture(sdk, cli, run) {
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "commish-peer-bin-")));
  const store = join(consumer, "node_modules/.pnpm");
  const modules = join(store, "local-pair/node_modules");
  const root = join(modules, "@commish", sdk ? "sdk" : "next");
  const next = join(store, "next16/node_modules/next");
  const write = (path, value, mode = 0o644) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value, { mode });
  };
  const manifest = {
    name: sdk ? "@commish/sdk" : "@commish/next",
    ...(cli ? { bin: { "commish-next": "./bin/init.mjs" } } : {}),
  };
  const packed = new Map([
    ["package/package.json", { data: Buffer.from(JSON.stringify(manifest)), mode: 0o644 }],
    [
      "package/dist/provider.js",
      { data: Buffer.from("export const fixture = true;\n"), mode: 0o644 },
    ],
    ...(cli
      ? [
          [
            "package/bin/init.mjs",
            { data: Buffer.from("#!/usr/bin/env node\n// Never executed.\n"), mode: 0o755 },
          ],
        ]
      : []),
  ]);
  try {
    write(join(consumer, "package.json"), "{}");
    for (const [name, member] of packed) write(join(root, name.slice(8)), member.data, member.mode);
    const nextManifest = JSON.stringify({
      name: "next",
      version: "16.3.4",
      bin: { next: "./dist/bin/next" },
    });
    const nextBin = "#!/usr/bin/env node\n// Fixture target; never executed.\n";
    write(join(next, "package.json"), nextManifest);
    write(join(next, "dist/bin/next"), nextBin, 0o755);
    mkdirSync(join(store, "node_modules"), { recursive: true });
    symlinkSync(next, join(consumer, "node_modules/next"));
    symlinkSync(next, join(modules, "next"));
    const registry = [
      [
        "next@16.3.4",
        relative(consumer, next),
        [
          ["package.json", hash(nextManifest), 0o644],
          ["dist/bin/next", hash(nextBin), 0o755],
        ],
      ],
    ];
    const shim = (name, source, sourceModules, targetName, owner = root) => {
      const path = join(owner, "node_modules/.bin", name),
        target = join(source, targetName);
      const paths = [join(source, "node_modules"), sourceModules, join(store, "node_modules")].join(
        ":",
      );
      write(
        path,
        template
          .replaceAll("@@NODE_PATH@@", paths)
          .replaceAll("@@RELATIVE_TARGET@@", relative(dirname(path), target))
          .replaceAll("@@TARGET@@", target),
        0o755,
      );
      return path;
    };
    const bins = sdk ? [] : [shim("next", next, dirname(next), "dist/bin/next")];
    if (cli) bins.push(shim("commish-next", root, modules, "bin/init.mjs", consumer));
    const verify = () => verifyFrameworkPackage(consumer, root, { packed }, registry);
    run({ consumer, root, next, bins, verify, write });
  } finally {
    rmSync(consumer, { recursive: true, force: true });
    assert(!existsSync(consumer));
  }
}

test("exact SDK payload and S7/S9 installer bins retain complete archive verification", () => {
  for (const [sdk, cli, names] of [
    [true, false, []],
    [false, false, ["next"]],
    [false, true, ["next", "commish-next"]],
  ])
    fixture(sdk, cli, ({ consumer, bins, verify }) => {
      const evidence = verify();
      assert.deepEqual(
        evidence.map((entry) => entry.name),
        names.map((name) => `node_modules/.bin/${name}`),
      );
      for (const [index, entry] of evidence.entries()) {
        assert.equal(entry.mode, 0o755);
        assert.equal(entry.sha256, hash(readFileSync(bins[index])));
        assert.equal(entry.targetSha256, hash(readFileSync(entry.target)));
        assert(entry.target.startsWith(consumer + "/"));
      }
    });
});

test("bin tampering, extra members, links and changed source or payload cannot be ignored", () => {
  const cases = [
    [
      (f) => f.write(f.bins[0], readFileSync(f.bins[0], "utf8") + "echo changed\n"),
      /generated bin content differs/,
    ],
    [(f) => chmodSync(f.bins[0], 0o644), /invalid bin type\/mode/],
    [
      (f) => {
        rmSync(f.bins[0]);
        symlinkSync(join(f.next, "dist/bin/next"), f.bins[0]);
      },
      /inventory contains a link/,
    ],
    [
      (f) => f.write(join(f.root, "node_modules/.bin/node"), "unexpected", 0o755),
      /member inventory differs/,
    ],
    [
      (f) => f.write(join(f.root, "node_modules/extra.js"), "unexpected"),
      /member inventory differs/,
    ],
    [(f) => f.write(join(f.root, "dist/provider.js"), "changed"), /installed pair differs/],
    [(f) => chmodSync(join(f.root, "dist/provider.js"), 0o755), /pair mode differs/],
    [
      (f) => f.write(join(f.next, "dist/bin/next"), "#!/usr/bin/env node\n// changed\n"),
      /bin source bytes changed/,
    ],
    [
      (f) =>
        f.write(f.bins[1], readFileSync(f.bins[1], "utf8").replace("init.mjs", "elsewhere.mjs")),
      /generated bin content differs/,
    ],
    [(f) => chmodSync(f.bins[1], 0o644), /invalid bin type\/mode/],
    [(f) => {
      rmSync(f.bins[1]);
      symlinkSync(join(f.root, "bin/init.mjs"), f.bins[1]);
    }, /invalid bin type\/mode/],
    [(f) => f.write(join(f.root, "node_modules/.bin/commish-next"), "unexpected", 0o755),
      /member inventory differs/],
  ];
  for (const [mutate, error] of cases)
    fixture(false, true, (f) => {
      mutate(f);
      assert.throws(f.verify, error);
    });
  fixture(true, false, (f) => {
    f.write(join(f.root, "node_modules/.bin/next"), "unexpected");
    assert.throws(f.verify, /member inventory differs/);
  });
});

test("frozen peer-link shim resolves to the same verified executable", () => {
  fixture(false, false, (f) => {
    const target = join(f.next, "dist/bin/next");
    const peer = join(dirname(dirname(f.root)), "next");
    const program = join(peer, "dist/bin/next");
    const content = readFileSync(f.bins[0], "utf8")
      .replaceAll(relative(dirname(f.bins[0]), target), relative(dirname(f.bins[0]), program))
      .replace(`# cmd-shim-target=${target}`, `# cmd-shim-target=${program}`);
    f.write(f.bins[0], content);
    assert.equal(f.verify()[0].target, target);
    f.write(f.bins[0], content.replace("exec node", "echo changed; exec node"));
    assert.throws(f.verify, /generated bin content differs/);
    f.write(f.bins[0], content);
    rmSync(peer);
    symlinkSync(f.root, peer);
    assert.throws(f.verify);
  });
});

test("registry launcher normalization preserves code and executable identity checks", () => {
  fixture(false, false, (f) => {
    const name = "baseline-browser-mapping";
    const source = join(f.consumer, "node_modules/.pnpm/baseline/node_modules", name);
    const peer = join(dirname(f.next), name);
    f.write(join(source, "package.json"), JSON.stringify({ name, bin: { [name]: "cli.js" } }));
    f.write(join(source, "cli.js"), "#!/usr/bin/env node\n", 0o755);
    symlinkSync(source, peer);
    const bin = join(f.next, "node_modules/.bin", name);
    const paths = [join(source, "node_modules"), dirname(source),
      join(f.consumer, "node_modules/.pnpm/node_modules")].join(":");
    let canonical;
    for (const target of [join(source, "cli.js"), join(peer, "cli.js")]) {
      f.write(bin, template.replaceAll("@@NODE_PATH@@", paths)
        .replaceAll("@@RELATIVE_TARGET@@", relative(dirname(bin), target))
        .replaceAll("@@TARGET@@", target), 0o755);
      const actual = frameworkRegistryBinHash(f.consumer, f.next, name);
      canonical ??= actual;
      assert.equal(actual, canonical);
    }
    f.write(bin, readFileSync(bin, "utf8") + "echo tampered\n");
    assert.throws(() => frameworkRegistryBinHash(f.consumer, f.next, name), /bin content differs/);
    assert.throws(() => frameworkRegistryBinHash(f.consumer, f.next, "unknown"), /unexpected/);
    rmSync(peer);
    symlinkSync(f.root, peer);
    assert.throws(() => frameworkRegistryBinHash(f.consumer, f.next, name), /source identity differs/);
  });
});
