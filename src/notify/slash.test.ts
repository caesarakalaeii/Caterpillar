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
import {
  AMEND_CRITERIA_FIELD,
  AMEND_WHY_FIELD,
  ANSWER_FIELD,
  COMMANDS,
  DONE_REASON_FIELD,
  parseInteraction,
  repoChoices,
} from "./slash.ts";

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

test("an option button becomes an answer-option command carrying the index", () => {
  // The index and not the text: the text is stored beside the question, because a
  // `custom_id` holds 100 characters and the task id has spent most of them.
  const customId = encodeCustomId({ verb: "opt", task: TASK, arg: "2" });
  assert.ok(customId !== undefined);

  assert.deepEqual(
    parseInteraction(interaction({ type: INTERACTION.component, data: { custom_id: customId } })),
    { kind: "run", command: { kind: "answer-option", task: TASK, option: 2 } },
  );
});

test("an option button with no usable index is ignored, never answered as option 0", () => {
  // `arg` is free-form text off the wire. Defaulting it would answer the question with
  // whatever the first option happens to be, which is a choice the human did not make.
  for (const arg of ["", "first", "-1", "1.5"]) {
    const customId = encodeCustomId({ verb: "opt", task: TASK, arg });
    assert.ok(customId !== undefined);
    const intent = parseInteraction(
      interaction({ type: INTERACTION.component, data: { custom_id: customId } }),
    );
    assert.equal(intent.kind, "ignored", `\`${arg}\` was not refused`);
  }

  const bare = encodeCustomId({ verb: "opt", task: TASK });
  assert.ok(bare !== undefined);
  assert.equal(
    parseInteraction(interaction({ type: INTERACTION.component, data: { custom_id: bare } })).kind,
    "ignored",
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

test("/tasks carries a page, and drops one that is not a number", () => {
  // The client sends an integer, but `optionValue` stringifies whatever arrived and the
  // command surface is reachable by anything that can POST an interaction. A malformed page
  // is not worth refusing a listing over — the default page is the one almost everybody
  // wants — so it is dropped and `describeList` clamps whatever does get through.
  assert.deepEqual(
    parseInteraction(
      interaction({ data: { name: "tasks", options: [{ name: "page", value: 3 }] } }),
    ),
    { kind: "run", command: { kind: "list", page: 3 } },
  );
  assert.deepEqual(
    parseInteraction(
      interaction({
        data: { name: "tasks", options: [{ name: "status", value: "done" }, { name: "page", value: 2 }] },
      }),
    ),
    { kind: "run", command: { kind: "list", status: "done", page: 2 } },
  );

  for (const bad of ["two", "", 0, -1]) {
    assert.deepEqual(
      parseInteraction(
        interaction({ data: { name: "tasks", options: [{ name: "page", value: bad }] } }),
      ),
      { kind: "run", command: { kind: "list" } },
      `page:${JSON.stringify(bad)} must fall back to the first page`,
    );
  }
});

test("/cancel parks", () => {
  assert.deepEqual(
    parseInteraction(interaction({ data: { name: "cancel", options: [{ name: "task", value: TASK }] } })),
    { kind: "run", command: { kind: "park", task: TASK } },
  );
});

test("/done carries the reason a human gave for forcing it", () => {
  // The reason is the whole audit trail: `/done` bypasses both §12 gates, so a forced
  // completion with no stated cause is a task that reads as verified and is not.
  assert.deepEqual(
    parseInteraction(
      interaction({
        data: {
          name: "done",
          options: [
            { name: "task", value: TASK },
            { name: "reason", value: "  the feature was dropped from the roadmap  " },
          ],
        },
      }),
    ),
    {
      kind: "run",
      command: {
        kind: "force-done",
        task: TASK,
        reason: "the feature was dropped from the roadmap",
      },
    },
  );
});

test("/done with no reason is refused rather than written", () => {
  const intent = parseInteraction(
    interaction({
      data: { name: "done", options: [{ name: "task", value: TASK }, { name: "reason", value: "  " }] },
    }),
  );

  assert.equal(intent.kind, "run");
  const command = intent.kind === "run" ? intent.command : undefined;
  assert.equal(command?.kind, "malformed");
  assert.match(command?.kind === "malformed" ? command.reason : "", /reason/);
});

test("the Mark done button opens a modal rather than forcing anything", () => {
  // A button cannot carry the reason, and the reason is required — so the click has to
  // ask for it. Nothing is written by the click itself.
  const customId = encodeCustomId({ verb: "done", task: TASK });
  assert.ok(customId !== undefined);

  assert.deepEqual(
    parseInteraction(interaction({ type: INTERACTION.component, data: { custom_id: customId } })),
    { kind: "open-done-modal", task: TASK },
  );
});

test("the Mark done modal produces the same command as /done", () => {
  const customId = encodeCustomId({ verb: "done", task: TASK });
  assert.ok(customId !== undefined);

  assert.deepEqual(
    parseInteraction(
      interaction({
        type: INTERACTION.modalSubmit,
        data: {
          custom_id: customId,
          components: [{ components: [{ custom_id: DONE_REASON_FIELD, value: " obsolete " }] }],
        },
      }),
    ),
    { kind: "run", command: { kind: "force-done", task: TASK, reason: "obsolete" } },
  );
});

test("a Mark done modal submitted with no reason is refused", () => {
  const customId = encodeCustomId({ verb: "done", task: TASK });
  assert.ok(customId !== undefined);

  const intent = parseInteraction(
    interaction({
      type: INTERACTION.modalSubmit,
      data: {
        custom_id: customId,
        components: [{ components: [{ custom_id: DONE_REASON_FIELD, value: "   " }] }],
      },
    }),
  );
  const command = intent.kind === "run" ? intent.command : undefined;
  assert.equal(command?.kind, "malformed");
});

test("the Amend criteria button opens a modal rather than writing anything", () => {
  // The pre-fill has to be read from the state repo, which the parser cannot do — so the
  // press is an instruction to open a box, and the criteria arrive with the submission.
  const customId = encodeCustomId({ verb: "amd", task: TASK });
  assert.ok(customId !== undefined);

  assert.deepEqual(
    parseInteraction(interaction({ type: INTERACTION.component, data: { custom_id: customId } })),
    { kind: "open-amend-modal", task: TASK },
  );
});

test("/amend opens the same modal as the button", () => {
  assert.deepEqual(
    parseInteraction(
      interaction({ data: { name: "amend", options: [{ name: "task", value: TASK }] } }),
    ),
    { kind: "open-amend-modal", task: TASK },
  );
});

test("an amend modal submission carries one criterion per line and the reason", () => {
  const customId = encodeCustomId({ verb: "amd", task: TASK });
  assert.ok(customId !== undefined);

  assert.deepEqual(
    parseInteraction(
      interaction({
        type: INTERACTION.modalSubmit,
        data: {
          custom_id: customId,
          components: [
            {
              components: [
                {
                  custom_id: AMEND_CRITERIA_FIELD,
                  // Blank lines and stray indentation are what a paste into a paragraph box
                  // actually looks like, and neither is a criterion.
                  value: "  npm run check  \n\nnpm test -- src/widget\n",
                },
              ],
            },
            { components: [{ custom_id: AMEND_WHY_FIELD, value: "  the glob can never match  " }] },
          ],
        },
      }),
    ),
    {
      kind: "run",
      command: {
        kind: "amend",
        task: TASK,
        acceptance: ["npm run check", "npm test -- src/widget"],
        why: "the glob can never match",
      },
    },
  );
});

test("an amend modal submitted with no reason is refused", () => {
  // `why` is the whole audit value of the record. An amendment nobody explained is a
  // hand-edited spec.md with extra steps.
  const customId = encodeCustomId({ verb: "amd", task: TASK });
  assert.ok(customId !== undefined);

  const intent = parseInteraction(
    interaction({
      type: INTERACTION.modalSubmit,
      data: {
        custom_id: customId,
        components: [
          { components: [{ custom_id: AMEND_CRITERIA_FIELD, value: "npm test" }] },
          { components: [{ custom_id: AMEND_WHY_FIELD, value: "   " }] },
        ],
      },
    }),
  );
  const command = intent.kind === "run" ? intent.command : undefined;
  assert.equal(command?.kind, "malformed");
  assert.match(command?.kind === "malformed" ? command.reason : "", /why/i);
});

test("an amend modal submitted with no criteria is refused", () => {
  // An empty list would leave the task with nothing the supervisor can run, so it could
  // never be closed — the store refuses it too, and refusing here says so to a human.
  const customId = encodeCustomId({ verb: "amd", task: TASK });
  assert.ok(customId !== undefined);

  const intent = parseInteraction(
    interaction({
      type: INTERACTION.modalSubmit,
      data: {
        custom_id: customId,
        components: [
          { components: [{ custom_id: AMEND_CRITERIA_FIELD, value: "\n  \n" }] },
          { components: [{ custom_id: AMEND_WHY_FIELD, value: "the gate is wrong" }] },
        ],
      },
    }),
  );
  const command = intent.kind === "run" ? intent.command : undefined;
  assert.equal(command?.kind, "malformed");
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

const brainstorm = (topic: string, repo: string): Interaction =>
  interaction({
    data: {
      name: "brainstorm",
      options: [
        { name: "topic", value: topic },
        { name: "repo", value: repo },
      ],
    },
  });

test("/brainstorm still takes one repo", () => {
  // The regression that matters most: the option kept its name and its single-repo
  // meaning, so nobody's muscle memory broke when it learned to take a list.
  assert.deepEqual(parseInteraction(brainstorm("make it faster", "acme/widget")), {
    kind: "run",
    command: { kind: "brainstorm", topic: "make it faster", repos: ["acme/widget"] },
  });
});

test("/brainstorm takes several repos, separated by commas or by spaces", () => {
  // Both, because Discord's single-line option box invites both and neither is wrong.
  // A human who types one and gets a refusal learns nothing except to distrust it.
  for (const typed of [
    "acme/widget, acme/api",
    "acme/widget acme/api",
    "acme/widget,acme/api",
    "  acme/widget ,  acme/api  ",
  ]) {
    assert.deepEqual(
      parseInteraction(brainstorm("make it faster", typed)),
      {
        kind: "run",
        command: {
          kind: "brainstorm",
          topic: "make it faster",
          repos: ["acme/widget", "acme/api"],
        },
      },
      typed,
    );
  }
});

test("/brainstorm keeps a fully qualified repo qualified", () => {
  assert.deepEqual(parseInteraction(brainstorm("port it", "acme/widget, codeberg.org/contoso/api")), {
    kind: "run",
    command: {
      kind: "brainstorm",
      topic: "port it",
      repos: ["acme/widget", "codeberg.org/contoso/api"],
    },
  });
});

test("/brainstorm with no repo at all is still refused", () => {
  // A brainstorm that cannot read the code produces a plan about an imaginary codebase,
  // which is the expensive kind of wrong.
  for (const typed of ["", "   ", " , , "]) {
    const intent = parseInteraction(brainstorm("make it faster", typed));
    assert.equal(intent.kind, "run");
    const command = intent.kind === "run" ? intent.command : undefined;
    assert.equal(command?.kind, "malformed", JSON.stringify(typed));
    assert.match(
      command?.kind === "malformed" ? command.reason : "",
      /owner\/name/,
      "the refusal must show the shape it wanted",
    );
  }
});

test("one unparseable entry refuses the whole command, and names the offender", () => {
  // Not a partial accept: dropping the entry that did not parse produces a plan about
  // half a system, and the human is not told which half went missing.
  const intent = parseInteraction(brainstorm("make it faster", "acme/widget, widget, acme/api"));

  assert.equal(intent.kind, "run");
  const command = intent.kind === "run" ? intent.command : undefined;
  assert.equal(command?.kind, "malformed");
  assert.match(command?.kind === "malformed" ? command.reason : "", /`widget`/);
});

test("/brainstorm without a topic is refused before its repos are read", () => {
  const intent = parseInteraction(brainstorm("  ", "acme/widget"));
  const command = intent.kind === "run" ? intent.command : undefined;
  assert.equal(command?.kind, "malformed");
  assert.match(command?.kind === "malformed" ? command.reason : "", /topic/);
});

test("autocomplete reports what is being typed", () => {
  assert.deepEqual(
    parseInteraction(
      interaction({
        type: INTERACTION.autocomplete,
        data: { name: "answer", options: [{ name: "task", value: "GH-ac", focused: true }] },
      }),
    ),
    { kind: "autocomplete", field: "task", query: "GH-ac" },
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

    // Options have the same 100-character ceiling, and Discord rejects the WHOLE
    // registration if one exceeds it — so a description that grew to explain a list
    // takes every command down with it, silently, at deploy time.
    for (const option of (command["options"] as readonly Record<string, unknown>[]) ?? []) {
      const optionDescription = String(option["description"]);
      assert.match(String(option["name"]), /^[a-z][a-z0-9-]{0,31}$/, String(option["name"]));
      assert.ok(
        optionDescription.length > 0 && optionDescription.length <= 100,
        `${name}.${String(option["name"])}: ${optionDescription}`,
      );
    }
  }
});

/**
 * `/brainstorm repo:` is autocompleted (DESIGN.md §9.1.1).
 *
 * A repo that cannot be reached is now refused, which turns a typo into a refusal instead
 * of a parked task — but the better outcome is not having to type the name at all. These
 * cover the half that has to be right for that: which field is being completed, and what
 * a chosen suggestion puts back in the box.
 */
const CATALOG = ["acme/all-chat", "acme/all-chat-extension", "acme/widget"];

test("the repo box is completed from the catalogue, not from task ids", () => {
  const intent = parseInteraction(
    interaction({
      type: INTERACTION.autocomplete,
      data: { name: "brainstorm", options: [{ name: "repo", value: "allch", focused: true }] },
    }),
  );

  assert.deepEqual(intent, { kind: "autocomplete", field: "repo", query: "allch" });
});

test("every other autocompleted option is still a task id", () => {
  const boxes: readonly [string, string][] = [
    ["answer", "task"],
    ["task", "id"],
    ["cancel", "task"],
    ["resume", "task"],
  ];
  for (const [command, option] of boxes) {
    const intent = parseInteraction(
      interaction({
        type: INTERACTION.autocomplete,
        data: { name: command, options: [{ name: option, value: "widget", focused: true }] },
      }),
    );
    assert.deepEqual(intent, { kind: "autocomplete", field: "task", query: "widget" });
  }
});

test("a suggestion taken mid-list keeps the repos already typed", () => {
  // Discord replaces the WHOLE option value with the chosen one, so a choice that carried
  // only the repo it suggests would silently delete the others. This is a multi-repo
  // option (§14.3) and losing one produces a plan about half a system.
  const choices = repoChoices("acme/widget, allch", CATALOG);

  assert.deepEqual(
    choices.map((choice) => choice.value),
    ["acme/widget, acme/all-chat", "acme/widget, acme/all-chat-extension"],
  );
});

test("a repo already in the box is not offered twice", () => {
  const choices = repoChoices("acme/widget, ", CATALOG);
  assert.deepEqual(
    choices.map((choice) => choice.value),
    ["acme/widget, acme/all-chat", "acme/widget, acme/all-chat-extension"],
  );
});

test("a completion Discord would reject is dropped rather than sent", () => {
  // Discord's ceiling on a choice value is 100 characters and it rejects the whole
  // response — so one over-long completion would empty the box instead of trimming itself.
  const long = `acme/${"x".repeat(90)}`;
  const choices = repoChoices(`${long}, wid`, ["acme/widget"]);
  assert.deepEqual(choices, []);
});

test("the repo option is registered as autocompleted", () => {
  const brainstorm = COMMANDS.find((command) => command["name"] === "brainstorm");
  const options = (brainstorm?.["options"] as readonly Record<string, unknown>[]) ?? [];
  const repo = options.find((option) => option["name"] === "repo");
  assert.equal(repo?.["autocomplete"], true, "an unautocompleted box is where the typo came from");
});

test("in a thread a command needs no task id — the thread is the id", () => {
  // The friction this removes is the same one `parseCommand` removed for messages: a task
  // whose thread you are already reading should not have to be named again. It matters
  // most for `/resume`, whose whole audience is a parked task with a thread open on it.
  for (const [name, kind] of [
    ["resume", "resume"],
    ["cancel", "park"],
    ["task", "show"],
  ] as const) {
    assert.deepEqual(
      parseInteraction(interaction({ data: { name } }), { thread: TASK }),
      { kind: "run", command: { kind, task: TASK } },
      name,
    );
  }
});

test("/done in a task's own thread needs only the reason", () => {
  assert.deepEqual(
    parseInteraction(
      interaction({ data: { name: "done", options: [{ name: "reason", value: "obsolete" }] } }),
      { thread: TASK },
    ),
    { kind: "run", command: { kind: "force-done", task: TASK, reason: "obsolete" } },
  );
});

test("/amend in a task's own thread needs no id", () => {
  assert.deepEqual(parseInteraction(interaction({ data: { name: "amend" } }), { thread: TASK }), {
    kind: "open-amend-modal",
    task: TASK,
  });
});

test("an explicit id beats the thread's own task", () => {
  // `/answer` from inside a thread is how a different task is answered without leaving it
  // (§7.1), and the same has to hold for every other command or the option is a lie.
  const other = asTaskId("BS-999");
  assert.deepEqual(
    parseInteraction(
      interaction({ data: { name: "resume", options: [{ name: "task", value: other }] } }),
      { thread: TASK },
    ),
    { kind: "run", command: { kind: "resume", task: other } },
  );
});

test("outside a thread and with no id, the refusal says where the id comes from", () => {
  const intent = parseInteraction(interaction({ data: { name: "resume" } }));
  assert.equal(intent.kind, "run");
  const command = intent.kind === "run" ? intent.command : undefined;
  assert.equal(command?.kind, "malformed");
  assert.match(
    command?.kind === "malformed" ? command.reason : "",
    /thread/,
    "a human who omitted the id needs to be told the one place it is optional",
  );
});

test("a Resume button produces the same command as /resume", () => {
  // Convergence, and the reason the button exists: the park notification that asks for
  // guidance is posted into the thread, so the way back should be in the same message.
  const customId = encodeCustomId({ verb: "res", task: TASK });
  assert.ok(customId !== undefined);
  assert.deepEqual(
    parseInteraction(
      interaction({ type: INTERACTION.component, data: { custom_id: customId } }),
    ),
    { kind: "run", command: { kind: "resume", task: TASK } },
  );
});

test("every command that names one task can be told which by its thread", () => {
  // A registered option that is `required: true` is refused by the CLIENT before an
  // interaction is ever sent, so the thread default is unreachable unless the surface says
  // it is optional. This asserts the two halves agree.
  const optional = new Map([
    ["resume", "task"],
    ["cancel", "task"],
    ["task", "id"],
    ["done", "task"],
    ["amend", "task"],
  ]);
  for (const command of COMMANDS) {
    const name = command["name"] as string;
    const expected = optional.get(name);
    if (expected === undefined) continue;
    const options = command["options"] as readonly Record<string, unknown>[];
    const option = options.find((o) => o["name"] === expected);
    assert.equal(option?.["required"], false, `/${name} ${expected} must be optional`);
  }
});
