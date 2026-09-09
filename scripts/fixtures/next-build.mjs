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
