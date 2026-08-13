import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { signAppJwt, summarise } from "./github-app.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("signs a three-part RS256 JWT whose expiry is inside GitHub's 10 minute limit", () => {
  const now = 1_700_000_000_000;
  const jwt = signAppJwt("123456", pem, now);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString()) as {
    alg: string;
  };
  assert.equal(header.alg, "RS256");

  const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString()) as {
    iat: number;
    exp: number;
    iss: string;
  };
  assert.equal(payload.iss, "123456");
  // iat is backdated to tolerate clock skew against GitHub.
  assert.ok(payload.iat < Math.floor(now / 1000));
  // GitHub rejects exp more than 600s out; we must stay strictly inside.
  assert.ok(payload.exp - payload.iat < 600);
});

test("no CI signal at all is reported as 'none', not success", () => {
  // The §12 gate must not read "nothing ran" as "everything passed".
  const status = summarise({ check_runs: [] }, { state: "pending", total_count: 0 });
  assert.equal(status.conclusion, "none");
});

test("a failing check run wins over passing ones", () => {
  const status = summarise(
    {
      check_runs: [
        { status: "completed", conclusion: "success", name: "lint" },
        { status: "completed", conclusion: "failure", name: "test" },
      ],
    },
    { state: "success", total_count: 1 },
  );
  assert.equal(status.conclusion, "failure");
  assert.match(status.summary, /test/);
});

test("an incomplete run is pending even when others passed", () => {
  const status = summarise(
    {
      check_runs: [
        { status: "completed", conclusion: "success", name: "lint" },
        { status: "in_progress", conclusion: null, name: "test" },
      ],
    },
    { state: "success", total_count: 1 },
  );
  assert.equal(status.conclusion, "pending");
});

test("neutral and skipped conclusions do not count as failures", () => {
  const status = summarise(
    {
      check_runs: [
        { status: "completed", conclusion: "skipped", name: "optional" },
        { status: "completed", conclusion: "neutral", name: "advisory" },
      ],
    },
    { state: "success", total_count: 0 },
  );
  assert.equal(status.conclusion, "success");
});

test("a failing legacy combined status is respected even with no check runs", () => {
  // External CI that only posts statuses must not be invisible to the gate.
  const status = summarise({ check_runs: [] }, { state: "failure", total_count: 2 });
  assert.equal(status.conclusion, "failure");
});
