import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { nextCommandScope } from "./next-command-scope.mjs";

const members = (pid) =>
  childProcess
    .execFileSync("/bin/ps", ["-axo", "pgid=,stat="], {
      encoding: "utf8",
      timeout: 5_000,
    })
    .split("\n")
    .some((row) => {
      const [group, state] = row.trim().split(/\s+/);
      return group === String(pid) && state && !state.startsWith("Z");
    });

if (process.argv[2] === "grandchild") {
  process.on("SIGTERM", () => {
    if (process.argv[3] === "late-output")
      process.stdout.write("x".repeat(3_000_000), () => process.exit(0));
  });
  process.send("ready");
  setInterval(() => {}, 1_000);
} else if (process.argv[2] === "worker") {
  process.on("SIGTERM", () => {});
  const worker = childProcess.spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "grandchild", process.argv[3]],
    {
      stdio: ["ignore", "inherit", "ignore", "ipc"],
    },
  );
  worker.once("message", () => {
    process.stdout.write("worker-ready\n");
    if (["orphan", "late-output"].includes(process.argv[3])) process.exit(0);
    if (process.argv[3] === "interrupt") process.kill(process.ppid, "SIGTERM");
  });
  setInterval(() => {}, 1_000);
} else if (process.argv[2] === "driver") {
  const [mode, root] = process.argv.slice(3),
    consumer = join(root, "consumer");
  mkdirSync(consumer);
  const scope = nextCommandScope();
  let commandError, cleanupError;
  if (mode === "unknown") {
    const original = childProcess.execFileSync;
    childProcess.execFileSync = (...args) => {
      if (args[0] === "/bin/ps") throw new Error("controlled unavailable group observation");
      return original(...args);
    };
    syncBuiltinESMExports();
  }
  try {
    const running = scope.run(process.execPath, [fileURLToPath(import.meta.url), "worker", mode], {
      cwd: consumer,
      env: process.env,
      timeout: 1_000,
    });
    writeFileSync(join(root, "owned-pid"), String(scope.receipts[0].pid));
    await running;
  } catch (error) {
    commandError = {
      message: error.message,
      reason: error.error?.message,
      interrupt: error.interrupt,
    };
  } finally {
    try {
      await scope.close(() => rmSync(consumer, { recursive: true }));
    } catch (error) {
      cleanupError = error.errors?.map((item) => item.message).join("; ") ?? error.message;
    }
  }
  console.log(
    JSON.stringify({
      commandError,
      cleanupError,
      safe: scope.safeToRemove,
      removed: !existsSync(consumer),
      receipt: scope.receipts[0],
    }),
  );
  process.exitCode = commandError || cleanupError ? 1 : 0;
} else {
  test("stream closure gates final output and removal", async () => {
    const originalSpawn = childProcess.spawn;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref() {},
    });
    childProcess.spawn = () => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    };
    syncBuiltinESMExports();
    const scope = nextCommandScope();
    let settled = false,
      removed = false;
    try {
      const running = scope
        .run(process.execPath, [], {
          cwd: process.cwd(),
          env: process.env,
          timeout: 2_000,
        })
        .then((value) => {
          settled = true;
          return value;
        });
      const finished = running.finally(() =>
        scope.close(() => {
          removed = true;
        }),
      );
      await new Promise(setImmediate);
      const beforeClose = { settled, removed, destroyed: child.stdout.destroyed };
      if (!child.stdout.destroyed) child.stdout.write("delayed owned output\n");
      if (!child.stderr.destroyed) child.stderr.write("delayed owned diagnostic\n");
      child.emit("close", 0, null);
      const output = await finished;
      assert.equal(beforeClose.settled, false, "owned command returned before pipe close");
      assert.equal(beforeClose.removed, false, "owned tree removed before pipe close");
      assert.equal(beforeClose.destroyed, false);
      assert.equal(output, "delayed owned output\n");
      assert.equal(scope.receipts[0].stderr, "delayed owned diagnostic\n");
      assert(removed && scope.safeToRemove);
    } finally {
      child.emit("close", 0, null);
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      await scope.close();
    }
  });

  test("observed absence retires the group before a numeric ID can be reused", async () => {
    const original = {
      spawn: childProcess.spawn,
      ps: childProcess.execFileSync,
      kill: process.kill,
    };
    const states = [true, false, true],
      signals = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 424243,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref() {},
    });
    childProcess.execFileSync = () => {
      const present = states.shift();
      assert(states.length, "retired group identity was queried again");
      return present ? "424243 S\n" : "";
    };
    childProcess.spawn = () => {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    };
    process.kill = (pid, signal) => {
      assert.equal(pid, -424243);
      signals.push(signal);
      return true;
    };
    syncBuiltinESMExports();
    const scope = nextCommandScope();
    try {
      await scope.run(process.execPath, [], {
        cwd: process.cwd(),
        env: process.env,
        timeout: 1000,
      });
      assert.deepEqual(states, [true], "reused group was never looked up");
      assert.deepEqual(signals, ["SIGTERM"]);
      assert(scope.receipts[0].groupAbsent);
    } finally {
      childProcess.execFileSync = () => "";
      syncBuiltinESMExports();
      await scope.close();
      childProcess.spawn = original.spawn;
      childProcess.execFileSync = original.ps;
      process.kill = original.kill;
      syncBuiltinESMExports();
    }
  });

  test("owned command captures actual output and preserves nonzero/spawn/output failures", async () => {
    const scope = nextCommandScope();
    const options = { cwd: process.cwd(), env: process.env, timeout: 2_000 };
    try {
      assert.equal(
        await scope.run(process.execPath, ["-e", "console.log('owned-output')"], options),
        "owned-output\n",
      );
      await assert.rejects(
        scope.run(
          process.execPath,
          ["-e", "console.error('owned-error');process.exit(7)"],
          options,
        ),
        (error) => {
          assert.equal(error.status, 7);
          assert.equal(error.stderr, "owned-error\n");
          assert(error.groupAbsent);
          return true;
        },
      );
      await assert.rejects(scope.run("/missing-owned-framework-command", [], options), (error) => {
        assert.equal(error.error.code, "ENOENT");
        assert(error.groupAbsent);
        return true;
      });
      await assert.rejects(
        scope.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(3000000))"], options),
        (error) => {
          assert.match(error.error.message, /output limit/);
          assert(Buffer.byteLength(error.stdout) <= 2_097_152);
          assert(error.groupAbsent);
          return true;
        },
      );
    } finally {
      await scope.close();
    }
    assert(scope.safeToRemove);
    await assert.rejects(scope.run(process.execPath, [], options), /scope unavailable/);
    const cleanup = nextCommandScope();
    await assert.rejects(
      cleanup.close(() => {
        throw new Error("controlled removal failure");
      }, new Error("original validation failure")),
      (error) => {
        assert.deepEqual(
          error.errors.map((item) => item.message),
          ["original validation failure", "controlled removal failure"],
        );
        assert(cleanup.safeToRemove);
        return true;
      },
    );
  });

  test("ordinary scope awaits descendants on exit, timeout and actual SIGTERM; unknown state retains temp", async () => {
    for (const mode of ["orphan", "timeout", "interrupt", "unknown", "late-output"]) {
      const root = mkdtempSync(join(tmpdir(), "commish-next-process-test-"));
      let pid;
      try {
        const result = childProcess.spawnSync(
          process.execPath,
          [fileURLToPath(import.meta.url), "driver", mode, root],
          {
            encoding: "utf8",
            timeout: 20_000,
            maxBuffer: 4_194_304,
          },
        );
        if (existsSync(join(root, "owned-pid")))
          pid = Number(readFileSync(join(root, "owned-pid")));
        assert(!result.error, result.error?.message);
        assert.equal(result.signal, null);
        assert.equal(result.status, mode === "orphan" ? 0 : 1);
        const outcome = JSON.parse(result.stdout);
        assert.equal(outcome.receipt.pid, pid);
        assert.match(outcome.receipt.stdout, /worker-ready/);
        if (mode === "unknown") {
          assert.equal(outcome.safe, false);
          assert.equal(outcome.removed, false);
          assert.match(outcome.cleanupError, /unavailable group observation/);
          assert(members(pid));
        } else {
          assert(outcome.safe && outcome.removed && outcome.receipt.groupAbsent);
          assert(!members(pid), "owned descendants must be absent before tree removal");
          if (mode !== "late-output")
            assert(outcome.receipt.teardown.some((entry) => entry.signal === "SIGKILL"));
          else assert.match(outcome.commandError.reason, /output limit/);
          if (mode === "timeout") assert.match(outcome.commandError.reason, /timed out/);
          if (mode === "interrupt") assert.equal(outcome.commandError.interrupt, "SIGTERM");
        }
      } finally {
        if (pid && members(pid)) {
          process.kill(-pid, "SIGKILL");
          const deadline = Date.now() + 5_000;
          while (members(pid) && Date.now() < deadline) await delay(25);
        }
        assert(!pid || !members(pid), "fixture's owned group survived controller cleanup");
        rmSync(root, { recursive: true, force: true });
        assert(!existsSync(root));
      }
    }
  });
}
