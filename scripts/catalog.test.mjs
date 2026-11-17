import assert from "node:assert/strict";
import test from "node:test";
import api from "../packages/sdk/bin/api-catalog.json" with { type: "json" };

test("integration discovery is a closed, self-contained operation catalog", () => {
  assert.equal(Object.keys(api.operations).length, 18);
  for (const op of Object.values(api.operations)) {
    assert(["GET", "POST"].includes(op.method));
    assert.match(op.path, /^\/[A-Za-z0-9/{}_-]+$/);
    assert(Array.isArray(op.parameters));
  }
  assert(!JSON.stringify(api).includes('"$ref"'));
});

import management from "../packages/sdk/bin/management-catalog.json" with { type: "json" };

test("management discovery retains its separate authority and fixed operations", () => {
  assert.equal(management.protocol, "commish-management-v1");
  assert.equal(Object.keys(management.operations).length, 27);
  // The snapshot covers the workspace realm, every operation of it the server lists.
  assert.deepEqual(management.operations["destinations.set_primary"], {
    method: "POST",
    path: "/api/management/v1/destinations.set_primary",
    scope: "destinations.write",
    input: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        applicationId: { type: "string", pattern: "^app_[A-Za-z0-9_-]{12,}$" },
        originId: { type: "string", pattern: "^org_[A-Za-z0-9_-]{12,}$" },
      },
      required: ["applicationId", "originId"],
      additionalProperties: false,
    },
    response: "application/json",
  });
  // Stripe products are listed under a scope setup's onboarding grant already holds.
  assert.deepEqual(
    {
      method: management.operations["products.list"].method,
      scope: management.operations["products.list"].scope,
      fields: Object.keys(management.operations["products.list"].input.properties),
      maximum: management.operations["products.list"].input.properties.limit.maximum,
    },
    { method: "GET", scope: "resources.read", fields: ["limit", "cursor", "active"], maximum: 20 },
  );
  assert.equal(management.operations["programs.rehearse"].scope, "programs.write");
  assert.equal(management.authorization.integrationKeysAccepted, false);
  assert.equal(management.authorization.automationReadOnly, true);
  for (const op of Object.values(management.operations)) {
    assert(["GET", "POST"].includes(op.method));
    assert.match(op.scope, /^[a-z]+\.(read|write|replay)$/);
  }
});
