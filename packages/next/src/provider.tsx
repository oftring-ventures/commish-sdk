"use client";

import { Suspense, useEffect, type ReactNode } from "react";
import { captureReferral } from "@commish/sdk/browser";
import { usePathname, useSearchParams } from "next/navigation.js";

type CommishCaptureProps = {
  publishableKey: string;
  applicationId: string;
  capturePath?: string;
};

function CommishCapture({
  publishableKey,
  applicationId,
  capturePath,
}: CommishCaptureProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
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
