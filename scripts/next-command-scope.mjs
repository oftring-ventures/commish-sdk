import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function groupPresent(pid) {
  // On macOS kill(group, 0) can report EPERM after termination; inspect owned state.
  return execFileSync("/bin/ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 2_097_152,
  })
    .split("\n")
    .some((row) => {
      const [group, state] = row.trim().split(/\s+/);
      return group === String(pid) && state && !state.startsWith("Z");
    });
}

// Only commands launched by this scope are signalled. No global process cleanup.
export function nextCommandScope() {
  let active,
    interrupt,
    cancelled,
    commandError,
    closed = false,
    safe = true;
  const receipts = [];
  const onSignal = (signal) => {
    interrupt ??= signal;
    cancelled?.({ error: new Error(`framework interrupted by ${signal}`), signal });
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, onSignal);

  async function stop() {
    if (!active?.pid) {
      safe = true;
      return;
    }
    safe = false;
    const present = () => {
      active.groupAbsent ||= !groupPresent(active.pid);
      return !active.groupAbsent;
    };
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      if (!present()) break;
      try {
        process.kill(-active.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") active.teardown.push({ signal, error: error.code });
      }
      active.teardown.push({ signal });
      const deadline = performance.now() + 5_000;
      while (present() && performance.now() < deadline) await delay(25);
    }
    assert(!present(), "owned framework process group survived teardown");
    safe = true;
  }

  return {
    receipts,
    get safeToRemove() {
      return safe;
    },
    async run(command, args, options) {
      assert(
        ["darwin", "linux"].includes(process.platform),
        "unsupported process ownership platform",
      );
      assert(!closed && !active && !interrupt, "framework command scope unavailable");
      assert(
        Number.isSafeInteger(options.timeout) && options.timeout > 0 && options.timeout <= 600_000,
      );
      let timer,
        child,
        result,
        cleanupError,
        outputClosed,
        outputError,
        stdout = "",
        stderr = "";
      const receipt = { command, args, pid: null, teardown: [], groupAbsent: false };
      receipts.push(receipt);
      const completed = new Promise((resolve) => {
        cancelled = resolve;
        // JS signal callbacks cannot run between this spawn and ownership assignment.
        child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        active = receipt;
        receipt.pid = child.pid ?? null;
        safe = !child.pid;
        outputClosed = new Promise((done) => child.once("close", done));
        const output = (name, chunk) => {
          if (
            Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(chunk) >
            2_097_152
          ) {
            outputError ??= new Error("framework command output limit exceeded");
            resolve({ error: outputError });
            return;
          }
          if (name === "stdout") stdout += chunk;
          else stderr += chunk;
        };
        child.stdout.setEncoding("utf8").on("data", (chunk) => output("stdout", chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk) => output("stderr", chunk));
        child.once("error", (error) => resolve({ error }));
        child.once("exit", (status, signal) => resolve({ status, signal }));
        timer = setTimeout(
          () => resolve({ error: new Error("framework command timed out") }),
          options.timeout,
        );
      });
      try {
        result = await completed;
        await stop();
        let closeTimer;
        try {
          await Promise.race([
            outputClosed,
            new Promise((_, reject) => {
              closeTimer = setTimeout(
                () => reject(new Error("framework output did not close")),
                5_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(closeTimer);
        }
      } catch (error) {
        cleanupError = error;
      } finally {
        clearTimeout(timer);
        cancelled = undefined;
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
        if (outputError) result = { ...result, error: result?.error ?? outputError };
        Object.assign(receipt, result, { stdout, stderr, groupAbsent: safe, cleanupError });
        if (safe) active = undefined;
      }
      if (cleanupError || result?.error || result?.status !== 0 || interrupt) {
        const error = new Error("owned framework command failed", {
          cause: cleanupError ?? result?.error,
        });
        Object.assign(error, receipt, { interrupt });
        commandError = error;
        throw error;
      }
      return stdout;
    },
    async close(remove, originalError) {
      const errors = [];
      try {
        await stop();
        if (interrupt) throw new Error(`framework interrupted by ${interrupt}`);
      } catch (error) {
        errors.push(error);
      } finally {
        closed = true;
        for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, onSignal);
        if (safe) {
          try {
            remove?.();
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (errors.length)
        throw new AggregateError(
          [originalError ?? commandError, ...errors].filter(Boolean),
          "framework cleanup failed",
        );
    },
  };
}
