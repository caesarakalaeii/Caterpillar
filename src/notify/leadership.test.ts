/**
 * Which replica acts on Discord, and what happens when that changes.
 *
 * The properties that matter are all about the boundaries: nobody holds it before the
 * first refresh, a holder that cannot prove its claim steps down rather than assuming,
 * and a failure to reach the remote never propagates into the poll loop.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRunnerId } from "../domain/task.ts";
import { SILENT_LOGGER } from "../obs/log.ts";
import { ChatLeadership, CHAT_HOLDER_REF, type StealableClaims } from "./leadership.ts";

const RUNNER = asRunnerId("caterpillar-2");

/** Records what was asked of the claim, and answers with a script. */
const claims = (answers: readonly (string | undefined | Error)[]): StealableClaims & {
  readonly asked: { ref: string; held: string | undefined }[];
} => {
  const asked: { ref: string; held: string | undefined }[] = [];
  let call = 0;
  return {
    asked,
    claimStealable: (ref, _message, held) => {
      asked.push({ ref, held });
      const answer = answers[Math.min(call++, answers.length - 1)];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
};

const leadership = (claimer: StealableClaims): ChatLeadership =>
  new ChatLeadership({ claims: claimer, runner: RUNNER, logger: SILENT_LOGGER });

test("nothing is held until the first refresh", () => {
  // A replica that assumed leadership at construction would act on the events arriving in
  // the seconds before its first poll — which is exactly when every replica is starting.
  assert.equal(leadership(claims([])).held(), false);
});

test("winning the claim makes this replica the one that acts", async () => {
  const claimer = claims(["oid-1"]);
  const subject = leadership(claimer);

  await subject.refresh();

  assert.equal(subject.held(), true);
  assert.deepEqual(claimer.asked, [{ ref: CHAT_HOLDER_REF, held: undefined }]);
});

test("a holder renews from the oid it wrote, not from nothing", async () => {
  // Renewing with no expected oid would be a claim attempt, and `claimStealable` refuses
  // one against a live ref — so the holder would step down every poll and the fleet would
  // have no bridge until the claim went stale.
  const claimer = claims(["oid-1", "oid-2"]);
  const subject = leadership(claimer);

  await subject.refresh();
  await subject.refresh();

  assert.equal(subject.held(), true);
  assert.deepEqual(claimer.asked[1], { ref: CHAT_HOLDER_REF, held: "oid-1" });
});

test("a replica that does not win simply does not act", async () => {
  const subject = leadership(claims([undefined]));

  await subject.refresh();

  assert.equal(subject.held(), false, "three replicas out of four are here on every poll");
});

test("a holder whose claim was taken steps down", async () => {
  // The handover case. Continuing to act on a claim another replica now holds is the
  // double-acting this exists to prevent.
  const subject = leadership(claims(["oid-1", undefined]));

  await subject.refresh();
  assert.equal(subject.held(), true);

  await subject.refresh();
  assert.equal(subject.held(), false);
});

test("an unreachable remote steps down instead of throwing", async () => {
  // `refresh` is called from the poll loop. Throwing would make a network blip fail the
  // whole poll — no claiming, no chat drain, no intake — and stepping down is the honest
  // reading anyway: a claim that cannot be proved is not held.
  const subject = leadership(claims(["oid-1", new Error("ls-remote: could not resolve host")]));

  await subject.refresh();
  assert.equal(subject.held(), true);

  await subject.refresh();
  assert.equal(subject.held(), false);
});

test("a replica can win the claim back after losing it", async () => {
  // Whoever holds it next must be able to be this one again — otherwise a single blip
  // demotes a replica permanently, and with four of them the bridge walks away from the
  // fleet one pod at a time.
  const subject = leadership(claims(["oid-1", undefined, "oid-3"]));

  await subject.refresh();
  await subject.refresh();
  assert.equal(subject.held(), false);

  await subject.refresh();
  assert.equal(subject.held(), true);
});
