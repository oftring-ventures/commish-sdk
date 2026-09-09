import { CommishProvider } from "@commish/next/react";
import type { ReactElement } from "react";

const required = { publishableKey: "cm_test_pk_fixture123456", applicationId: "app_fixture" };
const element: ReactElement = (
  <CommishProvider {...required}>
    <span>Creator</span>
  </CommishProvider>
);
const text = (
  <CommishProvider {...required} capturePath="/capture">
    Creator
  </CommishProvider>
);
const empty = <CommishProvider {...required}>{null}</CommishProvider>;
// @ts-expect-error publishableKey is required
const noKey = <CommishProvider applicationId="app_fixture">Creator</CommishProvider>;
const noApplication = (
  // @ts-expect-error applicationId is required
  <CommishProvider publishableKey="cm_test_pk_fixture123456">Creator</CommishProvider>
);
const badPath = (
  // @ts-expect-error capturePath must be a string
  <CommishProvider {...required} capturePath={42}>
    Creator
  </CommishProvider>
);
// @ts-expect-error children are required
const noChildren = <CommishProvider {...required} />;
// @ts-expect-error plain objects are not React nodes
const badChildren = <CommishProvider {...required}>{{ invalid: true }}</CommishProvider>;
void [element, text, empty, noKey, noApplication, badPath, noChildren, badChildren];
