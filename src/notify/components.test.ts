/**
 * The component builders, and the one thing about them that can go quietly wrong: a
 * `custom_id` is capped at 100 characters and is the ONLY thing a button carries. Every
 * assertion here is about refusing to produce an id that decodes to the wrong task,
 * rather than about the JSON shape, which Discord validates anyway.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import {
  answerModal,
  doneModal,
  BUTTON_STYLE,
  button,
  COMPONENT,
  CUSTOM_ID_LIMIT,
  decodeCustomId,
  disableAll,
  encodeCustomId,
  linkButton,
  row,
  rows,
  type Verb,
} from "./components.ts";

const TASK = asTaskId("GH-acme-widget-42");

test("an action round-trips through a custom_id", () => {
  const encoded = encodeCustomId({ verb: "ans", task: TASK });
  assert.ok(encoded !== undefined);
  assert.deepEqual(decodeCustomId(encoded), { verb: "ans", task: TASK });
});

test("an argument round-trips alongside the task", () => {
  const encoded = encodeCustomId({ verb: "merge", task: TASK, arg: "7" });
  assert.ok(encoded !== undefined);
  assert.deepEqual(decodeCustomId(encoded), { verb: "merge", task: TASK, arg: "7" });
});

test("an id that would not fit is refused rather than truncated", () => {
  // A truncated task id is still a VALID-looking task id: it decodes cleanly and
  // addresses a different task, or none. Refusing costs one button; truncating would
  // answer the wrong question.
  const long = asTaskId("T".repeat(CUSTOM_ID_LIMIT));
  assert.equal(encodeCustomId({ verb: "ans", task: long }), undefined);
  assert.equal(button({ action: { verb: "ans", task: long }, label: "Answer" }), undefined);
});

test("a custom_id is never longer than Discord accepts", () => {
  const task = asTaskId("A".repeat(CUSTOM_ID_LIMIT - "c1:plan-ok:".length));
  const encoded = encodeCustomId({ verb: "plan-ok", task });
  assert.ok(encoded !== undefined);
  assert.equal(encoded.length, CUSTOM_ID_LIMIT);
});

test("a task id that could escape the task tree is refused on the way back in", () => {
  // The decoded id becomes a directory name under `tasks/`. Nothing between Discord and
  // the store re-validates it, so this is the only place the traversal is stopped.
  assert.equal(decodeCustomId("c1:ans:../../etc/passwd"), undefined);
  assert.equal(decodeCustomId("c1:ans:has space"), undefined);
});

test("a button from an older encoding is refused, not guessed at", () => {
  // Discord keeps message history forever. A button rendered by a previous deploy is
  // not a bug — it is a message someone scrolled back to.
  assert.equal(decodeCustomId("c0:ans:GH-acme-widget-42"), undefined);
  assert.equal(decodeCustomId("ans:GH-acme-widget-42"), undefined);
  assert.equal(decodeCustomId("c1:nonsense:GH-acme-widget-42"), undefined);
});

test("a link button needs no custom_id and therefore cannot fail", () => {
  const link = linkButton("View PR", "https://example.invalid/pr/1");
  assert.equal(link.style, BUTTON_STYLE.link);
  assert.equal(link.custom_id, undefined);
  assert.equal(link.url, "https://example.invalid/pr/1");
});

test("rows drop buttons that could not be built rather than failing the message", () => {
  const impossible = button({
    action: { verb: "ans", task: asTaskId("T".repeat(CUSTOM_ID_LIMIT)) },
    label: "Answer",
  });
  const possible = button({ action: { verb: "park", task: TASK }, label: "Park" });

  const only = row(impossible, possible);
  assert.ok(only !== undefined);
  assert.equal(only.components.length, 1);
  assert.equal(row(impossible), undefined, "a row with nothing in it must not be sent");
  assert.equal(rows(undefined), undefined);
});

test("a row over the five-button limit throws instead of earning a 400", () => {
  const six = Array.from({ length: 6 }, (_, i) =>
    button({ action: { verb: "park", task: TASK, arg: String(i) }, label: `b${i}` }),
  );
  assert.throws(() => row(...six), /at most 5 buttons/);
});

test("acknowledging a click disables every button on the message", () => {
  // This is what makes a second click harmless, which matters most for the one button
  // that merges.
  const attached = rows(
    row(
      button({ action: { verb: "merge", task: TASK }, label: "Merge" }),
      button({ action: { verb: "back", task: TASK }, label: "Send back" }),
    ),
  );
  assert.ok(attached !== undefined);

  for (const disabled of disableAll(attached)) {
    for (const component of disabled.components) {
      assert.equal(component.type, COMPONENT.button);
      assert.equal((component as { readonly disabled?: boolean }).disabled, true);
    }
  }
});

test("every verb the type allows also decodes at runtime", () => {
  // The union and the `VERBS` array behind `isVerb` are parallel by hand, so a verb added
  // to one and not the other type-checks and then decodes as "unrecognised button" in
  // front of whoever pressed it.
  const verbs: readonly Verb[] = ["ans", "park", "merge", "res", "back", "plan-ok", "plan-no", "done"];
  for (const verb of verbs) {
    const encoded = encodeCustomId({ verb, task: TASK });
    assert.ok(encoded !== undefined, verb);
    assert.deepEqual(decodeCustomId(encoded), { verb, task: TASK }, verb);
  }
});

test("the Mark done modal carries the task and asks for a reason", () => {
  const modal = doneModal(TASK, "reason");
  assert.ok(modal !== undefined);
  assert.deepEqual(decodeCustomId(modal.custom_id), { verb: "done", task: TASK });

  const field = modal.components[0]?.components[0];
  assert.equal(field?.custom_id, "reason");
  assert.equal(field?.type, COMPONENT.textInput);
  assert.equal((field as { readonly required?: boolean }).required, true);
});

test("the answer modal carries the task it will answer", () => {
  const modal = answerModal(TASK, "text");
  assert.ok(modal !== undefined);
  assert.deepEqual(decodeCustomId(modal.custom_id), { verb: "ans", task: TASK });

  const field = modal.components[0]?.components[0];
  assert.equal(field?.custom_id, "text");
  assert.equal(field?.type, COMPONENT.textInput);
});
