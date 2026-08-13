/**
 * Discord notifications. See DESIGN.md §11.
 *
 * STUB — signatures settled, HTTP call not implemented.
 *
 * Discord is a SIGNAL channel, not a log stream: questions, parks, and terminal
 * outcomes only. Everything else goes to Prometheus. Handoffs are deliberately
 * silent — a multi-hour task would otherwise produce twenty messages of noise.
 */
import type { TaskId } from "../domain/task.ts";

export type Notification =
  | { readonly kind: "question"; readonly task: TaskId; readonly question: string; readonly phase: string }
  | { readonly kind: "parked"; readonly task: TaskId; readonly reason: string }
  | { readonly kind: "done"; readonly task: TaskId; readonly prUrl: string }
  | { readonly kind: "failed"; readonly task: TaskId; readonly error: string };

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

export interface DiscordOptions {
  /** Webhook URL, resolved from the mounted SOPS secret. Never logged. */
  readonly webhookUrl: string;
}

export class DiscordNotifier implements Notifier {
  constructor(private readonly options: DiscordOptions) {}

  async notify(notification: Notification): Promise<void> {
    void this.options;
    void render(notification);
    throw new Error("DiscordNotifier.notify not implemented");
  }
}

/** Message body. Pure function so it is testable without a webhook. */
export const render = (notification: Notification): string => {
  switch (notification.kind) {
    case "question":
      return [
        `**${notification.task}** needs input`,
        `Phase: ${notification.phase}`,
        "",
        notification.question,
        "",
        `Reply: \`!answer ${notification.task} <your answer>\``,
      ].join("\n");
    case "parked":
      return `**${notification.task}** parked — ${notification.reason}`;
    case "done":
      return `**${notification.task}** done — ${notification.prUrl}`;
    case "failed":
      return `**${notification.task}** failed — ${notification.error}`;
  }
};

/** No-op notifier for local runs and tests. */
export class NullNotifier implements Notifier {
  async notify(): Promise<void> {
    // intentionally silent
  }
}
