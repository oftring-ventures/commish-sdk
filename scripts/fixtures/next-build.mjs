import { serverMarker } from "../inspect-next-build.mjs";
export const nextBuildFixture = {
  "next.config.mjs": "export default { experimental: { cpus: 1 } };\n",
  "app/layout.tsx": `import { CommishProvider } from '@commish/next/react';
import type { ReactNode } from 'react';
export default function Layout({ children }: { children: ReactNode }) {
  return <html><body><CommishProvider publishableKey="cm_test_pk_123456789012"
    applicationId="app_123456789012">{children}</CommishProvider></body></html>;
}
`,
  "app/page.tsx": "export default function Page() { return <p>Installed public provider</p>; }\n",
  "app/api/artifact/route.ts": `import { Commish } from '@commish/sdk';
export const dynamic = 'force-dynamic';
export async function GET() {
  const client = new Commish({ secretKey: '${serverMarker}',
    baseUrl: 'https://api.example.test/api/v1',
    fetch: async () => { throw new Error('Build fixture network forbidden'); } });
  return Response.json({ kind: typeof client });
}
`,
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "ES2017",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true,
      // Next recommends skipping third-party declaration scanning in framework builds.
      // SDK/provider declaration gates separately retain skipLibCheck:false.
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "react-jsx",
      incremental: true,
      plugins: [{ name: "next" }],
    },
    include: [
      "next-env.d.ts",
      ".next/types/**/*.ts",
      ".next/dev/types/**/*.ts",
      "**/*.ts",
      "**/*.tsx",
    ],
    exclude: ["node_modules"],
  }),
};

export const nextServerBuildFixture = {
  ...nextBuildFixture,
  "app/layout.tsx": `import type { ReactNode } from 'react';
export default function Layout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  "app/page.tsx": "export default function Page() { return <p>Installed public server helper</p>; }\n",
  "app/api/artifact/route.ts": `import { Commish } from '@commish/sdk';
import { applyCommishStripeMetadata } from '@commish/next';
export const dynamic = 'force-dynamic';
export async function GET() {
  const client = new Commish({ secretKey: '${serverMarker}',
    baseUrl: 'https://api.example.test/api/v1',
    fetch: async () => { throw new Error('Build fixture network forbidden'); } });
  return Response.json({ kind: typeof client,
    metadata: applyCommishStripeMetadata({ mode: 'payment', metadata: {} }, 'atr_installed1234').metadata });
}
`,
};

export async function cookieRequestProbe(createApp) {
  const { default: assert } = await import("node:assert/strict");
  const { createServer } = await import("node:http");
  const next = createApp ?? (await import("next")).default;
  const app = next({ dev: false, dir: process.cwd(), hostname: "127.0.0.1" });
  let server;
  try {
    await app.prepare();
    const handle = app.getRequestHandler();
    server = createServer((request, response) => {
      Promise.resolve(handle(request, response)).catch(() => {
        response.statusCode = 500;
        response.end("Controlled consumer failure");
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/api/cookies`;
    await Promise.all([null, "atr_consumer_first", "atr_consumer_second", null].map(async (value) => {
      const response = await fetch(url, {
        headers: value === null ? {} : { cookie: `commish_attribution=${value}` },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        attribution: value,
        unchanged: value === null,
        metadata: { keep: "checkout", ...(value ? { commish_attribution: value } : {}) },
        subscription: { keep: "subscription", ...(value ? {
          commish_attribution: value, commish_customer_id: "consumer_123",
        } : {}) },
      }, "installed cookie context and metadata wrapper");
    }));
  } finally {
    try {
      if (server?.listening) await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } finally {
      await app.close();
    }
    assert(!server?.listening, "owned consumer server remained listening");
  }
}

export const nextCookieBuildFixture = {
  "app/api/cookies/route.ts": `import { getCommishAttribution, withCommishStripeMetadata } from '@commish/next';
export const dynamic = 'force-dynamic';
export async function GET() {
  const attribution = await getCommishAttribution();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const input = { mode: 'subscription', client_reference_id: 'consumer_123',
    metadata: { keep: 'checkout' }, subscription_data: { metadata: { keep: 'subscription' } } };
  const result = await withCommishStripeMetadata(input);
  return Response.json({ attribution, unchanged: result === input,
    metadata: result.metadata, subscription: result.subscription_data.metadata });
}
`,
  "cookie-probe.mjs": `await (${cookieRequestProbe.toString()})();\n`,
};
