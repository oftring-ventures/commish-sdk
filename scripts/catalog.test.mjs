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
