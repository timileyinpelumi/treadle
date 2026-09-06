import { expect, test } from "bun:test";
import { defaultBackoff } from "../src/backoff";

test("defaultBackoff doubles per attempt with up to a second of jitter", () => {
  for (const attempt of [1, 2, 3, 5, 10]) {
    const ms = defaultBackoff(attempt);
    expect(ms).toBeGreaterThanOrEqual(2 ** attempt * 1000);
    expect(ms).toBeLessThan(2 ** attempt * 1000 + 1000);
  }
});

test("defaultBackoff caps at one hour", () => {
  expect(defaultBackoff(20)).toBe(3_600_000);
  expect(defaultBackoff(25)).toBe(3_600_000);
});
