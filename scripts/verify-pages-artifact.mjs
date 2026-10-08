// Local, unpublished-artifact acceptance. Never contacts the Commish service,
// creates real credentials, enables production, or publishes a package.
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
const repository = fileURLToPath(new URL("../", import.meta.url));
const consumer = mkdtempSync(join(tmpdir(), "commish-pages-artifact-"));
const marker = "cm_test_sk_pages_artifact_sentinel_123456";
let child,
  browser,
  upstream,
  stopping = false;
const write = (file, contents) => {
  mkdirSync(dirname(join(consumer, file)), { recursive: true });
  writeFileSync(join(consumer, file), contents);
};
const run = (cmd, args, cwd = consumer) => {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: 300000,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${cmd} failed: ${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
};
async function cleanup() {
  if (stopping) return;
  stopping = true;
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000).unref();
    });
  }
  if (upstream?.listening)
    await new Promise((resolve) => {
      upstream.close(resolve);
      upstream.closeAllConnections();
    });
  rmSync(consumer, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().then(() => process.exit(130));
  });
try {
  const deps = {};
  for (const name of ["sdk", "next"]) {
    run(
      "pnpm",
      ["--filter", `@commish/${name}`, "pack", "--pack-destination", consumer],
      repository,
    );
    const file = readdirSync(consumer).find(
      (file) => file.startsWith(`commish-${name}-`) && file.endsWith(".tgz"),
    );
    assert(file);
    deps[`@commish/${name}`] = `file:./${file}`;
  }
  write(
    "package.json",
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        ...deps,
        next: "16.3.6",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
      devDependencies: {
        typescript: "5.9.2",
        "@types/node": "24.13.3",
        "@types/react": "19.2.18",
        "@types/react-dom": "19.2.5",
      },
    }),
  );
  run("pnpm", ["install", "--ignore-scripts"]);
  write(
    "app/layout.tsx",
    'export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}',
  );
  write(
    "app/page.tsx",
    "export default function Home(){return <h1>Merchant home</h1>;}",
  );
  write(
    "app/creator01/page.tsx",
    "export default function Owned(){return <h1>Merchant-owned route</h1>;}",
  );
  // Exercise the installed CLI and only the configuration steps described in
  // the shipped integration guide. Existing merchant files remain untouched.
  run("pnpm", ["exec", "commish-next", "pages", "--apply", "--root-aliases"]);
  const installed = join(consumer, "node_modules/@commish/next");
  for (const guide of ["pages", "agents"])
    assert.match(
      readFileSync(join(installed, `guides/${guide}.md`), "utf8"),
      /Pages/,
    );
  write(
    "app/api/commish/pages/route.ts",
    `import {createCreatorPageHandlers} from '@commish/next/pages/handlers';
import {cookies} from 'next/headers'; import {pagesOptions} from '../../../commish-pages';
export const {POST}=createCreatorPageHandlers({options:pagesOptions,publishableKey:'cm_test_pk_pages_fixture_123456',consent:async()=>{
 const allowed=(await cookies()).get('fixture_consent')?.value==='yes';return {attribution:allowed,measurement:allowed};}});`,
  );
  write(
    "app/shop/route.ts",
    `import {withCommishPageMeasurement} from '@commish/next/pages/handlers'; import {withCommishStripeMetadata} from '@commish/next';
import {cookies} from 'next/headers'; export async function GET(){return Response.json(await withCommishPageMeasurement(
 await withCommishStripeMetadata({mode:'subscription',metadata:{merchant:'retained'},subscription_data:{metadata:{keep:'subscription'}}}),
 (await cookies()).get('fixture_consent')?.value==='yes'));}`,
  );
  write("app/api/measurement-withdraw/route.ts", `import {withdrawCreatorPageMeasurement} from '@commish/next/pages/handlers';
import {cookies} from 'next/headers';import {pagesOptions} from '../../commish-pages';
export async function POST(){(await cookies()).set('fixture_consent','no',{path:'/'});return Response.json(await withdrawCreatorPageMeasurement(pagesOptions));}`);
  write(
    "public/product.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#deebe5"/><rect x="90" y="190" width="420" height="220" rx="28" fill="#476d61"/><text x="300" y="310" text-anchor="middle" fill="white" font-size="28">Approved product image</text></svg>',
  );
  write(
    "next.config.mjs",
    `import {creatorPageFallbackRewrite} from '@commish/next/pages/routing'; export default {experimental:{cpus:1},
 async redirects(){return [{source:'/creator03',destination:'/owned',permanent:false}]},
 async rewrites(){return {fallback:[creatorPageFallbackRewrite()]}}};`,
  );
  run("pnpm", ["exec", "next", "build", "--webpack"]);
  for (const file of readdirSync(join(consumer, ".next/static"), {
    recursive: true,
  }).filter((file) => file.endsWith(".js")))
    assert.doesNotMatch(
      readFileSync(join(consumer, ".next/static", file), "utf8"),
      /cm_test_sk_pages_artifact_sentinel|page-visitor-v1|createCreatorPageHandlers/,
    );
  // A generated, disposable TLS certificate is test transport only. Never
  // imports or writes merchant credentials, and cleanup removes it on all exits.
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "fixture.key",
    "-out",
    "fixture.crt",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
  ]);
  let available = 10,
    paused = false,
    ended = false,
    withdrawn = false,
    exposures = 0,
    captures = 0,
    captureDelay = 150,
    captureFailure = false;
  const visitId = `cpv_${randomUUID()}`,
    revision = randomUUID();
  let origin;
  const measuredVisitors = [], revokedVisitors = [];
  upstream = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${marker}`) {
      res.writeHead(401).end();
      return;
    }
    if(req.url==="/api/v1/pages/measurement/withdraw"){
      let raw="";for await(const chunk of req)raw+=chunk;
      revokedVisitors.push(JSON.parse(raw).visitorId);
      res.setHeader("content-type","application/json");res.end(JSON.stringify({data:{recorded:true}}));return;
    }
    const match =
      /^\/api\/v1\/pages\/prg_123456789012\/(creator\d{2})(?:\/(capture|visits|events))?$/.exec(
        req.url,
      );
    if (!match || Number(match[1].slice(7)) > available || withdrawn) {
      res.writeHead(404).end();
      return;
    }
    if (paused) {
      res.writeHead(503).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    const base = {
      protocol: "commish-pages-v1",
      pageId: `cpg_1234567890${match[1].slice(7)}`,
      programId: "prg_123456789012",
      mode: "test",
      origin,
      canonicalPath: `/c/${match[1]}`,
      rootAliasEnabled: true,
    };
    let data;
    if (match[2] === "capture") {
      await new Promise((resolve) => setTimeout(resolve, captureDelay));
      captures++;
      if (captureFailure) {
        res.writeHead(503).end();
        return;
      }
      data = {
        token: "atr_pages_artifact1234",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
    } else if (match[2] === "visits") {
      if(input.measurementAllowed) measuredVisitors.push(input.visitorId);
      data = {
        variation: input.measurementAllowed ? "alternate" : "standard",
        ...(input.measurementAllowed ? { visitToken: visitId } : {}),
      };
    } else if (match[2] === "events") {
      if (input.event === "exposure") exposures++;
      data = { recorded: true };
    } else if (ended)
      data = {
        ...base,
        status: "ended",
        brand: { name: "Rest Studio", logoUrl: null, accentColor: "#476d61" },
        storeUrl: origin,
      };
    else
      data = {
        ...base,
        status: "ready",
        revision,
        creator: { handle: match[1] },
        preferredPath: base.canonicalPath,
        experimentEnabled: true,
        endorsement: {
          quote: "An explicitly authorized example testimonial.",
          author: "Example creator",
          imageUrl: null,
        },
        couponCode: "REST10",
        content: {
          brand: { name: "Rest Studio", logoUrl: null, accentColor: "#476d61" },
          headline: "Make room for better rest",
          description:
            "Explore the brand’s approved offer, recommended by this participating creator.",
          productImageUrl: `${origin}/product.svg`,
          benefits: ["Approved benefit one", "Approved benefit two"],
          offer: {
            title: "Discover your next night’s sleep",
            description: "See the store for current pricing and eligibility.",
          },
          cta: { label: "Explore the collection", url: `${origin}/shop` },
          disclosures: [
            "Ad. This creator may earn a commission from qualifying purchases.",
          ],
        },
      };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  write(
    "serve.mjs",
    `import https from 'node:https';import fs from 'node:fs';import next from 'next';
let app,ready=false;
const server=https.createServer({key:fs.readFileSync('fixture.key'),cert:fs.readFileSync('fixture.crt')},(req,res)=>{if(!ready){res.writeHead(503).end();return;}req.headers['x-forwarded-proto']='https';app.getRequestHandler()(req,res);});
server.listen(0,'127.0.0.1',async()=>{const port=server.address().port;process.env.COMMISH_PAGES_ORIGIN='https://127.0.0.1:'+port;app=next({dev:false,dir:process.cwd(),hostname:'127.0.0.1',port});await app.prepare();ready=true;console.log('READY '+process.env.COMMISH_PAGES_ORIGIN);});
process.on('SIGTERM',()=>{server.closeAllConnections();server.close();Promise.resolve(app?.close()).finally(()=>process.exit(0));});`,
  );
  child = spawn(process.execPath, ["serve.mjs"], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      COMMISH_SECRET_KEY: marker,
      COMMISH_PAGES_PROGRAM_ID: "prg_123456789012",
      COMMISH_API_URL: `http://127.0.0.1:${upstream.address().port}/api/v1`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  let logs = "";
  child.stderr.on("data", (chunk) => (logs += chunk));
  origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Consumer startup timed out")),
      30000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Consumer exited: " + logs));
    });
    child.stdout.on("data", (chunk) => {
      const match = /READY (https:\/\/127\.0\.0\.1:\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  // Explicit fixture TLS trust only, without changing process-wide verification.
  const https = await import("node:https");
  const get = (path) =>
    new Promise((resolve, reject) => {
      https
        .get(origin + path, { rejectUnauthorized: false }, (response) => {
          let body = "";
          response.on("data", (c) => (body += c));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              body,
              headers: response.headers,
            }),
          );
        })
        .on("error", reject);
    });
  assert.match((await get("/creator01")).body, /Merchant-owned route/);
  assert.equal((await get("/creator03")).headers.location, "/owned");
  for (let i = 1; i <= 10; i++)
    assert.match(
      (await get(`/c/creator${String(i).padStart(2, "0")}`)).body,
      /Make room for better rest/,
    );
  assert.equal((await get("/c/creator11")).status, 404);
  available = 20;
  for (let i = 11; i <= 20; i++) {
    const handle = `creator${i}`;
    assert.match((await get(`/c/${handle}`)).body, /Make room for better rest/);
    const alias = await get(`/${handle}`);
    assert.equal(alias.status, 307);
    assert.equal(alias.headers.location, `${origin}/c/${handle}`);
  }
  assert.equal(exposures, 0);
  assert.equal(captures, 0); // SSR / alias probes aren't visits.
  paused = true;
  assert.match((await get("/c/creator02")).body, /temporarily unavailable/);
  paused = false;
  ended = true;
  const neutral = await get("/c/creator02");
  assert.match(neutral.body, /no longer available/);
  assert.doesNotMatch(neutral.body, /REST10|authorized example testimonial/);
  ended = false;
  withdrawn = true;
  assert.equal((await get("/c/creator02")).status, 404);
  withdrawn = false;
  if (process.env.COMMISH_PAGES_PLAYWRIGHT) {
    const browsers = await import(
      pathToFileURL(process.env.COMMISH_PAGES_PLAYWRIGHT)
    );
    const browserName = process.env.COMMISH_PAGES_BROWSER ?? "chromium";
    assert(["chromium", "firefox", "webkit"].includes(browserName));
    browser = await browsers[browserName].launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(`${origin}/c/creator02`);
    await page
      .getByRole("heading", { name: "Make room for better rest" })
      .waitFor();
    await page.waitForTimeout(500);
    assert.equal(exposures, 0);
    assert.equal(captures, 0);
    assert.equal(
      await page.locator("main").getAttribute("data-variation"),
      "standard",
    );
    await context.addCookies([
      { name: "fixture_consent", value: "yes", url: origin, secure: true },
    ]);
    const started = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/commish/pages") &&
        response.request().postDataJSON()?.action === "start",
    );
    await page.reload();
    const startResponse = await started;
    assert.equal(
      startResponse.status(),
      200,
      `same-origin handler status ${startResponse.status()}`,
    );
    assert.equal((await startResponse.json()).data?.variation, "alternate");
    await page.waitForFunction(
      () => document.querySelector("main")?.dataset.variation === "alternate",
    );
    await page.waitForTimeout(100);
    assert(exposures > 0);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "mobile page overflows",
    );
    if (process.env.COMMISH_PAGES_SCREENSHOT)
      await page.screenshot({
        path: process.env.COMMISH_PAGES_SCREENSHOT,
        fullPage: true,
      });
    await page.getByRole("link", { name: "Explore the collection" }).click();
    await page.waitForURL("**/shop");
    const checkout = JSON.parse(await page.locator("body").innerText());
    assert.equal(
      checkout.metadata.commish_attribution,
      "atr_pages_artifact1234",
    );
    assert.equal(checkout.metadata.commish_page_visit, visitId);
    assert.equal(
      checkout.subscription_data.metadata.commish_page_visit,
      visitId,
    );
    assert.equal(checkout.metadata.merchant, "retained");
    // Click while capture is still pending: shopping must wait for the bounded
    // attempt, but must remain usable when that attempt fails.
    captureDelay = 1200;
    for (const fail of [false, true]) {
      captureFailure = fail;
      await context.clearCookies();
      await context.addCookies([
        { name: "fixture_consent", value: "yes", url: origin, secure: true },
      ]);
      const inFlight = page.waitForRequest(
        (request) =>
          request.url().endsWith("/api/commish/pages") &&
          request.postDataJSON()?.action === "start",
      );
      await page.goto(`${origin}/c/creator02`);
      await inFlight;
      await page.getByRole("link", { name: "Explore the collection" }).click();
      await page.waitForURL("**/shop");
      const fastCheckout = JSON.parse(await page.locator("body").innerText());
      assert.equal(
        fastCheckout.metadata.commish_attribution,
        fail ? undefined : "atr_pages_artifact1234",
      );
      assert.equal(fastCheckout.metadata.commish_page_visit, visitId);
      assert.equal(fastCheckout.metadata.merchant, "retained");
    }
    // Recover a completed background failure at shopping time, with the same
    // capture identity even when measurement had already succeeded.
    captureDelay = 0;captureFailure = true;
    await context.clearCookies();
    await context.addCookies([{name:"fixture_consent",value:"yes",url:origin,secure:true}]);
    const failedStart = page.waitForResponse(response =>
      response.url().endsWith("/api/commish/pages") && response.request().postDataJSON()?.action === "start");
    await page.goto(`${origin}/c/creator02`);
    const failedResponse = await failedStart, failedReceipt = await failedResponse.json();
    assert.equal(failedReceipt.data.captured,false);
    assert.equal(failedReceipt.data.retryable,true);
    assert.equal(failedReceipt.data.visitToken,visitId);
    captureFailure = false;
    const retryRequest = page.waitForRequest(request =>
      request.url().endsWith("/api/commish/pages") && request.postDataJSON()?.action === "start");
    await page.getByRole("link", {name:"Explore the collection"}).click();
    assert.equal((await retryRequest).postDataJSON().captureId,
      failedResponse.request().postDataJSON().captureId);
    await page.waitForURL("**/shop");
    const recoveredCheckout = JSON.parse(await page.locator("body").innerText());
    assert.equal(recoveredCheckout.metadata.commish_attribution,"atr_pages_artifact1234");
    assert.equal(recoveredCheckout.metadata.commish_page_visit,visitId);
    captureDelay = 0;captureFailure = false;
    await context.clearCookies();
    await context.addCookies([{name:"fixture_consent",value:"yes",url:origin,secure:true}]);
    measuredVisitors.length=0;
    const tabs=await Promise.all([context.newPage(),context.newPage()]);
    await Promise.all(tabs.map(async tab=>{
      const started=tab.waitForResponse(r=>r.url().endsWith("/api/commish/pages")&&r.request().postDataJSON()?.action==="start");
      await tab.goto(`${origin}/c/creator02`);await started;
    }));
    assert.equal(measuredVisitors.length,2);assert.equal(new Set(measuredVisitors).size,1);
    assert.deepEqual(await (await context.request.post(origin+"/api/measurement-withdraw")).json(),{recorded:true});
    assert.deepEqual(revokedVisitors,[measuredVisitors[0]]);
    await Promise.all(tabs.map(tab=>tab.close()));
    const unsupported=await browser.newContext({ignoreHTTPSErrors:true});
    await unsupported.addInitScript(()=>Object.defineProperty(navigator,"locks",{value:undefined}));
    await unsupported.addCookies([{name:"fixture_consent",value:"yes",url:origin,secure:true},{name:"commish_page_visitor",value:randomUUID(),url:origin,secure:true,httpOnly:true}]);
    const unmeasured=await unsupported.newPage(), count=measuredVisitors.length, capturedBefore=captures;
    await unmeasured.goto(`${origin}/c/creator02`);
    await unmeasured.getByRole("link",{name:"Explore the collection"}).click();
    await unmeasured.waitForURL("**/shop");
    assert.equal(measuredVisitors.length,count);assert(captures>capturedBefore);
    assert.equal(JSON.parse(await unmeasured.locator("body").innerText()).metadata.commish_page_visit,undefined);
    await unsupported.close();
    console.log(
      `${browserName} passed: consent denied/allowed, concurrent-tab identity and withdrawal, unsupported-browser fail-closed measurement, visible-only exposure, mobile layout, capture cookie before shopping, fast clicks, bounded capture failure, subscription measurement.`,
    );
  }
  console.log(
    "Installed-artifact checks passed: clean Next production build; shipped guides; ten + ten dynamic creators; merchant route/redirect priority; root aliases; SSR exclusion; paused/ended/withdrawn states; no client credentials.",
  );
} finally {
  await cleanup();
}
