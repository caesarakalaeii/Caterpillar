/**
 * The viewer's environment, and the one default that is a security decision.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIMEOUT_MS, DEFAULT_VIEW_PORT, loadViewConfig } from "./config.ts";

test("the forwarded-user check defaults ON, unlike the runners' web view", async () => {
  // `web.enabled` defaults to false on a runner because a workstation runner must not
  // begin serving transcripts because it was upgraded. This process exists only to be put
  // behind an authenticating proxy, so the unsafe direction is the one that needs a word
  // typed on purpose.
  assert.equal(loadViewConfig({}).requireForwardedUser, true);
  assert.equal(loadViewConfig({ VIEW_REQUIRE_FORWARDED_USER: "false" }).requireForwardedUser, false);
  // Anything that is not exactly `false` leaves the seatbelt on: a typo must not disarm it.
  assert.equal(loadViewConfig({ VIEW_REQUIRE_FORWARDED_USER: "no" }).requireForwardedUser, true);
});

test("a malformed number falls back rather than refusing to boot", async () => {
  // A viewer that will not start over a bad env var is a dashboard that is missing exactly
  // when someone is trying to read it.
  const config = loadViewConfig({ VIEW_PORT: "not-a-port", VIEW_TIMEOUT_MS: "-5" });

  assert.equal(config.port, DEFAULT_VIEW_PORT);
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test("the header name is lower-cased, because node lower-cases what it receives", async () => {
  assert.equal(loadViewConfig({ VIEW_FORWARDED_USER_HEADER: "Remote-User" }).forwardedUserHeader, "remote-user");
});

test("an explicit runner list wins over the SRV name", async () => {
  const config = loadViewConfig({ VIEW_RUNNERS: "a=http://x:1" });
  assert.equal(config.runners, "a=http://x:1");
  // The SRV default is still present: the list is the override, not a replacement setting.
  assert.match(config.service, /^_web\._tcp\.caterpillar-headless\./);
});
