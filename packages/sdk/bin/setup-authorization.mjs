import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createSetupSession } from "./setup-session.mjs";

export function openSetupBrowser(url, { platform = process.platform, launch = spawn } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return Promise.resolve(false); }
  const pairing = /^\/cli\/authorize\/[a-f0-9]{64}$/.test(parsed.pathname) && !parsed.search;
  const stripe = (/^\/dashboard\/workspace\/wrk_[A-Za-z0-9_-]{12,}\/settings$/.test(parsed.pathname) ||
    /^\/cli\/setup\/workspace\/wrk_[A-Za-z0-9_-]{12,}\/stripe$/.test(parsed.pathname)) && /^\?mode=(test|live)$/.test(parsed.search);
  if (parsed.username || parsed.password || parsed.hash || !(pairing || stripe) ||
      !(parsed.protocol === "https:" || parsed.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname))) return Promise.resolve(false);
  const command = platform === "darwin" ? ["open", url] : platform === "win32"
    ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  return new Promise((resolve) => {
    let child;
    try { child = launch(command[0], command.slice(1), { stdio: "ignore", shell: false, timeout: 5000, killSignal: "SIGKILL" }); }
    catch { resolve(false); return; }
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

// A caller keeps the returned closure only for its current provisioning run.
// Interrupted runs reauthorize and resume from non-secret resource progress.
export async function authorizeSetup(input, {
  appUrl, noOpen = false, notify = () => {}, signal,
  session = createSetupSession(input, { appUrl }), openBrowser = openSetupBrowser,
  now = Date.now, sleep = (ms) => delay(ms, undefined, { signal }),
} = {}) {
  let authorized = false;
  try {
    if (signal?.aborted) throw new Error("setup_interrupted");
    const pending = await session.begin();
    const deadline = Date.parse(pending.requestExpiresAt);
    notify({ status: "authorization_required", ...pending });
    if (!noOpen && !signal?.aborted && !await openBrowser(pending.approvalUrl))
      notify({ status: "browser_unavailable", approvalUrl: pending.approvalUrl, pairingCode: pending.pairingCode });
    while (now() < deadline) {
      if (signal?.aborted) throw new Error("setup_interrupted");
      try {
        const receipt = await session.poll();
        if (signal?.aborted) throw new Error("setup_interrupted");
        if (receipt.status === "authorized") {
          notify({ status: "authorized", ...receipt });
          authorized = true;
          return { session, receipt };
        }
        if (receipt.status === "denied" || receipt.status === "revoked") throw new Error("access_denied");
      } catch (error) {
        if (!["service_unavailable", "rate_limited"].includes(error?.message)) throw error;
        notify({ status: "waiting", code: error.message });
        await sleep(Math.max(0, Math.min(error.message === "rate_limited" ? 60_000 : 5_000, deadline - now())));
        continue;
      }
      await sleep(Math.max(0, Math.min(2_000, deadline - now())));
    }
    throw new Error("setup_expired");
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw new Error("setup_interrupted");
    const codes = ["invalid_request", "invalid_app_url", "invalid_response", "service_unavailable", "rate_limited",
      "access_denied", "mfa_required", "recent_auth_required", "authorization_required", "setup_conflict", "setup_not_found", "setup_expired", "setup_interrupted"];
    throw new Error(codes.includes(error?.message) ? error.message : "service_unavailable");
  } finally {
    if (!authorized) await session.revoke().catch(() => {});
  }
}
