import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { verifySdkTypes } from "./verify-sdk-types.mjs";
import { verifySdkWebhooks } from "./verify-sdk-webhooks.mjs";
import { verifySdkHttp } from "./verify-sdk-http.mjs";

export const browserConsumerScope = "sdk-browser-node-primitives";
const contained = (root, path) => {
  const part = relative(root, realpathSync(path));
  assert(
    part && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`),
    "external consumer resolution",
  );
};
async function browserProbe() {
  const { default: assert } = await import("node:assert/strict");
  const { captureReferral } = await import("@commish/sdk/browser");
  for (const name of ["@commish/sdk", "@commish/sdk/webhooks", "@commish/sdk/dist/browser.js"])
    await assert.rejects(import(name), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  const options = { publishableKey: "cm_test_pk_123456789012", applicationId: "app_123456789012" };
  assert.equal(await captureReferral(options), false);
  const state = { consumer: "fixture" },
    storage = new Map(),
    requests = [];
  globalThis.window = {
    location: { href: "https://consumer.example.test/?commish_ref=ref_fixture" },
    sessionStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
    history: {
      state,
      replaceState(next, unused, url) {
        assert.equal(next, state);
        window.location.href = String(url);
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ data: { captured: true } });
  };
  assert.equal(
    await captureReferral({ ...options, capturePath: "https://foreign.example.test/capture" }),
    false,
  );
  assert.equal(await captureReferral({ ...options, publishableKey: "invalid" }), false);
  assert.equal(requests.length, 0);
  assert.equal(await captureReferral(options), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://consumer.example.test/api/commish/attribution");
  const { init } = requests[0],
    headers = new Headers(init.headers);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "same-origin");
  assert.equal(headers.get("x-commish-publishable-key"), options.publishableKey);
  assert.match(headers.get("x-commish-capture-id"), /^[0-9a-f]{32}$/);
  assert.deepEqual(JSON.parse(init.body), {
    token: "ref_fixture",
    applicationId: options.applicationId,
  });
  assert.equal(new URL(window.location.href).searchParams.has("commish_ref"), false);
  window.location.href = "https://consumer.example.test/?commish_ref=ref_retry";
  globalThis.fetch = async () => Response.json({}, { status: 503 });
  assert.equal(await captureReferral(options), false);
  assert.equal(new URL(window.location.href).searchParams.get("commish_ref"), "ref_retry");
  let finish;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = captureReferral(options),
    second = captureReferral(options);
  assert.equal(first, second);
  finish(Response.json({ data: { captured: true } }));
  assert.equal(await first, true);
  assert.equal(new URL(window.location.href).searchParams.has("commish_ref"), false);
}

// The caller has validated this exact archive and its entries with archiveFiles.
export function verifySdkBrowserConsumer(
  archive,
  packed,
  run = (command, args, cwd) =>
    execFileSync(command, args, { cwd, stdio: "inherit", timeout: 120_000 }),
  context,
) {
  const manifest = JSON.parse(packed.get("package/package.json").data);
  assert.equal(manifest.name, "@commish/sdk");
  assert.equal(manifest.version, "0.1.0-beta.9");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"])
    assert.deepEqual(manifest[field] ?? {}, {}, "SDK consumer requires an empty runtime closure");
  assert.deepEqual(manifest.exports["./browser"], {
    types: "./dist/browser.d.ts",
    default: "./dist/browser.js",
  });
  for (const name of ["package/dist/browser.js", "package/dist/browser.d.ts"])
    assert(packed.has(name), "missing promised browser artifact");
  const consumer = realpathSync(mkdtempSync(join(tmpdir(), "commish-sdk-consumer-")));
  try {
    writeFileSync(join(consumer, "sdk.tgz"), archive);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        packageManager: "pnpm@11.1.3",
        dependencies: { "@commish/sdk": "file:./sdk.tgz" },
      }),
    );
    run(
      "pnpm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--ignore-workspace",
        "--config.auto-install-peers=false",
      ],
      consumer,
    );
    const modules = join(consumer, "node_modules"),
      installed = join(modules, "@commish/sdk");
    contained(consumer, installed);
    assert.deepEqual(
      readdirSync(modules).filter((name) => !name.startsWith(".")),
      ["@commish"],
    );
    assert.deepEqual(readdirSync(join(modules, "@commish")), ["sdk"]);
    const store = join(modules, ".pnpm");
    assert.equal(
      readdirSync(store, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && entry.name !== "node_modules",
      ).length,
      1,
      "unexpected installed dependency",
    );
    for (const [name, entry] of packed) {
      const path = join(installed, name.slice("package/".length));
      contained(consumer, path);
      assert(
        readFileSync(path).equals(entry.data),
        "installed artifact differs from verified archive",
      );
    }
    writeFileSync(join(consumer, "probe.mjs"), `await (${browserProbe.toString()})();\n`);
    run(process.execPath, ["--conditions=browser", "probe.mjs"], consumer);
    const http = verifySdkHttp(consumer, packed);
    const types = verifySdkTypes(consumer, packed, context);
    const webhooks = verifySdkWebhooks(consumer, packed);
    return { ...types, scopes: [browserConsumerScope, ...types.scopes, ...webhooks, ...http] };
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}
