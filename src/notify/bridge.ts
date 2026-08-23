/**
 * The inbound half, joined up. See DESIGN.md §7.
 *
 * Four transports arrive here — a typed `!answer`, a slash command, a button, a modal —
 * and all four collapse into the same `Command` union before anything acts on them. The
 * supervisor cannot tell which one it served, which is the point: a new surface must not
 * be able to grow its own semantics behind the loop's back.
 *
 * The single rule everything else follows from: **acknowledge within 3 seconds, deliver
 * the outcome later.** A request that has to write the state repo goes through the inbox
 * and is settled by the poll loop, which may be hours into a session. The interaction
 * token expires after 15 minutes, so the real answer cannot be a followup on it — it is
 * an ordinary channel message from the bot. What the click gets immediately is an
 * acknowledgement that says so, with the buttons disabled so a second click cannot queue
 * the same write twice.
 *
 * Reads never take that path. `/tasks` and `/task` are answered from the in-memory
 * snapshot, inside the acknowledgement budget, because going through the loop for a
 * listing would mean waiting on a session to end before finding out what it is doing.
 */
import type { TaskId } from "../domain/task.ts";
import type { RepoCatalog } from "../forge/reach.ts";
import { errorFields, type Logger } from "../obs/log.ts";
import { brainstormId } from "../plan/brainstorm.ts";
import type { ChatSubmitter } from "../redis/inbox.ts";
import type { SnapshotReader } from "../redis/snapshot.ts";
import type { ChatOutcome } from "../supervisor/inbox.ts";
import type { DiscordBot } from "./bot.ts";
import { parseCommand, type Command } from "./commands.ts";
import {
  amendModal,
  answerModal,
  button,
  BUTTON_STYLE,
  disableAll,
  doneModal,
  row,
  rows,
  type ActionRow,
} from "./components.ts";
import type { FetchLike } from "./http.ts";
import {
  autocomplete,
  INTERACTION,
  interactionUser,
  openModal,
  reply,
  respond,
  updateMessage,
  type AutocompleteChoice,
  type Interaction,
  type InteractionResponse,
} from "./interactions.ts";
import { describeList, describeOutcome, describeTask, queued } from "./replies.ts";
import {
  AMEND_CRITERIA_FIELD,
  AMEND_WHY_FIELD,
  ANSWER_FIELD,
  DONE_REASON_FIELD,
  parseInteraction,
  repoChoices,
} from "./slash.ts";
import type { ThreadIndex } from "./threads.ts";

export interface BridgeDeps {
  readonly bot: DiscordBot;
  /**
   * Where a command that writes the state repo goes (§7).
   *
   * The INTERFACE rather than `ChatInbox`, because the submitter and the loop need not be
   * the same process: with Redis configured this is a list the standalone bot pushes onto
   * and the supervisor drains (`redis/inbox.ts`). Without it, it is the same in-process
   * queue it has always been.
   */
  readonly inbox: ChatSubmitter;
  /** Reads answered without touching git. Interface for the same reason `inbox` is. */
  readonly snapshot: SnapshotReader;
  readonly logger: Logger;
  /** Thread ↔ task, so a reply in a thread needs no task id (§14.3). */
  readonly threads?: ThreadIndex;
  /**
   * "Is this channel a thread of ours", for a channel no binding names.
   *
   * The gateway has had this for MESSAGES since `ThreadRouter` was written; interactions did
   * not, and the gap is what made `/resume` unusable in the one place it is wanted. The gate
   * below consulted `ThreadIndex.knows`, bindings dropped a task the moment it parked, and
   * `/resume` only ever addresses a parked or failed task — so the command was refused with
   * "I only act in #caterpillar and its threads" in the thread of the very task it names.
   *
   * Mostly unreached now, because an INTERACTION carries `channel.parent_id` and the check is
   * therefore free (see `fromOurChannel`). It is the fallback for a client or an event that
   * does not send it, and for the same honesty reason the message path has one.
   */
  readonly router?: { deliverable(channelId: string): Promise<boolean> };
  /**
   * Whether THIS replica is the one that acts on Discord (DESIGN.md §7).
   *
   * Absent means yes, which keeps a single-replica runner and every test that predates
   * the fleet working unchanged. In a fleet every replica holds a gateway connection —
   * that is what keeps the bot online through a rollout, and a connection costs nothing —
   * but exactly one may act on what arrives over it.
   *
   * Without this, four replicas each handled every event. Reads mostly hid it, because
   * Discord accepts one response per interaction token and the other three simply failed.
   * `/brainstorm` did not: a brainstorm's id is derived from the thread Discord has just
   * created for it, so one command opened four threads and minted four unrelated tasks.
   * An `!answer` was four runners writing the same state repo, which is how a runner ends
   * up holding a commit that can never rebase.
   */
  readonly leadership?: { readonly held: () => boolean };
  /**
   * The repos this runner can reach, for the `/brainstorm repo:` box (DESIGN.md §9.1.1).
   *
   * Optional, and absent is a supported shape rather than a degraded one: a standalone bot
   * process holds no forge credential at all, and without this the box is the free-text
   * field it has always been — the door checks are what stop an unreachable repo either
   * way. The autocomplete only removes the need to be told.
   */
  readonly repos?: RepoCatalog;
  readonly fetch?: FetchLike;
}

/**
 * The reaction that says a steer reached the session (§7.3).
 *
 * Eyes rather than a tick: a tick claims the agent has acted on it, and all that is actually
 * known at this point is that it is queued for the next turn boundary.
 */
const STEERED = "\u{1F440}";

/**
 * The Resume button under a reply that recorded guidance, or nothing.
 *
 * Only for a task that needs a human to restart it. On a `ready` or `running` task a Resume
 * button is an act with no effect, offered to somebody who was told to press it — and
 * `describeOutcome` says "the next session reads it" for exactly those.
 */
const resumeRow = (task: TaskId, outcome: ChatOutcome): readonly ActionRow[] | undefined =>
  outcome.kind === "guided" && outcome.resumable
    ? rows(row(button({ action: { verb: "res", task }, label: "Resume", style: BUTTON_STYLE.primary })))
    : undefined;

/** Discord caps a thread name at 100 characters, and a long one reads badly anyway. */
const threadName = (topic: string): string => {
  const line = (topic.split("\n")[0] ?? topic).trim();
  return line.length <= 90 ? line : `${line.slice(0, 89)}…`;
};

export class DiscordBridge {
  private readonly deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  /**
   * Is this replica the one that acts? Absent leadership means yes — see `BridgeDeps`.
   *
   * Checked at both inbound doors rather than deeper in, so a non-holder does no IO at
   * all: no reply, no thread, nothing queued. Silence is deliberate; a non-holder saying
   * "not me" would be three extra messages per command, and the holder is already
   * answering.
   */
  private acts(): boolean {
    return this.deps.leadership?.held() ?? true;
  }

  /**
   * A message typed in the channel, or in one of our threads.
   *
   * A thread carries a task, so a bare `!answer` typed there needs no id — the thread is
   * the id. That is the whole reason a brainstorm's questions are worth putting in one:
   * refining an idea means many short answers, and retyping `BS-1537…` before each of
   * them is exactly the friction this set out to remove.
   */
  async handleMessage(
    content: string,
    author: string,
    channelId: string,
    /**
     * The message's own id, when the caller has it — the gateway always does.
     *
     * Only used to react to it (§7.3). Optional so that every existing caller and test keeps
     * working, and its absence degrades to saying the acknowledgement in words.
     */
    messageId?: string,
    /**
     * The message this one REPLIES to, when it is a reply (`gateway.ts`).
     *
     * Optional, and absent is the ordinary case. See `targetOf` for what it buys.
     */
    replyTo?: string,
  ): Promise<void> {
    if (!this.acts()) return;
    const target = await this.targetOf(channelId, replyTo);
    const thread = target.task;

    // A message in a thread nothing can name. Ordinarily unreachable — the gateway delivers
    // from the channel, from threads the index knows, and from threads whose parent is ours —
    // but routine for the STANDALONE bot (§7), whose index arrives over Redis from the
    // supervisor and is therefore briefly stale: a thread bound seconds ago by a supervisor
    // that has not yet published, or a bot that started before any supervisor.
    //
    // The answer must be a message rather than silence. In a bound thread everything typed
    // IS the answer, so a human typing into one that looks unbound gets no reply at all,
    // and cannot tell that from the agent being busy — which is the failure this whole
    // split was meant to remove, arriving by a different door.
    if (thread === undefined && channelId !== this.deps.bot.channelId) {
      this.deps.logger.warn("bridge.unbound-thread", { channel: channelId, author });
      await this.say(
        "I do not know which task this thread belongs to yet — I am still catching up with " +
          "the supervisor. Try again in a moment, or use `/answer <task-id>` from the main " +
          "channel.",
        channelId,
      );
      return;
    }

    const command = parseCommand(content, thread);
    if (command === undefined) return;

    this.deps.logger.info("bridge.command", { kind: command.kind, author, thread });

    if (thread !== undefined && command.kind === "answer") {
      // Said whenever the reply could not be placed and rank had to decide (see `targetOf`).
      // Not decoration: answering the wrong sibling SILENTLY is the failure this path exists
      // to remove, and where the system cannot avoid guessing, a visible attribution is the
      // only way a human catches it.
      const note = target.guessed
        ? `\n\nI could not tell which task you were replying to, so I filed this against ` +
          `**${command.task}**. If that is wrong, say so with \`/answer <task-id>\`.`
        : "";

      const outcome = await this.deps.inbox.submit({
        kind: "answer",
        task: command.task,
        text: command.text,
      });

      // Talking in a thread while the agent is working is ORDINARY, not an error, and
      // answering each line with a message would turn a conversation into a wall of receipts
      // (§14.3: refining an idea is many short replies). §7.1 chose silence for that reason.
      //
      // Silence was still the wrong answer, because the two things it covered were not alike:
      // "the session has it" and "it was thrown away" looked identical, and until §7.3 the
      // second was what actually happened. So a steer is acknowledged on the human's OWN
      // message with a reaction — no new line in the thread — and everything else, which is
      // one message rather than one per reply, is answered in words.
      if (outcome.kind === "steered") {
        const reacted =
          messageId === undefined
            ? false
            : await this.deps.bot.react(channelId, messageId, STEERED).catch(() => false);
        // Only when the reaction could not be added, or when the target had to be guessed. A
        // silent failure here would put us back where we started, with a human unable to tell
        // delivery from discard — and a reaction cannot say WHICH task took the steer, which
        // is precisely what a guess has to be able to say.
        if (!reacted || note.length > 0) {
          await this.say(
            describeOutcome(command.task, outcome) + note,
            channelId,
            undefined,
            command.task,
          );
        }
        return;
      }

      await this.say(
        describeOutcome(command.task, outcome) + note,
        channelId,
        resumeRow(command.task, outcome),
        command.task,
      );
      return;
    }

    await this.say(await this.execute(command, author), channelId);
  }

  /**
   * Which task a message is for, and whether that had to be GUESSED.
   *
   * Three tiers, and all three are load-bearing because a thread does not name one task. A
   * plan's children inherit their brainstorm's thread (§14.3), so `threadBindings` picks an
   * owner by rank — `awaiting-human` over `running`/`ready` over `parked`/`failed`, then id
   * — and a reply meant for one child was filed against whichever sibling ranked highest.
   *
   * A Discord reply names the message it answers, and every task-scoped message the bot
   * posts is about exactly one task. So:
   *
   *   1. the in-memory index (`MessageIndex`), which costs nothing and covers the common
   *      case — a live thread, a reply within minutes of the question;
   *   2. a REST read of the referenced message, parsing its leading `**<task-id>**` and
   *      confirming it against the snapshot. Needed because the index does not survive a
   *      restart, and in the split deployment (§7) the process that posts a notification is
   *      not the one that reads the reply;
   *   3. the rank rule, unchanged — but flagged, so the caller says which task it chose.
   *
   * Neither of the first two alone would do. Index-only loses targeting for every live
   * thread across a rollout; REST-only cannot place a message Discord will not show us, and
   * spends a request per reply besides.
   *
   * A reply to something that is not a bot message, or to a message belonging to no known
   * task, falls through to tier 3 rather than erroring — that is the same answer as not
   * having replied at all, plus a note.
   *
   * Reply targeting only ever refines WHICH task inside a channel we already read. It does
   * not make the main channel a new door: replying to a notification there is not an
   * `!answer`, exactly as typing there is not.
   */
  private async targetOf(
    channelId: string,
    replyTo?: string,
  ): Promise<{ readonly task?: TaskId; readonly guessed: boolean }> {
    const ranked = await this.resolveThread(channelId);
    // Nothing to refine: not a reply, or a channel that names no task at all — in which case
    // the caller's next step is the honest "I cannot place this thread" reply, not routing.
    if (replyTo === undefined || ranked === undefined) {
      return ranked === undefined ? { guessed: false } : { task: ranked, guessed: false };
    }

    const indexed = this.deps.bot.taskForMessage(replyTo);
    if (indexed !== undefined) return { task: indexed, guessed: false };

    const fetched = await this.deps.bot
      .taskForFetchedMessage(channelId, replyTo)
      .catch(() => undefined);
    // Confirmed against the snapshot, because `isTaskId` admits any directory-safe name and
    // not every bold opener is a task: the brainstorm opening message begins `**Brainstorm**`,
    // which parses cleanly and answers to nothing. Filing against a task that does not exist
    // is worse than the rank fallback — it answers with "no such task" instead of at all.
    if (fetched !== undefined) {
      const known = await this.deps.snapshot.find(fetched).catch(() => undefined);
      if (known !== undefined) return { task: fetched, guessed: false };
    }

    this.deps.logger.info("bridge.reply-unplaced", { channel: channelId, replyTo, task: ranked });
    return { task: ranked, guessed: true };
  }

  /**
   * Which task a channel is the thread of, if any.
   *
   * Two sources, in order of authority:
   *
   * The published binding, which is the only one that can speak for a task whose thread it
   * does not own outright — a plan's children inherit their brainstorm's thread, and which of
   * them a message belongs to is a decision (`threadBindings`) rather than a derivation.
   *
   * Then the derivation. A brainstorm's id IS its thread id (§14.3), so `BS-<channel>` names
   * the task without a lookup table, and the snapshot is asked only whether that task exists.
   * This covers the two cases a binding cannot: an index that has not caught up, and a
   * brainstorm that is `done` — deliberately unbound, because there is nothing to ask a
   * finished task, but still owed an honest answer rather than "I am still catching up".
   */
  private async resolveThread(channelId: string): Promise<TaskId | undefined> {
    const bound = this.deps.threads?.taskFor(channelId);
    if (bound !== undefined) return bound;
    if (channelId === this.deps.bot.channelId) return undefined;

    const derived = brainstormId(channelId);
    const known = await this.deps.snapshot.find(derived).catch(() => undefined);
    return known === undefined ? undefined : derived;
  }

  /**
   * Is this channel the one we act in, or a thread of it?
   *
   * Three answers in cost order, and the first is why this is cheap enough to sit in front of
   * every interaction: Discord sends a partial `channel` on an interaction and it carries
   * `parent_id`, so a thread of our channel is provable from the payload — no binding, no REST
   * call, nothing that can be stale, and nothing that spends any of the three seconds an
   * interaction has. `MESSAGE_CREATE` carries no parent, which is why the message path needs
   * `ThreadRouter` and this mostly does not.
   *
   * The binding is second because it is the one that can be WRONG in the safe direction only:
   * a thread it names is certainly ours. The router is last and is the fallback for a payload
   * with no `channel` object, which is what a component interaction from an older client sends.
   */
  private async fromOurChannel(channelId: string, interaction: Interaction): Promise<boolean> {
    if (channelId === this.deps.bot.channelId) return true;
    if (interaction.channel?.parent_id === this.deps.bot.channelId) return true;
    if (this.deps.threads?.knows(channelId) === true) return true;
    return (await this.deps.router?.deliverable(channelId).catch(() => false)) ?? false;
  }

  /**
   * Completions for `/brainstorm repo:`, or none.
   *
   * Never throws. An autocomplete accepts exactly one response and no other kind, so a
   * forge that is refusing has to produce an empty box — an unanswered interaction is a
   * spinner that never resolves, which is worse than no suggestions. The catalogue is
   * already bounded and failure-isolated per workspace (`mergedCatalog`); this is the
   * belt to that braces, and covers a runner with no catalogue at all.
   */
  private async suggestRepos(typed: string): Promise<readonly AutocompleteChoice[]> {
    const catalog = this.deps.repos;
    if (catalog === undefined) return [];

    try {
      return repoChoices(typed, await catalog.reachable());
    } catch (error) {
      this.deps.logger.warn("bridge.repo-suggest-failed", errorFields(error));
      return [];
    }
  }

  /** A slash command, button click or modal submission. */
  async handleInteraction(interaction: Interaction): Promise<void> {
    if (!this.acts()) return;
    const { bot, logger } = this.deps;
    const who = interactionUser(interaction);

    // Autocomplete accepts exactly one kind of response, so a refusal has to be an empty
    // suggestion list rather than a message. Checked first for that reason alone.
    if (interaction.type === INTERACTION.autocomplete) {
      const intent = parseInteraction(interaction);
      const query = intent.kind === "autocomplete" ? intent.query : "";
      // Two boxes, two sources: a task id comes from the in-memory snapshot, a repo from
      // the workspaces' forges (§9.1.1). Neither may reach the state repo — an autocomplete
      // fires per keystroke.
      const choices =
        intent.kind === "autocomplete" && intent.field === "repo"
          ? await this.suggestRepos(query)
          : (await this.deps.snapshot.suggest(query)).map((task) => ({
              name: `${task.id} — ${task.status}`,
              value: task.id,
            }));
      await this.answer(interaction, autocomplete(choices));
      return;
    }

    // A guild-registered command can be invoked from any channel the bot can see. §7
    // restricts it to one channel deliberately: a bot that acts anywhere it is visible
    // is a bot anyone in the guild can drive.
    //
    // OUR THREADS COUNT, and getting that right has taken three goes. First they were not on
    // the list at all, so every button posted into a brainstorm thread answered "I only act in
    // #caterpillar" — the Answer button under a question was dead on arrival, in the one place
    // questions are asked. Then the list was `ThreadIndex.knows`, which is a BINDING, and
    // bindings dropped a task the moment it went terminal: `/resume` addresses nothing but
    // parked and failed tasks, so the command was refused in the thread of the very task it
    // names, and the park notification asking for it was posted to the channel besides.
    //
    // The test is now "is this a thread of our channel", which is what §7's rule actually
    // means and is a question about the CHANNEL rather than about any task's status.
    const from = interaction.channel_id;
    if (from !== undefined && !(await this.fromOurChannel(from, interaction))) {
      await this.answer(
        interaction,
        reply(`I only act in <#${bot.channelId}> and its threads.`, { ephemeral: true }),
      );
      return;
    }

    // Resolved before parsing, so `/resume` and `/cancel` in a thread need no task id — the
    // same friction `parseCommand` removed for messages (§7.1).
    const thread = from === undefined ? undefined : await this.resolveThread(from);
    const intent = parseInteraction(interaction, thread === undefined ? {} : { thread });
    logger.info("bridge.interaction", {
      kind: intent.kind,
      type: interaction.type,
      author: who,
      ...(thread === undefined ? {} : { thread }),
    });

    switch (intent.kind) {
      case "ignored":
        await this.answer(
          interaction,
          reply(`Nothing to do — ${intent.reason}.`, { ephemeral: true }),
        );
        return;

      case "autocomplete":
        // Unreachable: handled above, where the response type is the constrained one.
        return;

      case "open-answer-modal": {
        const modal = answerModal(intent.task, ANSWER_FIELD);
        await this.answer(
          interaction,
          modal === undefined
            ? reply(`\`${intent.task}\` is too long to answer from a button — use \`/answer\`.`, {
                ephemeral: true,
              })
            : openModal(modal),
        );
        return;
      }

      case "open-done-modal": {
        const modal = doneModal(intent.task, DONE_REASON_FIELD);
        await this.answer(
          interaction,
          modal === undefined
            ? reply(
                `\`${intent.task}\` is too long to force done from a button — use \`/done\`.`,
                { ephemeral: true },
              )
            : openModal(modal),
        );
        return;
      }

      case "open-amend-modal":
        await this.answer(interaction, await this.amendModalFor(intent.task));
        return;

      case "run":
        await this.run(interaction, intent.command, who);
        return;
    }
  }

  /**
   * The amend modal for one task, or the refusal that replaces it (DESIGN.md §12.3).
   *
   * The pre-fill has to come from the SNAPSHOT and not from the state repo: this may be the
   * standalone bot, which holds no state repo at all, and an interaction has three seconds to
   * be answered either way.
   *
   * Both refusals matter, and both are the same mistake avoided. What the modal submits is a
   * WHOLE replacement acceptance list, so a box that opened empty — because the task is not in
   * the snapshot, or its spec would not read — would delete every criterion the task has, and
   * nothing on the screen would say so. Likewise a list too long for Discord's 4000-character
   * input: `amendModal` returns undefined rather than clipping it, for the same reason.
   */
  private async amendModalFor(task: TaskId): Promise<InteractionResponse> {
    const summary = await this.deps.snapshot.find(task);
    const acceptance = summary?.acceptance;
    if (acceptance === undefined || acceptance.length === 0) {
      return reply(
        `I cannot read the acceptance criteria for \`${task}\`, so there is nothing to ` +
          `pre-fill and an empty box would replace the whole list with nothing. Check the id, ` +
          `or give the supervisor a moment to publish the task.`,
        { ephemeral: true },
      );
    }

    const modal = amendModal({
      task,
      acceptance,
      criteriaFieldId: AMEND_CRITERIA_FIELD,
      whyFieldId: AMEND_WHY_FIELD,
    });
    return modal === undefined
      ? reply(
          `\`${task}\` has more acceptance criteria than a Discord modal can hold, so they ` +
            `cannot be pre-filled — and an amendment submitted from a truncated list would ` +
            `delete the rest. Amend it by committing \`tasks/${task}/amendments/\` in the ` +
            `state repo instead.`,
          { ephemeral: true },
        )
      : openModal(modal);
  }

  /**
   * Acknowledge, then do the work.
   *
   * A read is answered outright. A write is acknowledged with what is knowable at click
   * time and its outcome posted to the channel afterwards — see the note at the top of
   * this file for why it cannot be a followup on the interaction.
   */
  private async run(interaction: Interaction, command: Command, who: string): Promise<void> {
    if (command.kind === "list" || command.kind === "show" || command.kind === "malformed") {
      await this.answer(interaction, reply(await this.execute(command, who), { ephemeral: true }));
      return;
    }

    if (command.kind === "brainstorm") {
      // Its own visible result is the opening message and the thread under it, so there
      // is nothing to announce afterwards — a second message in the channel saying the
      // thread exists is noise next to the thread.
      await this.answer(interaction, reply("Opening a thread…", { ephemeral: true }));
      await this.execute(command, who);
      return;
    }

    // A switch rather than a ternary chain, and deliberately without a default: the chain
    // this replaces ended in `Cancelling`, so adding `/resume` silently acknowledged a
    // resume as a cancellation — it did the right thing and said the opposite, which is
    // the worst of the two. With no default, the next command added here fails to compile
    // instead of inheriting somebody else's wording.
    const what = ((): string => {
      switch (command.kind) {
        case "answer":
        case "answer-option":
          return `Answering ${command.task}`;
        case "merge":
          return `Merging ${command.task}`;
        case "resume":
          return `Resuming ${command.task}`;
        case "park":
          return `Cancelling ${command.task}`;
        case "force-done":
          return `Marking ${command.task} done`;
        case "amend":
          return `Amending ${command.task}`;
      }
    })();
    await this.answer(interaction, this.acknowledge(interaction, queued(what, who)));

    await this.say(await this.execute(command, who));
  }

  /**
   * How a click is confirmed.
   *
   * From a button, the message the button sits on is rewritten with every button
   * DISABLED — which is what makes a second click harmless, and matters most for the
   * one button that merges. From a slash command or a modal there is no such message,
   * so the acknowledgement is ephemeral and only the person who ran it sees it.
   */
  private acknowledge(interaction: Interaction, note: string): InteractionResponse {
    if (interaction.type !== INTERACTION.component) return reply(note, { ephemeral: true });

    const original = interaction.message?.content ?? "";
    const components: readonly ActionRow[] = interaction.message?.components ?? [];
    return updateMessage(`${original}\n\n${note}`, disableAll(components));
  }

  /** Run a command and return what to say about it. Reads are served from the snapshot. */
  private async execute(command: Command, author: string): Promise<string> {
    const { inbox, snapshot } = this.deps;

    switch (command.kind) {
      case "brainstorm":
        return this.startBrainstorm(command.topic, command.repos, author);
      case "malformed":
        return command.reason;
      case "list": {
        const tasks =
          command.status === undefined
            ? await snapshot.all()
            : await snapshot.withStatus(command.status);
        return describeList(tasks, command.status, command.page);
      }
      case "show":
        return describeTask(command.task, await snapshot.find(command.task));
      case "answer":
        return describeOutcome(
          command.task,
          await inbox.submit({ kind: "answer", task: command.task, text: command.text }),
        );
      // The option TEXT is not here to submit: it lives beside the question in the state
      // repo, which the bridge deliberately cannot read (see the note at the top).
      case "answer-option":
        return describeOutcome(
          command.task,
          await inbox.submit({ kind: "answer-option", task: command.task, option: command.option }),
        );
      case "park":
        return describeOutcome(
          command.task,
          await inbox.submit({ kind: "park", task: command.task }),
        );
      case "resume":
        return describeOutcome(
          command.task,
          await inbox.submit({ kind: "resume", task: command.task }),
        );
      case "merge":
        return describeOutcome(
          command.task,
          await inbox.submit({ kind: "merge", task: command.task }),
        );
      case "force-done":
        // The one write that carries `author` into the loop. Nothing downstream can
        // reconstruct it, and the journal entry it goes into is the only record that this
        // `done` was somebody's decision rather than a verification.
        return describeOutcome(
          command.task,
          await inbox.submit({
            kind: "force-done",
            task: command.task,
            reason: command.reason,
            author,
          }),
        );
      // Carries `author` for the same reason: it goes into the amendment record and into the
      // journal, and the loop never sees Discord.
      case "amend":
        return describeOutcome(
          command.task,
          await inbox.submit({
            kind: "amend",
            task: command.task,
            acceptance: command.acceptance,
            why: command.why,
            author,
          }),
        );
    }
  }

  /**
   * Open the thread a brainstorm will live in, then ask the loop to create the task.
   *
   * The ONE place the bridge does IO before the loop is involved, and it is not an
   * exception to §7's rule so much as a consequence of it: the task's id is derived from
   * the thread id, so the thread has to exist first. Discord is still not being asked
   * anything about state — it is being asked for an identifier.
   *
   * A thread that is created and then fails to become a task leaves one empty thread in
   * the channel. That is the right way round: the alternative is a task whose thread does
   * not exist, which has nowhere to ask its first question.
   */
  private async startBrainstorm(
    topic: string,
    repos: readonly string[],
    author: string,
  ): Promise<string> {
    const { bot, inbox, threads, logger } = this.deps;

    const named = repos.join(", ");

    // Always in the main channel, never in whatever thread the command was typed in:
    // Discord does not nest threads, and a brainstorm inside a brainstorm is a plan
    // nobody can follow anyway.
    const opening = await bot.postMessage({
      content: [`**Brainstorm** — ${named}`, "", topic.trim(), "", `Raised by ${author}.`].join(
        "\n",
      ),
    });

    const threadId = await bot.createThread(opening.id, threadName(topic));
    logger.info("bridge.brainstorm", { thread: threadId, repos: named, author });

    // Both BEFORE the loop is awaited, and both are free — a brainstorm's id is its
    // thread id (§14.3), so neither the greeting nor the binding needs anything written
    // first. Waiting for the write is what made a `/brainstorm` land in an empty thread
    // and stay there: the loop is blocked for the whole of a session, and the human had
    // nothing to look at and nowhere their typing would be kept.
    //
    // Binding early is safe because ordering makes it safe. The creation is queued ahead
    // of anything typed afterwards and `drain` preserves that order, so by the time an
    // answer is applied its task exists. Until the agent asks something the answer is
    // `not-waiting`, which the message path already treats as ordinary.
    const task = brainstormId(threadId);
    threads?.bind(threadId, task);
    await this.say(
      `Starting \`${task}\` here. Talk to me in this thread — I will pick it up as soon ` +
        `as the runner reaches a session boundary.`,
      threadId,
    );

    const outcome = await inbox.submit({ kind: "brainstorm", topic, repos, threadId, author });

    // A thread no task owns must not stay bound. `threadBindings` unbinds terminal tasks
    // for exactly this reason: a message in a bound thread is an ANSWER, so a binding
    // with nothing behind it swallows everything typed into it in silence.
    if (outcome.kind !== "started") threads?.unbind(threadId);

    // Answered in the THREAD rather than where the command was typed, so the whole
    // conversation stays in one place.
    await this.say(describeOutcome(task, outcome), threadId, undefined, task);
    return `Brainstorming in <#${threadId}>.`;
  }

  /**
   * Say something in the channel. Never throws — a lost reply must not unwind a click.
   *
   * `task` records what the message is about, so a human replying to it can be routed back
   * to the same task rather than to whichever sibling outranks it (§7.3).
   */
  private async say(
    content: string,
    channelId?: string,
    components?: readonly ActionRow[],
    task?: TaskId,
  ): Promise<void> {
    await this.deps.bot
      .postMessage({
        content,
        ...(channelId === undefined ? {} : { channelId }),
        ...(components === undefined ? {} : { components }),
        ...(task === undefined ? {} : { task }),
      })
      .catch((error: unknown) => {
        this.deps.logger.warn("bridge.reply-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * Answer an interaction. Never throws.
   *
   * The realistic failure is arriving past the 3-second deadline, by which point the
   * interaction is gone and there is nothing to retry against. The human sees Discord's
   * own "interaction failed"; the log says which one and why.
   */
  private async answer(interaction: Interaction, response: InteractionResponse): Promise<void> {
    await respond({
      interaction,
      response,
      ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch }),
    }).catch((error: unknown) => {
      this.deps.logger.warn("bridge.interaction-reply-failed", {
        type: interaction.type,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
