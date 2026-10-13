import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The reviewed toolchain is declared once: Node in .node-version (also read by
// the workflows' setup-node step) and pnpm in the root manifest's packageManager
// (read by pnpm/action-setup). Release scripts compare against these values.
const root = new URL("../", import.meta.url);
export const nodeVersion = readFileSync(new URL(".node-version", root), "utf8").trim();
assert.match(nodeVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/, "unsupported .node-version");
const { packageManager } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
export const pnpmVersion = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(packageManager ?? "")?.[1];
assert(pnpmVersion, "root packageManager must pin an exact pnpm version");
