#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const appRouter = existsSync(resolve(root, "src/app"))
  ? "src/app"
  : existsSync(resolve(root, "app"))
    ? "app"
    : null;
console.log("Commish Next.js initializer (dry run)");
if (!appRouter) {
  console.error("No Next.js App Router directory found. No files changed.");
  process.exitCode = 1;
} else {
  console.log(`Would add ${appRouter}/api/commish/attribution/route.ts`);
  console.log(`Would wrap ${appRouter}/layout.tsx with CommishProvider`);
  console.log(
    "Dry run only in v0.1. Apply the documented changes after reviewing them.",
  );
}
