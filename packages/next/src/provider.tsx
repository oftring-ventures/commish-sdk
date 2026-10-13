"use client";

import { captureReferral } from "@commish/sdk/browser";
import { usePathname, useSearchParams } from "next/navigation.js";
import { type ReactNode, Suspense, useEffect } from "react";

type CommishCaptureProps = {
  publishableKey: string;
  applicationId: string;
  capturePath?: string;
};

function CommishCapture({ publishableKey, applicationId, capturePath }: CommishCaptureProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // biome-ignore lint/correctness/useExhaustiveDependencies: capture re-runs on every navigation, which pathname and searchParams express
  useEffect(
    () => void captureReferral({ publishableKey, applicationId, capturePath }),
    [publishableKey, applicationId, capturePath, pathname, searchParams],
  );
  return null;
}

export function CommishProvider({
  children,
  ...captureProps
}: CommishCaptureProps & { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <CommishCapture {...captureProps} />
      </Suspense>
      {children}
    </>
  );
}
