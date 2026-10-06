import assert from "node:assert/strict";
import { test } from "node:test";
import { travelFor, travelRange } from "../skills/meetly/scripts/travel.ts";

test("travel requires a model decision and rejects incompatible virtual estimates", () => {
  for (const input of [{}, {format: "in_person"}, {meal: "lunch"}, {format: "phone"}] as const)
    assert.throws(() => travelFor(input), /explicit travel/);
  assert.deepEqual(travelFor({travel: {beforeMin: 27, afterMin: 12}}), {beforeMin: 27, afterMin: 12});
  assert.throws(() => travelFor({format: "meet", travel: {beforeMin: 45, afterMin: 45}}), /zero/);
  assert.deepEqual(travelRange("2026-10-05T00:30:00Z", "2026-10-05T01:00:00Z", {travel: {beforeMin: 120, afterMin: 0}}),
    {from: "2026-10-04T22:30:00.000Z", to: "2026-10-05T01:00:00.000Z"});
  for (const value of [-1, 121, 1.5, Infinity, "25", null]) assert.throws(() => travelFor({travel: {beforeMin: value as number, afterMin: 0}}), /whole minutes/);
});
