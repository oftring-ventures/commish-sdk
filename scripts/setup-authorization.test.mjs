import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { authorizeSetup, openSetupBrowser } from "../packages/sdk/bin/setup-authorization.mjs";

const url = `https://app.commish.sh/cli/authorize/${"a".repeat(64)}`;
function fixture(outcomes = [{ status: "authorized", workspaceId: "wrk_123456789012" }]) {
  let now = 0, revoked = 0, opened = 0;
  const notifications = [], waits = [];
  const session = {
    begin: async () => ({ approvalUrl: url, pairingCode: "AAAA-AAAA", requestExpiresAt: new Date(60000).toISOString() }),
    poll: async () => { const result = outcomes.shift() ?? { status: "pending" }; if (result instanceof Error) throw result; return result; },
    revoke: async () => { revoked++; },
  };
  return { session, notifications, waits, revoked: () => revoked, opened: () => opened,
    options: { session, now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; },
      notify: (value) => notifications.push(value), openBrowser: async () => { opened++; return true; } } };
}
test("returns an in-memory session after browser pairing and pending polls", async () => {
  const f = fixture([{ status: "pending" }, { status: "authorized" }]);
  const result = await authorizeSetup({}, f.options);
  assert.equal(result.session, f.session);
  assert.equal(f.opened(), 1); assert.equal(f.revoked(), 0);
  assert.deepEqual(f.waits, [2000]);
  assert.equal(f.notifications[0].status, "authorization_required");
  assert.equal(f.notifications.at(-1).status, "authorized");
});
test("no-open provides the same URL and code without launching a browser", async () => {
  const f = fixture(); await authorizeSetup({}, { ...f.options, noOpen: true });
  assert.equal(f.opened(), 0); assert.equal(f.notifications[0].approvalUrl, url);
  assert.equal(f.notifications[0].pairingCode, "AAAA-AAAA");
});
test("browser launch failure keeps a manual handoff available", async () => {
  const f = fixture(); await authorizeSetup({}, { ...f.options, openBrowser: async () => false });
  assert.equal(f.notifications[1].status, "browser_unavailable");
  assert.equal(f.notifications[1].approvalUrl, url);
});
test("denial, expiry and interruption end polling and attempt revocation", async () => {
  for (const status of ["denied", "revoked"]) {
    const f = fixture([{ status }]);
    await assert.rejects(authorizeSetup({}, f.options), { message: "access_denied" });
    assert.equal(f.revoked(), 1);
  }
  const f = fixture([]); await assert.rejects(authorizeSetup({}, f.options), { message: "setup_expired" });
  assert.equal(f.waits.reduce((sum, ms) => sum + ms, 0), 60000);
  assert.equal(f.revoked(), 1);
  const interrupted = fixture();
  await assert.rejects(authorizeSetup({}, { ...interrupted.options, signal: AbortSignal.abort() }), { message: "setup_interrupted" });
  assert.equal(interrupted.opened(), 0); assert.equal(interrupted.revoked(), 1);
});
test("temporary failures back off while unknown failures stay redacted", async () => {
  const f = fixture([new Error("service_unavailable"), { status: "authorized" }]);
  await authorizeSetup({}, f.options); assert.deepEqual(f.waits, [5000]);
  const limited = fixture([new Error("rate_limited")]);
  await assert.rejects(authorizeSetup({}, limited.options), { message: "setup_expired" });
  assert.deepEqual(limited.waits, [60000]);
  const broken = fixture([new Error("private provider detail")]);
  await assert.rejects(authorizeSetup({}, broken.options), { message: "service_unavailable" });
  assert(!JSON.stringify(broken.notifications).includes("private provider detail"));
});
test("output failure after approval revokes otherwise orphaned authority", async () => {
  const f = fixture();
  await assert.rejects(authorizeSetup({}, { ...f.options, notify: (receipt) => {
    if (receipt.status === "authorized") throw new Error("renderer failed");
  } }), { message: "service_unavailable" });
  assert.equal(f.revoked(), 1);
});
test("native launch uses argument arrays, no shell, and a bounded child", async () => {
  for (const [platform, executable] of [["darwin", "open"], ["win32", "rundll32.exe"], ["linux", "xdg-open"]]) {
    let called;
    const opened = await openSetupBrowser(url, { platform, launch: (...args) => {
      called = args; const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child;
    } });
    assert.equal(opened, true); assert.equal(called[0], executable);
    assert.equal(called[1].at(-1), url); assert.equal(called[2].shell, false);
    assert.equal(called[2].timeout, 5000); assert.equal(called[2].killSignal, "SIGKILL");
  }
  for (const bad of ["broken", "javascript:evil()", "https://user:password@app.commish.sh/", `${url}?token=secret`])
    assert.equal(await openSetupBrowser(bad, { launch: () => { throw new Error("must not launch"); } }), false);
});

test("interruption during an in-flight authorization revokes the approved session", async () => {
  const f = fixture(), controller = new AbortController();
  f.session.poll = async () => { controller.abort(); return { status: "authorized" }; };
  await assert.rejects(authorizeSetup({}, { ...f.options, signal: controller.signal }), { message: "setup_interrupted" });
  assert.equal(f.revoked(), 1);
  assert(!f.notifications.some((item) => item.status === "authorized"));
});
