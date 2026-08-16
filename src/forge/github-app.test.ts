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

test("check runs alone are green — an EMPTY combined status is not pending", () => {
  // GitHub answers /status with `state: "pending"` on a ref that has NO statuses at all,
  // and a repo whose CI is Actions-only never gets any: the signal lives entirely in
  // check-runs. ORing that state into the pending branch made §12 unsatisfiable for
  // every such repo — the first intake-sourced task claimed done, was rejected with
  // "CI has not finished: 0 check(s) still running" over a green PR, re-ran, and
  // eventually gave up and asked a human. `total_count`, not `state`, says whether the
  // combined status is worth reading.
  const status = summarise(
    { check_runs: [{ status: "completed", conclusion: "success", name: "GitGuardian" }] },
    { state: "pending", total_count: 0 },
  );
  assert.equal(status.conclusion, "success", status.summary);
});

test("a genuinely pending commit status still blocks a green check run", () => {
  // The other half of the fix: an empty combined status is ignorable, a populated one
  // is not. Without this the correction would wave through a ref whose legacy status
  // has not reported yet.
  const status = summarise(
    { check_runs: [{ status: "completed", conclusion: "success", name: "lint" }] },
    { state: "pending", total_count: 1 },
  );
  assert.equal(status.conclusion, "pending");
});

test("a pending verdict never claims zero checks are running", () => {
  // "0 check(s) still running" is what the operator saw for two sessions. A summary
  // that contradicts its own verdict sends whoever reads it looking in the wrong place.
  const status = summarise(
    { check_runs: [{ status: "completed", conclusion: "success", name: "lint" }] },
    { state: "pending", total_count: 1 },
  );
  assert.equal(status.summary.includes("0 check"), false, status.summary);
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

test("a partial check-run list is pending, never success", () => {
  // The §12 CI gate used to run on one unpaginated request, which returns GitHub's
  // default of 30. A matrix build whose failing job landed on page 2 came back as
  // success and was squash-merged red. `total_count` was not even declared on the
  // response type, so the truncation was undetectable.
  const status = summarise(
    {
      total_count: 42,
      check_runs: [{ status: "completed", conclusion: "success", name: "test (1)" }],
    },
    { state: "success", total_count: 0 },
  );

  assert.equal(status.conclusion, "pending");
  assert.match(status.summary, /1 of 42/);
});

test("a complete check-run list is judged normally", () => {
  const status = summarise(
    {
      total_count: 2,
      check_runs: [
        { status: "completed", conclusion: "success", name: "test" },
        { status: "completed", conclusion: "success", name: "lint" },
      ],
    },
    { state: "success", total_count: 0 },
  );

  assert.equal(status.conclusion, "success");
});

test("a response without total_count is trusted as complete", () => {
  // GHES and the test fixtures predating pagination omit it. Treating absence as
  // truncation would make every such ref permanently pending.
  const status = summarise(
    { check_runs: [{ status: "completed", conclusion: "failure", name: "test" }] },
    { state: "success", total_count: 0 },
  );

  assert.equal(status.conclusion, "failure");
});
