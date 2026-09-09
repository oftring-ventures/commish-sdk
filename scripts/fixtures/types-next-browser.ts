import { captureReferral, type CommishBrowserOptions } from "@commish/next/browser";
import type { CommishBrowserOptions as SdkOptions } from "@commish/sdk/browser";

const options: CommishBrowserOptions = {
  publishableKey: "cm_test_pk_type_fixture",
  applicationId: "app_type_fixture",
  capturePath: "/api/commish/attribution",
};
const sdkOptions: SdkOptions = options;
const nextOptions: CommishBrowserOptions = sdkOptions;
const result: Promise<boolean> = captureReferral(nextOptions);
void result;
// @ts-expect-error applicationId remains required through the bridge
captureReferral({ publishableKey: "cm_test_pk_type_fixture" });
// @ts-expect-error capturePath must remain a string
captureReferral({ ...options, capturePath: 123 });
