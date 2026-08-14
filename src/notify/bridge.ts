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

export interface BridgeDeps {
  readonly bot: DiscordBot;
  readonly inbox: ChatInbox;
  readonly snapshot: TaskSnapshot;
  readonly logger: Logger;
  readonly fetch?: FetchLike;
}

export class DiscordBridge {
  private readonly deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  /** A message typed in the channel. Only `!answer` is recognised; see `commands.ts`. */
  async handleMessage(content: string, author: string): Promise<void> {
    const command = parseCommand(content);
    if (command === undefined) return;

    this.deps.logger.info("bridge.command", { kind: command.kind, author });
    const text = await this.execute(command);
    await this.say(text);
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
    if (interaction.channel_id !== undefined && interaction.channel_id !== bot.channelId) {
      await this.answer(
        interaction,
        reply(`I only act in <#${bot.channelId}>.`, { ephemeral: true }),
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
      await this.answer(interaction, reply(await this.execute(command), { ephemeral: true }));
      return;
    }

    const what =
      command.kind === "answer"
        ? `Answering ${command.task}`
        : command.kind === "merge"
          ? `Merging ${command.task}`
          : `Cancelling ${command.task}`;
    await this.answer(interaction, this.acknowledge(interaction, queued(what, who)));

    await this.say(await this.execute(command));
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
  private async execute(command: Command): Promise<string> {
    const { inbox, snapshot } = this.deps;

    switch (command.kind) {
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
