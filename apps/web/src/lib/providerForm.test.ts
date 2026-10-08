import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProviderUpdate, type ProviderFormState } from "./providerForm";
const form: ProviderFormState = { id: "example", label_zh: "Example", api_type: "anthropic", base_url: " https://example.invalid ", api_key: " ", model_id: "model", custom_headers: { "x-example": " " }, anthropic_version: "", notes: "note", enabled: true };
test("editing with a blank Key preserves the stored Key while clearing emptied headers", () => {
  const patch = buildProviderUpdate(form, true);
  assert.equal(Object.hasOwn(patch, "api_key"), false);
  assert.deepEqual(patch.custom_headers, { "x-example": "" });
  assert.equal(patch.base_url, "https://example.invalid");
  assert.equal(Object.hasOwn(patch, "api_type"), false);
  assert.equal(form.custom_headers["x-example"], " ");
});
test("custom provider protocol and explicit replacement Key are sent together", () => {
  const patch = buildProviderUpdate({ ...form, api_key: " fixture-only " }, false);
  assert.equal(patch.api_key, "fixture-only");
  assert.equal(patch.api_type, "anthropic");
  assert.equal(patch.anthropic_version, "2023-06-01");
});
