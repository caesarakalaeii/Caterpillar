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
import { asTaskId } from "../domain/task.ts";
import type { Logger } from "../obs/log.ts";
import type { ChatInbox } from "../supervisor/inbox.ts";
import type { TaskSnapshot } from "../supervisor/snapshot.ts";
import type { DiscordBot } from "./bot.ts";
import { parseCommand, type Command } from "./commands.ts";
import { answerModal, disableAll, type ActionRow } from "./components.ts";
import type { FetchLike } from "./http.ts";
import {
  autocomplete,
  INTERACTION,
  interactionUser,
  openModal,
  reply,
  respond,
  updateMessage,
  type Interaction,
  type InteractionResponse,
} from "./interactions.ts";
import { describeList, describeOutcome, describeTask, queued } from "./replies.ts";
import { ANSWER_FIELD, parseInteraction } from "./slash.ts";
import type { ThreadIndex } from "./threads.ts";

export interface BridgeDeps {
  readonly bot: DiscordBot;
  readonly inbox: ChatInbox;
  readonly snapshot: TaskSnapshot;
  readonly logger: Logger;
  /** Thread ↔ task, so a reply in a thread needs no task id (§14.3). */
  readonly threads?: ThreadIndex;
  readonly fetch?: FetchLike;
}

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
   * A message typed in the channel, or in one of our threads.
   *
   * A thread carries a task, so a bare `!answer` typed there needs no id — the thread is
   * the id. That is the whole reason a brainstorm's questions are worth putting in one:
   * refining an idea means many short answers, and retyping `BS-1537…` before each of
   * them is exactly the friction this set out to remove.
   */
  async handleMessage(content: string, author: string, channelId: string): Promise<void> {
    const thread = this.deps.threads?.taskFor(channelId);
    const command = parseCommand(content, thread);
    if (command === undefined) return;

    this.deps.logger.info("bridge.command", { kind: command.kind, author, thread });

    if (thread !== undefined && command.kind === "answer") {
      const outcome = await this.deps.inbox.submit({
        kind: "answer",
        task: command.task,
        text: command.text,
      });
      // Talking in a thread while the agent is working is ORDINARY, not an error. Every
      // line here is now an answer, so replying "not waiting on an answer" to each one
      // would turn a conversation into a wall of refusals. The typing indicator is what
      // says the agent is busy.
      if (outcome.kind === "not-waiting") return;
      await this.say(describeOutcome(command.task, outcome), channelId);
      return;
    }

    await this.say(await this.execute(command, author), channelId);
  }

  /** A slash command, button click or modal submission. */
  async handleInteraction(interaction: Interaction): Promise<void> {
    const { bot, logger } = this.deps;
    const who = interactionUser(interaction);

    // Autocomplete accepts exactly one kind of response, so a refusal has to be an empty
    // suggestion list rather than a message. Checked first for that reason alone.
    if (interaction.type === INTERACTION.autocomplete) {
      const intent = parseInteraction(interaction);
      const query = intent.kind === "autocomplete" ? intent.query : "";
      await this.answer(
        interaction,
        autocomplete(
          this.deps.snapshot.suggest(query).map((task) => ({
            name: `${task.id} — ${task.status}`,
            value: task.id,
          })),
        ),
      );
      return;
    }

    // A guild-registered command can be invoked from any channel the bot can see. §7
    // restricts it to one channel deliberately: a bot that acts anywhere it is visible
    // is a bot anyone in the guild can drive.
    //
    // OUR THREADS COUNT. They were not on this list at first, and the effect was that
    // every button posted into a brainstorm thread answered "I only act in #caterpillar"
    // — the Answer button under a question was dead on arrival, in the one place
    // questions are asked.
    const from = interaction.channel_id;
    if (from !== undefined && from !== bot.channelId && this.deps.threads?.knows(from) !== true) {
      await this.answer(
        interaction,
        reply(`I only act in <#${bot.channelId}> and its threads.`, { ephemeral: true }),
      );
      return;
    }

    const intent = parseInteraction(interaction);
    logger.info("bridge.interaction", { kind: intent.kind, type: interaction.type, author: who });

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

      case "run":
        await this.run(interaction, intent.command, who);
        return;
    }
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

    const what =
      command.kind === "answer"
        ? `Answering ${command.task}`
        : command.kind === "merge"
          ? `Merging ${command.task}`
          : `Cancelling ${command.task}`;
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
        return this.startBrainstorm(command.topic, command.repo, author);
      case "malformed":
        return command.reason;
      case "list": {
        const tasks =
          command.status === undefined ? snapshot.all() : snapshot.withStatus(command.status);
        return describeList(tasks, command.status);
      }
      case "show":
        return describeTask(command.task, snapshot.find(command.task));
      case "answer":
        return describeOutcome(
          command.task,
          await inbox.submit({ kind: "answer", task: command.task, text: command.text }),
        );
      case "park":
        return describeOutcome(
          command.task,
          await inbox.submit({ kind: "park", task: command.task }),
        );
      case "merge":
        return describeOutcome(
          command.task,
          await inbox.submit({ kind: "merge", task: command.task }),
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
  private async startBrainstorm(topic: string, repo: string, author: string): Promise<string> {
    const { bot, inbox, threads, logger } = this.deps;

    // Always in the main channel, never in whatever thread the command was typed in:
    // Discord does not nest threads, and a brainstorm inside a brainstorm is a plan
    // nobody can follow anyway.
    const opening = await bot.postMessage({
      content: [`**Brainstorm** — ${repo}`, "", topic.trim(), "", `Raised by ${author}.`].join("\n"),
    });

    const threadId = await bot.createThread(opening.id, threadName(topic));
    logger.info("bridge.brainstorm", { thread: threadId, repo, author });

    const outcome = await inbox.submit({ kind: "brainstorm", topic, repo, threadId, author });
    if (outcome.kind === "started") threads?.bind(threadId, outcome.task);

    // Answered in the THREAD rather than where the command was typed, so the whole
    // conversation starts in one place.
    await this.say(describeOutcome(asTaskId(threadId), outcome), threadId);
    return `Brainstorming in <#${threadId}>.`;
  }

  /** Say something in the channel. Never throws — a lost reply must not unwind a click. */
  private async say(content: string, channelId?: string): Promise<void> {
    await this.deps.bot
      .postMessage({ content, ...(channelId === undefined ? {} : { channelId }) })
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
