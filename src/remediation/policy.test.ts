/**
 * Tests for the per-alert policy parser (DESIGN.md §20).
 *
 * The document under test is operator-authored and lives in the state repo, so nobody
 * runs a type checker over it before the supervisor reads it. That makes every silent
 * acceptance a production bug of a particular shape: a policy that parses but does not
 * mean what the operator wrote produces tasks against the wrong repo, with the wrong
 * completion gate, or with none. Each test below therefore asserts on the MESSAGE as well
 * as the type — the message is the entire user interface of this module, and one that
 * does not name the entry and the field leaves an operator diffing a file by eye.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { KNOWN_CAPABILITIES } from "../domain/task.ts";
import {
  alertTaskId,
  isAlertFingerprint,
  isAlertTaskId,
  lookupPolicy,
  parsePolicy,
  PolicyParseError,
  POLICY_VERSION,
  EMPTY_POLICY,
} from "./policy.ts";

/** A well-formed two-entry document, the base every failure case perturbs. */
const VALID = `
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm run check
      - npm test
    requires: []
    goalPrefix: |
      This alert usually means a session wedged on a provider cooldown.
    runbook: https://runbooks.example.invalid/no-progress
    maxOpenTasks: 2
  - alertname: CaterpillarPodCrashLooping
    workspace: caesar
    repos:
      - codeberg.org/caesar/deployment
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm test
    requires:
      - k8s
`;

/**
 * Asserts a `PolicyParseError` whose message names what the operator got wrong.
 *
 * The error is caught by hand rather than through `assert.throws`, because the assertion
 * this file cares about is on the MESSAGE and `assert.throws` does not hand the error
 * back. A test that only proved "it threw" would pass against a parser that reported
 * every mistake as `alerts/policy.yaml is invalid`, which is the failure being guarded
 * against.
 */
const refuses = (text: string, ...expected: readonly RegExp[]): PolicyParseError => {
  let caught: unknown;
  try {
    parsePolicy(text);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof PolicyParseError,
    `expected a PolicyParseError, got ${String(caught)}`,
  );
  for (const pattern of expected) assert.match(caught.message, pattern);
  return caught;
};

test("a valid multi-entry document parses into normalised entries", () => {
  const policy = parsePolicy(VALID);

  assert.equal(policy.version, POLICY_VERSION);
  assert.equal(policy.entries.length, 2);

  const [first, second] = policy.entries as [
    (typeof policy.entries)[number],
    (typeof policy.entries)[number],
  ];

  assert.equal(first.alertname, "CaterpillarNoProgress");
  assert.equal(first.workspace, "caesar");
  // Repo refs come back as `RepoRef`, not strings: everything downstream — the token
  // scope, the worktree layout — works in refs, and parsing here is what stops a
  // malformed ref reaching the point where it becomes a clone URL.
  assert.deepEqual(first.repos, [
    { host: "github.com", owner: "caesarakalaeii", name: "caterpillar" },
  ]);
  assert.deepEqual(first.acceptance, ["npm run check", "npm test"]);
  assert.deepEqual(first.requires, []);
  assert.match(first.goalPrefix ?? "", /provider cooldown/);
  assert.equal(first.runbook, "https://runbooks.example.invalid/no-progress");
  assert.equal(first.maxOpenTasks, 2);

  assert.equal(second.alertname, "CaterpillarPodCrashLooping");
  assert.equal(second.repos.length, 2);
  assert.deepEqual(second.requires, ["k8s"]);
  // The default that keeps a re-firing alert from opening a second task saying the same
  // thing. Absent from the document, so it has to come from here.
  assert.equal(second.maxOpenTasks, 1);
  // `exactOptionalPropertyTypes`: an omitted optional must be ABSENT, not present and
  // undefined, or a round-trip through `deepEqual` in a sibling test stops matching.
  assert.equal("goalPrefix" in second, false);
  assert.equal("runbook" in second, false);
});

test("an entry with no `acceptance` key is refused, naming the field", () => {
  // §12 applies to a remediation task unchanged. Without commands the supervisor can run
  // there is nothing to gate on, so the task would be created and could never be closed.
  refuses(
    `
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
`,
    /CaterpillarNoProgress/,
    /`acceptance`/,
  );
});

test("an entry with an empty `acceptance` list is refused too", () => {
  // The list being present and empty is the same hole as it being absent, and it is the
  // shape a half-finished edit leaves behind.
  const error = refuses(
    `
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance: []
`,
    /CaterpillarNoProgress/,
    /`acceptance`/,
    /at least one command/,
  );
  // The message says WHY, not just what: the operator reading it should not have to go
  // and find §12 to understand that this is not an arbitrary rule.
  assert.match(error.message, /§12/);
});

test("a misspelled key fails loudly instead of producing an entry with no criteria", () => {
  // `acceptence:` is the mistake that motivated refusing unknown keys at all. Ignored, it
  // is indistinguishable from omitting the gate — the typo would create tasks nothing can
  // mark done, and the operator would be looking at a queue rather than at a message.
  const error = refuses(
    `
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptence:
      - npm test
`,
    /CaterpillarNoProgress/,
    /acceptence/,
  );
  // Listing the known keys is what turns "wrong" into "fixable in one edit".
  assert.match(error.message, /acceptance/);
});

test("an unknown top-level key is refused as well", () => {
  refuses(
    `
version: 1
namespaces:
  - caterpillar
alerts: []
`,
    /namespaces/,
    /version, alerts/,
  );
});

test("an unknown capability is refused, listing the ones that exist", () => {
  // `requires` is the claim predicate (§8): an unknown capability is satisfied by no
  // runner, so a typo parks the task in the queue forever and reads from outside as a
  // stuck scheduler rather than as a spelling mistake.
  const error = refuses(
    `
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm test
    requires:
      - kubernetes
`,
    /CaterpillarNoProgress/,
    /`requires`/,
    /kubernetes/,
  );
  for (const capability of KNOWN_CAPABILITIES) {
    assert.ok(
      error.message.includes(capability),
      `the message offers '${capability}' as an alternative`,
    );
  }
});

test("a duplicate alertname is refused rather than resolved last-wins", () => {
  // Two entries for one alertname means the operator believes both are in force. Picking
  // one silently would send the task to the wrong workspace with the wrong gate.
  refuses(
    `
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm test
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/other
    acceptance:
      - npm run check
`,
    /CaterpillarNoProgress/,
    /more than once/,
  );
});

test("a version this parser does not understand is refused, naming the one it does", () => {
  refuses(
    `
version: 2
alerts: []
`,
    /`version`/,
    /must be 1/,
  );
  // A missing version is the same refusal: it is how a document written for a future
  // schema would look if the field were merely optional.
  refuses("alerts: []\n", /`version`/);
});

test("a malformed repo ref is refused before it can become a clone URL", () => {
  refuses(
    `
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - "https://github.com/caesarakalaeii/caterpillar.git"
    acceptance:
      - npm test
`,
    /CaterpillarNoProgress/,
    /`repos`/,
    /host\/owner\/name|owner\/name/,
  );
});

test("an entry with no repos at all is refused", () => {
  refuses(
    `
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos: []
    acceptance:
      - npm test
`,
    /`repos`/,
    /at least one/,
  );
});

test("an unquoted command YAML read as a mapping is refused, not dropped", () => {
  // `- kubectl get pods: -n caterpillar` parses as a mapping, and silently dropping it
  // would shrink the completion gate to whatever survived — the failure mode is a task
  // marked done having run fewer commands than the operator wrote.
  refuses(
    `
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm test
      - foo: bar
`,
    /`acceptance\[1\]`/,
    /must be a string/,
  );
});

test("an entry broken before it has an alertname is located by index", () => {
  // The operator is looking at a file with several entries. When the name is missing the
  // index is the only handle there is, and an error without one is unactionable.
  refuses(
    `
version: 1
alerts:
  - workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm test
`,
    /alerts\[0\]/,
    /`alertname`/,
  );
});

test("`maxOpenTasks` must be a positive integer", () => {
  const document = (value: string): string => `
version: 1
alerts:
  - alertname: CaterpillarNoProgress
    workspace: caesar
    repos:
      - github.com/caesarakalaeii/caterpillar
    acceptance:
      - npm test
    maxOpenTasks: ${value}
`;
  // Zero would silence the alert entirely while looking like a rate limit, which is the
  // sort of configuration mistake that is only discovered when an incident is missed.
  refuses(document("0"), /`maxOpenTasks`/, /positive integer/);
  refuses(document("-1"), /`maxOpenTasks`/);
  refuses(document("1.5"), /`maxOpenTasks`/);
  refuses(document('"1"'), /`maxOpenTasks`/);
});

test("invalid YAML is a PolicyParseError, not a raw YAMLParseError", () => {
  // The caller catches one type. A parser exception leaking through would be reported as
  // an internal failure and retried, rather than as an operator mistake to be fixed.
  refuses("version: 1\nalerts: [\n  - bad\n", /not valid YAML/);
});

test("an empty or absent-alerts document is an empty policy, not an error", () => {
  // The poll loop calls this every cycle. An operator who has created the file and not
  // yet filled it in should get no alerts, not a parse failure logged every 30 seconds.
  assert.deepEqual(parsePolicy(""), EMPTY_POLICY);
  assert.deepEqual(parsePolicy("# nothing yet\n"), EMPTY_POLICY);
  assert.deepEqual(parsePolicy("version: 1\n").entries, []);
  assert.deepEqual(parsePolicy("version: 1\nalerts:\n").entries, []);
});

test("lookupPolicy misses cleanly on an alert nobody opted in", () => {
  const policy = parsePolicy(VALID);

  assert.equal(lookupPolicy(policy, "CaterpillarNoProgress")?.workspace, "caesar");
  // Undefined, not a throw and not a default entry: an unlisted alert is simply not
  // handled, and the receiver's answer to it is "nothing to do" rather than an error.
  assert.equal(lookupPolicy(policy, "SomeOtherThingFiring"), undefined);
  // Exact match on the label. A near miss must not be handled by the wrong policy.
  assert.equal(lookupPolicy(policy, "caterpillarnoprogress"), undefined);
  assert.equal(lookupPolicy(EMPTY_POLICY, "CaterpillarNoProgress"), undefined);
});

test("an alert task id is `ALERT-<fingerprint>` and survives isTaskId", () => {
  assert.equal(alertTaskId("a1b2c3d4e5f60718"), "ALERT-a1b2c3d4e5f60718");
  assert.equal(isAlertTaskId("ALERT-a1b2c3d4e5f60718"), true);
  assert.equal(isAlertTaskId("GH-acme-widget-12"), false);
});

test("a fingerprint that is not lowercase hex never becomes a task id", () => {
  // The fingerprint arrives in an HTTP body from outside the process and becomes a
  // DIRECTORY NAME under `tasks/`. Alertmanager renders lowercase hex, so constraining
  // it costs nothing real and keeps the guard on every other intake path untouched.
  for (const bad of ["", "../../etc", ".", "..", "A1B2", "a1b2/c3", "a1b2 c3", "zzzz"]) {
    assert.equal(isAlertFingerprint(bad), false, `'${bad}' is not a fingerprint`);
    assert.equal(alertTaskId(bad), undefined, `'${bad}' produces no task id`);
  }
});
