#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// `npx commish` runs the CLI of the exact @commish/sdk release this package pins.
// The CLI reads process.argv itself, so importing its entry point keeps arguments,
// output streams, exit codes and interrupt handling unchanged.
const require = createRequire(import.meta.url);
const manifestPath = require.resolve("@commish/sdk/package.json");
const { bin } = require(manifestPath);
await import(pathToFileURL(join(dirname(manifestPath), bin.commish)).href);
