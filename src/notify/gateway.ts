/**
 * The Discord gateway connection — the inbound half of the channel. See DESIGN.md §7.
 *
 * A websocket the runner DIALS OUT to, not an endpoint anyone dials in to. That is the
 * whole reason this can exist at all: §6 has runners polling outward so a machine behind
 * NAT needs no inbound connectivity, and a public interactions endpoint would have broken
 * that for every runner that is not this pod. It also means no ingress, no TLS to manage,
 * and no URL to leak.
 *
 * No dependency: node ships a global WebSocket. The protocol implemented here is the
 * minimum that stays connected — hello/identify/heartbeat/resume — and nothing else.
 *
 * Traps, all of them ways this stays quietly broken rather than loudly:
 *   - the FIRST heartbeat must be jittered, or every reconnecting client on the planet
 *     heartbeats in lockstep and Discord sheds the herd.
 *   - a heartbeat with no ACK before the next one is due means the socket is a zombie:
 *     still open, delivering nothing. It has to be torn down deliberately.
 *   - `d` is the sequence number and RESUME depends on it. Tracking it only for
 *     dispatches loses the thread after a reconnect.
 *   - the bot reads the channel it also POSTS to. Its own notifications end with a
 *     literal "!answer …" hint, so ignoring bots and webhooks is not optional.
 */
import type { Logger } from "../obs/log.ts";
import type { PresencePayload } from "./activity.ts";
import type { Interaction } from "./interactions.ts";

/** Injection seam for tests. Production uses the global WebSocket. */
export type SocketLike = {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  addEventListener(type: "open" | "error" | "close", handler: () => void): void;
};

export type SocketFactory = (url: string) => SocketLike;

export interface GatewayOptions {
  readonly token: string;
  /** Only messages here are read. Everything else in the guild is ignored. */
  readonly channelId: string;
  /**
   * Threads of that channel which are also read (§14.3).
   *
   * A message in a thread arrives with `channel_id` set to the THREAD and no reference to
   * its parent, so there is no way to recognise one without knowing which threads are
   * ours. Optional: without it only the channel itself is read.
   */
  readonly threads?: { knows(channelId: string): boolean };
  readonly onMessage: (content: string, author: string, channelId: string) => Promise<void>;
  /**
   * Slash commands, buttons and modal submissions.
   *
   * Delivered over this same socket because the application has no Interactions
   * Endpoint URL — the two delivery methods are mutually exclusive, and an endpoint
   * would have cost the outward-only property this whole file exists to preserve.
   *
   * Unlike a message, an interaction is NOT filtered here. Dropping one silently shows
   * the person who clicked a permanent "This interaction failed", so the decision about
   * whether it is ours belongs where a reply can still be sent.
   */
  readonly onInteraction?: (interaction: Interaction) => Promise<void>;
  /**
   * What the bot advertises it is doing (`activity.ts`), if anything.
   *
   * Optional, and absent in every existing test: a gateway with no presence source behaves
   * exactly as it did before this existed. `payload()` is read at IDENTIFY so a fresh
   * connection is never briefly blank, and `attach` is called at READY so a later change
   * reaches this socket — the two together are why a reconnect does not lose the presence.
   */
  readonly presence?: {
    payload(): PresencePayload | undefined;
    attach(send: (payload: PresencePayload) => void): void;
    resend(): void;
    detach(): void;
  };
  readonly logger: Logger;
  readonly socket?: SocketFactory;
  /** Seam for tests; production waits for real. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/**
 * GUILD_MESSAGES | MESSAGE_CONTENT.
 *
 * MESSAGE_CONTENT is PRIVILEGED: without it enabled in the application's settings every
 * message arrives with an empty `content` and the bridge silently never matches a
 * command. That is a checkbox in the developer portal, not something code can fix.
 */
const INTENTS = (1 << 9) | (1 << 15);

const OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  presenceUpdate: 3,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const;

interface Payload {
  readonly op: number;
  readonly d?: unknown;
  readonly s?: number | null;
  readonly t?: string | null;
}

interface MessageCreate {
  readonly channel_id?: string;
  readonly content?: string;
  readonly webhook_id?: string;
  readonly author?: { readonly id?: string; readonly username?: string; readonly bot?: boolean };
}

/** Backoff between reconnects, so a hard outage does not become a reconnect storm. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export class DiscordGateway {
  private readonly options: GatewayOptions;
  private readonly open: SocketFactory;
  private readonly pause: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private sequence: number | null = null;
  private sessionId: string | undefined;
  private resumeUrl: string | undefined;
  /**
   * Whether a socket is currently identified and acking heartbeats.
   *
   * Exists for the standalone bot's health check (`src/bot.ts`). A bot process whose
   * gateway is down is a bot that answers nothing, and `supervisor/loop.ts:~287`'s lesson
   * is that a process which answers probes while doing nothing useful is worse than one
   * that exits — so this has to be observable from outside, not merely logged.
   *
   * Set at READY/RESUMED rather than at dial: an open TCP connection that has not
   * identified delivers nothing, and reporting it as healthy would be the exact lie this
   * is here to prevent. Cleared on every teardown, including the zombie case.
   */
  private live = false;

  constructor(options: GatewayOptions) {
    this.options = options;
    this.open = options.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.pause = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  /**
   * Is there a live, identified connection right now?
   *
   * Read by the bot's readiness probe. Deliberately not "has ever connected": a bot that
   * connected at boot and has been reconnect-looping for ten minutes is not serving
   * anyone, and reporting it ready keeps a broken pod in the Service.
   */
  connected(): boolean {
    return this.live;
  }

  /** Connect, and keep reconnecting until `signal` aborts. Never throws. */
  async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;

    while (!signal.aborted) {
      try {
        const resumed = await this.connect(signal);
        // A connection that lived long enough to resume is a healthy one; only a
        // failing dial should escalate the backoff.
        attempt = resumed ? 0 : attempt + 1;
      } catch (error) {
        attempt += 1;
        this.options.logger.warn("gateway.error", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (signal.aborted) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6), RECONNECT_MAX_MS);
      await this.pause(delay);
    }
  }

  /** One connection, from dial to close. Resolves when the socket closes. */
  private connect(signal: AbortSignal): Promise<boolean> {
    const { logger } = this.options;
    const socket = this.open(this.resumeUrl ?? GATEWAY_URL);

    return new Promise<boolean>((resolve) => {
      let heartbeat: NodeJS.Timeout | undefined;
      let acked = true;
      let alive = false;
      let settled = false;

      const shutdown = (why: string): void => {
        if (settled) return;
        settled = true;
        // Before anything else: from here on this process is not connected, and a probe
        // arriving during teardown must be told so rather than reading a stale `true`.
        this.live = false;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        // Before the close, so a presence change landing during teardown cannot be written
        // to a socket this function is about to dispose of.
        this.options.presence?.detach();
        signal.removeEventListener("abort", abort);
        try {
          socket.close(1000);
        } catch {
          // Already gone; closing twice is not an error worth reporting.
        }
        logger.debug("gateway.closed", { why });
        resolve(alive);
      };

      const abort = (): void => shutdown("shutdown");
      signal.addEventListener("abort", abort, { once: true });

      const beat = (interval: number): void => {
        if (!acked) {
          // The socket is open and delivering nothing — a zombie. Reconnecting is the
          // only way back; waiting on it looks identical to an idle channel forever.
          logger.warn("gateway.zombie", { intervalMs: interval });
          shutdown("missed-ack");
          return;
        }
        acked = false;
        socket.send(JSON.stringify({ op: OP.heartbeat, d: this.sequence }));
      };

      socket.addEventListener("error", () => shutdown("error"));
      socket.addEventListener("close", () => shutdown("close"));

      socket.addEventListener("message", (event) => {
        let payload: Payload;
        try {
          payload = JSON.parse(String(event.data)) as Payload;
        } catch {
          return;
        }

        // Tracked for EVERY payload, not just dispatches: RESUME replays from this
        // number, and a stale one silently loses messages after a reconnect.
        if (typeof payload.s === "number") this.sequence = payload.s;

        switch (payload.op) {
          case OP.hello: {
            const presence = this.options.presence?.payload();
            const interval = (payload.d as { heartbeat_interval?: number })?.heartbeat_interval;
            const period = typeof interval === "number" && interval > 0 ? interval : 41_250;
            // Jittered, because every client reconnecting after an outage would
            // otherwise beat in lockstep.
            void this.pause(period * this.random()).then(() => {
              if (settled) return;
              beat(period);
              heartbeat = setInterval(() => beat(period), period);
              heartbeat.unref?.();
            });

            socket.send(
              this.sessionId === undefined
                ? JSON.stringify({
                    op: OP.identify,
                    d: {
                      token: this.options.token,
                      intents: INTENTS,
                      properties: { os: "linux", browser: "caterpillar", device: "caterpillar" },
                      // Carried on IDENTIFY rather than sent as an opcode 3 straight after
                      // it: a separate send would leave the bot briefly present with no
                      // activity, which on a fleet that reconnects during every rollout is
                      // a visible flicker to no purpose. Omitted entirely before the first
                      // survey, because Discord reads a `presence` with no activities as an
                      // instruction to CLEAR one.
                      ...(presence === undefined ? {} : { presence }),
                    },
                  })
                : JSON.stringify({
                    op: OP.resume,
                    d: {
                      token: this.options.token,
                      session_id: this.sessionId,
                      seq: this.sequence,
                    },
                  }),
            );
            return;
          }

          case OP.heartbeatAck:
            acked = true;
            alive = true;
            return;

          case OP.reconnect:
            shutdown("asked-to-reconnect");
            return;

          case OP.invalidSession:
            // The session cannot be resumed. Dropping it forces a fresh IDENTIFY;
            // resuming again would be refused identically, forever.
            this.sessionId = undefined;
            this.resumeUrl = undefined;
            this.sequence = null;
            shutdown("invalid-session");
            return;

          case OP.dispatch:
            this.dispatch(payload, socket, () => settled);
            return;

          default:
            return;
        }
      });
    });
  }

  /**
   * `socket` and `closed` are threaded in rather than held on the instance because a
   * presence send must go to THIS connection: `run` reconnects, so an instance field would
   * outlive the socket it named and a presence change arriving mid-reconnect would be
   * written to a dead one. `closed` is read at send time for the same reason — the socket
   * can be torn down between the READY that attached and a change minutes later.
   */
  private dispatch(payload: Payload, socket: SocketLike, closed: () => boolean): void {
    const { logger, channelId, onMessage, onInteraction, presence } = this.options;

    if (payload.t === "INTERACTION_CREATE") {
      if (onInteraction === undefined) return;
      const interaction = payload.d as Interaction;
      void onInteraction(interaction).catch((error: unknown) => {
        logger.error("gateway.interaction-failed", {
          type: interaction.type,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    if (payload.t === "READY" || payload.t === "RESUMED") {
      // Identified and receiving. This is the earliest point at which the bot can
      // actually answer a human, which is what the readiness probe means by "up".
      this.live = true;

      if (payload.t === "READY") {
        const ready = payload.d as { session_id?: string; resume_gateway_url?: string };
        this.sessionId = ready.session_id;
        this.resumeUrl =
          ready.resume_gateway_url === undefined
            ? undefined
            : `${ready.resume_gateway_url}/?v=10&encoding=json`;
        logger.info("gateway.ready", { channel: channelId });
      }

      // Both events attach, because both mean "this socket is now the live one" and a later
      // change has to reach whichever it is.
      presence?.attach((next) => {
        if (closed()) return;
        try {
          socket.send(JSON.stringify({ op: OP.presenceUpdate, d: next }));
        } catch (error) {
          // Never fatal, and never retried here. A presence is a comfort signal (`bot.ts`
          // makes the same call for the typing indicator); the next survey re-sends it, and
          // a throw on this path would unwind into the socket's message handler.
          logger.debug("gateway.presence-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      // Only a RESUME pushes. A READY followed an IDENTIFY that already carried the
      // presence, so sending it again here would spend a second update out of a
      // per-connection allowance to repeat what Discord was just told. A resume carries no
      // IDENTIFY, so without this the runner comes back advertising whatever it was doing
      // before the disconnect — indefinitely, and worst for the longest outage.
      if (payload.t === "RESUMED") presence?.resend();
      return;
    }

    if (payload.t !== "MESSAGE_CREATE") return;

    const message = payload.d as MessageCreate;
    const from = message.channel_id;
    if (from === undefined) return;
    if (from !== channelId && this.options.threads?.knows(from) !== true) return;
    // The bridge reads the channel it posts into. Without this it answers its own
    // question notifications, which end with a literal `!answer` hint.
    if (message.author?.bot === true || message.webhook_id !== undefined) return;

    const content = message.content ?? "";
    if (content.length === 0) return;

    void onMessage(content, message.author?.username ?? "someone", from).catch((error: unknown) => {
      logger.error("gateway.handler-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
