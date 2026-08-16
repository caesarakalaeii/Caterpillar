import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderOutage } from "../domain/task.ts";
import { ProviderCooldown } from "./cooldown.ts";

const OPTIONS = { initialSeconds: 60, maxSeconds: 1800 };
const EXHAUSTED: ProviderOutage = { kind: "exhausted", status: 429, detail: "spend limit" };

test("the first outage waits the initial interval and says it is the first", () => {
  const cooldown = new ProviderCooldown(OPTIONS);
  const entered = cooldown.record(1_000, EXHAUSTED);

  assert.equal(entered.waitMs, 60_000);
  assert.equal(entered.first, true);
  assert.equal(cooldown.remainingMs(1_000), 60_000);
});

test("a consecutive outage doubles the wait and is no longer the first", () => {
  const cooldown = new ProviderCooldown(OPTIONS);
  cooldown.record(0, EXHAUSTED);

  const again = cooldown.record(60_000, EXHAUSTED);
  assert.equal(again.waitMs, 120_000);
  assert.equal(again.first, false);
  assert.equal(cooldown.record(180_000, EXHAUSTED).waitMs, 240_000);
});

test("the wait is capped, so a month-long limit costs one attempt per cap", () => {
  const cooldown = new ProviderCooldown(OPTIONS);
  for (let i = 0; i < 20; i += 1) cooldown.record(i * 1_000_000, EXHAUSTED);

  assert.equal(cooldown.record(99_000_000, EXHAUSTED).waitMs, 1_800_000);
});

test("a wait the provider asked for wins when it is longer, still under the cap", () => {
  const cooldown = new ProviderCooldown(OPTIONS);

  assert.equal(
    cooldown.record(0, { ...EXHAUSTED, retryAfterMs: 300_000 }).waitMs,
    300_000,
  );
  cooldown.clear();
  // An hour is longer than this runner is willing to sleep blind; it re-checks at the
  // cap instead, which costs one rejected request.
  assert.equal(
    cooldown.record(0, { ...EXHAUSTED, retryAfterMs: 3_600_000 }).waitMs,
    1_800_000,
  );
});

test("a rejected credential goes straight to the cap — no wait length fixes it", () => {
  const cooldown = new ProviderCooldown(OPTIONS);
  const entered = cooldown.record(0, { kind: "unauthorised", status: 401, detail: "expired" });

  assert.equal(entered.waitMs, 1_800_000);
});

test("the cooldown expires on its own", () => {
  const cooldown = new ProviderCooldown(OPTIONS);
  cooldown.record(0, EXHAUSTED);

  assert.equal(cooldown.remainingMs(30_000), 30_000);
  assert.equal(cooldown.remainingMs(60_000), 0);
  assert.equal(cooldown.remainingMs(90_000), 0);
});

test("clearing reports whether anything was actually recovered from", () => {
  const cooldown = new ProviderCooldown(OPTIONS);

  assert.equal(cooldown.clear(), false);
  cooldown.record(0, EXHAUSTED);
  assert.equal(cooldown.clear(), true);
  assert.equal(cooldown.remainingMs(0), 0);
  // ...and the streak went with it, so the next incident starts short again.
  assert.equal(cooldown.record(0, EXHAUSTED).waitMs, 60_000);
});
