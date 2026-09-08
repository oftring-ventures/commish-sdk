import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("./", import.meta.url);
rmSync(new URL("dist/", root), { recursive: true, force: true });
const result = spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
