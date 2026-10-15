import assert from "node:assert/strict";
import test from "node:test";
import { touchZForPressure } from "../app/touch-pressure";

test("maps the three pressure presets into the verified black-arm Z range", () => {
  const limits = { minimum: 9.5, maximum: 10 };
  assert.equal(touchZForPressure("light", limits), 9.6);
  assert.equal(touchZForPressure("natural", limits), 9.825);
  assert.equal(touchZForPressure("firm", limits), 10);
});

test("fails closed for invalid pressure limits", () => {
  assert.equal(touchZForPressure("firm", { minimum: 10, maximum: 9.5 }), null);
});
