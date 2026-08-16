/**
 * What an interaction means.
 *
 * The property under test throughout is CONVERGENCE: a slash command, a button, a modal
 * and a typed `!answer` must produce the same `Command`, because the supervisor has one
 * handler and must not be able to tell which surface it is serving. A transport that
 * grows its own semantics is the failure mode this file exists to prevent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskId } from "../domain/task.ts";
import { parseCommand } from "./commands.ts";
import { encodeCustomId } from "./components.ts";
import { INTERACTION, type Interaction } from "./interactions.ts";
import { ANSWER_FIELD, COMMANDS, parseInteraction } from "./slash.ts";

const TASK = asTaskId("GH-acme-widget-42");

const interaction = (over: Partial<Interaction>): Interaction => ({
  id: "1",
  token: "tok",
  type: INTERACTION.command,
  ...over,
});

test("/answer and !answer produce the same command", () => {
  const typed = parseCommand(`!answer ${TASK} use the existing migration path`);
  const slashed = parseInteraction(
    interaction({
      data: {
        name: "answer",
        options: [
          { name: "task", value: TASK },
          { name: "text", value: "use the existing migration path" },
        ],
      },
    }),
  );

  assert.equal(slashed.kind, "run");
  assert.deepEqual(slashed.kind === "run" ? slashed.command : undefined, typed);
});

test("a modal submission produces the same command as /answer", () => {
  const customId = encodeCustomId({ verb: "ans", task: TASK });
  assert.ok(customId !== undefined);

  const intent = parseInteraction(
    interaction({
      type: INTERACTION.modalSubmit,
      data: {
        custom_id: customId,
        components: [{ components: [{ custom_id: ANSWER_FIELD, value: "  yes, proceed  " }] }],
      },
    }),
  );

  assert.deepEqual(intent, {
    kind: "run",
    command: { kind: "answer", task: TASK, text: "yes, proceed" },
  });
});

test("the Answer button opens a modal rather than writing anything", () => {
  // The button cannot carry the answer, so it cannot go through the inbox. Opening a
  // modal is answered entirely by the interaction response, inside the 3-second budget.
  const customId = encodeCustomId({ verb: "ans", task: TASK });
  assert.ok(customId !== undefined);

  assert.deepEqual(
    parseInteraction(interaction({ type: INTERACTION.component, data: { custom_id: customId } })),
    { kind: "open-answer-modal", task: TASK },
  );
});

test("an autocompleted task id is still validated", () => {
  // Autocomplete is a SUGGESTION, not a constraint: Discord submits whatever was typed,
  // and the id becomes a directory name under `tasks/`.
  const intent = parseInteraction(
    interaction({ data: { name: "task", options: [{ name: "id", value: "../../etc" }] } }),
  );

  assert.equal(intent.kind, "run");
  assert.equal(intent.kind === "run" ? intent.command.kind : undefined, "malformed");
});

test("an empty answer is refused rather than written", () => {
  const intent = parseInteraction(
    interaction({
      data: { name: "answer", options: [{ name: "task", value: TASK }, { name: "text", value: "   " }] },
    }),
  );

  assert.equal(intent.kind, "run");
  assert.equal(intent.kind === "run" ? intent.command.kind : undefined, "malformed");
});

test("/tasks filters only on a status that exists", () => {
  assert.deepEqual(
    parseInteraction(interaction({ data: { name: "tasks", options: [{ name: "status", value: "parked" }] } })),
    { kind: "run", command: { kind: "list", status: "parked" } },
  );
  assert.deepEqual(
    parseInteraction(interaction({ data: { name: "tasks", options: [{ name: "status", value: "nonsense" }] } })),
    { kind: "run", command: { kind: "list" } },
  );
});

test("/cancel parks", () => {
  assert.deepEqual(
    parseInteraction(interaction({ data: { name: "cancel", options: [{ name: "task", value: TASK }] } })),
    { kind: "run", command: { kind: "park", task: TASK } },
  );
});

test("a client that submits the suggestion's LABEL still names the task", () => {
  // `bridge.ts` renders every suggestion as `<id> — <status>` and sets `value` to the
  // bare id, but some Discord clients commit the LABEL when the choice is taken by
  // keyboard rather than clicked. `/resume` felt the whole of that: every task it can
  // suggest is parked, so the suffix was always there and the command answered "not a
  // task id" to its own autocompletion.
  for (const status of ["parked", "awaiting-human", "done"]) {
    assert.deepEqual(
      parseInteraction(
        interaction({ data: { name: "resume", options: [{ name: "task", value: `${TASK} — ${status}` }] } }),
      ),
      { kind: "run", command: { kind: "resume", task: TASK } },
      status,
    );
  }
});

test("only OUR label is unwrapped — a suffix that is not a status stays refused", () => {
  // The unwrap must not become a general "take everything before a dash": that would
  // silently accept a pasted sentence and run the task it happened to start with.
  for (const value of [`${TASK} — ../../etc`, `${TASK} — `, `../../etc — parked`]) {
    const intent = parseInteraction(
      interaction({ data: { name: "resume", options: [{ name: "task", value }] } }),
    );
    assert.equal(intent.kind === "run" ? intent.command.kind : undefined, "malformed", value);
  }
});

test("autocomplete reports what is being typed", () => {
  assert.deepEqual(
    parseInteraction(
      interaction({
        type: INTERACTION.autocomplete,
        data: { name: "answer", options: [{ name: "task", value: "GH-ac", focused: true }] },
      }),
    ),
    { kind: "autocomplete", query: "GH-ac" },
  );
});

test("anything unrecognised is ignored, never guessed at", () => {
  const cases: readonly Interaction[] = [
    interaction({ data: { name: "deploy-everything" } }),
    interaction({ type: INTERACTION.component, data: { custom_id: "c0:ans:OLD" } }),
    interaction({ type: INTERACTION.component }),
    interaction({ type: INTERACTION.ping }),
  ];

  for (const each of cases) {
    assert.equal(parseInteraction(each).kind, "ignored", JSON.stringify(each.data));
  }
});

test("every registered command has a handler", () => {
  // Registration is a full replace, so `COMMANDS` IS the surface. A command registered
  // with nothing behind it shows up in the client and answers "nothing to do".
  for (const command of COMMANDS) {
    const name = String(command["name"]);
    const intent = parseInteraction(interaction({ data: { name } }));
    assert.notEqual(intent.kind, "ignored", `/${name} is registered but not handled`);
  }
});

test("registered commands stay inside Discord's naming rules", () => {
  for (const command of COMMANDS) {
    const name = String(command["name"]);
    const description = String(command["description"]);
    assert.match(name, /^[a-z][a-z0-9-]{0,31}$/, name);
    assert.ok(description.length > 0 && description.length <= 100, description);
  }
});
