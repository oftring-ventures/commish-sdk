import { serverMarker } from "../inspect-next-build.mjs";
import { cookieRequestProbe } from "./next-build.mjs";

// The upstream and framework app are owned loopback servers; no hosted API is used.
export async function captureRequestProbe(runApp) {
  const { default: assert } = await import("node:assert/strict");
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const requests = [], expiry = new Date(Date.now() + 3_600_000).toISOString();
  const token = "atr_consumer_capture_token", payload = { data: { token, expiresAt: expiry } };
  let reply = { status: 200, body: JSON.stringify(payload) };
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, method: request.method, headers: request.headers, body });
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(reply.body);
  });
  const previous = process.env.COMMISH_CONSUMER_API_URL;
  const upstreamPath = "/".repeat(2_048) + "api/v1";
  try {
    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    process.env.COMMISH_CONSUMER_API_URL = `http://127.0.0.1:${upstream.address().port}${upstreamPath}${"/".repeat(2_048)}`;
    await runApp(async (origin) => {
      const captureId = "a".repeat(32), clean = { token: "ref_consumer", applicationId: "app_consumer" };
      const body = JSON.stringify({ ...clean, previousAttributionId: "atr_browser_forgery" });
      const send = (headers = {}, input = body) => fetch(`${origin}/api/capture`, {
        method: "POST", body: input, signal: AbortSignal.timeout(10_000),
        headers: { "x-commish-capture-id": captureId, ...headers },
      });
      for (const invalid of ["", "A".repeat(32), "a".repeat(31)]) {
        const response = await send({ "x-commish-capture-id": invalid });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, "invalid_capture_id");
        assert.equal(response.headers.get("set-cookie"), null);
      }
      assert.equal(requests.length, 0, "invalid capture IDs reached upstream");
      const key = `attribution:${createHash("sha256").update(`${captureId}.${JSON.stringify(clean)}`).digest("hex")}`;
      for (const prior of ["atr_consumer_previous1", "atr_consumer_previous2"]) {
        const response = await send({ cookie: `commish_attribution=${prior}`,
          "x-vercel-forwarded-for": "192.0.2.7", "x-forwarded-for": "192.0.2.99",
          "x-commish-client-ip": "192.0.2.98", "user-agent": "commish-consumer",
          "x-vercel-ip-country": "US", "x-commish-publishable-key": "cm_test_pk_consumer",
          authorization: "Bearer browser-forgery" });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { data: { captured: true, expiresAt: expiry } });
        const cookie = response.headers.get("set-cookie");
        for (const part of [`commish_attribution=${token}`, "Path=/", "HttpOnly", "Secure", "SameSite=lax",
          `Expires=${new Date(expiry).toUTCString()}`]) assert(cookie.includes(part), `missing cookie ${part}`);
        const age = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
        assert(age > 0 && age <= 3600);
        const forwarded = requests.at(-1);
        assert.equal(forwarded.url, `${upstreamPath}/attributions/capture`);
        assert.equal(forwarded.method, "POST");
        assert.deepEqual(JSON.parse(forwarded.body), { ...clean, previousAttributionId: prior });
        assert.equal(forwarded.headers["idempotency-key"], key, "cookie changed the retry key");
        assert.equal(forwarded.headers["x-commish-client-ip"], "192.0.2.7");
        assert.equal(forwarded.headers["x-forwarded-for"], undefined);
        assert.equal(forwarded.headers["x-commish-publishable-key"], "cm_test_pk_consumer");
        assert.equal(forwarded.headers["x-vercel-ip-country"], "US");
        assert.equal(forwarded.headers["user-agent"], "commish-consumer");
        assert.equal(forwarded.headers.authorization, `Bearer ${process.env.COMMISH_CONSUMER_SECRET}`);
      }
      for (const prior of [null, "invalid"]) {
        const response = await send({ ...(prior ? { cookie: `commish_attribution=${prior}` } : {}),
          "x-forwarded-for": "192.0.2.99", "x-commish-client-ip": "192.0.2.98" });
        assert.equal(response.status, 200);
        await response.text();
        assert.deepEqual(JSON.parse(requests.at(-1).body), clean);
        assert.equal(requests.at(-1).headers["x-commish-client-ip"], undefined);
      }
      const error = { error: { code: "invalid_request", message: "Controlled upstream rejection" } };
      reply = { status: 400, body: JSON.stringify(error) };
      const malformed = await send({}, "{invalid");
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), error);
      assert.equal(malformed.headers.get("set-cookie"), null);
      assert.equal(requests.at(-1).body, "{invalid");
      for (const [status, value, expected, code] of [
        [503, "unavailable", 503, "attribution_capture_failed"],
        ...[{}, { data: { token: 123, expiresAt: expiry } },
          { data: { token, expiresAt: 123 } }, { data: { token, expiresAt: "invalid" } },
          { data: { token, expiresAt: "2000-01-01" } }, { data: { token: "", expiresAt: expiry } }]
          .map((value) => [200, JSON.stringify(value), 502, "invalid_capture_response"]),
      ]) {
        reply = { status, body: value };
        const response = await send();
        assert.equal(response.status, expected);
        assert.equal((await response.json()).error.code, code);
        assert.equal(response.headers.get("set-cookie"), null);
      }
    });
  } finally {
    if (previous === undefined) delete process.env.COMMISH_CONSUMER_API_URL;
    else process.env.COMMISH_CONSUMER_API_URL = previous;
    if (upstream.listening) await new Promise((resolve, reject) => {
      upstream.close((error) => error ? reject(error) : resolve());
      upstream.closeAllConnections();
    });
    assert(!upstream.listening, "owned capture upstream remained listening");
  }
}

export const nextCaptureBuildFixture = {
  "app/api/capture/route.ts": `import { createAttributionHandler } from '@commish/next';
export async function POST(request: Request) {
  return createAttributionHandler({ apiUrl: process.env.COMMISH_CONSUMER_API_URL,
    secretKey: '${serverMarker}' })(request);
}
`,
  "cookie-probe.mjs": `process.env.COMMISH_CONSUMER_SECRET = '${serverMarker}';
await (${captureRequestProbe.toString()})(probe => (${cookieRequestProbe.toString()})(undefined, probe));\n`,
};
