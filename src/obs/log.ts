/**
 * Structured logging. See DESIGN.md §11.
 *
 * The supervisor's observability was metrics plus the per-task journal in the state
 * repo, and both are aggregates: neither answers "what is this runner doing right now"
 * or "why did that task park". The first task ever to run in-cluster completed with
 * `kubectl logs` empty from end to end, because the only writes to the process streams
 * were on error paths that a healthy run never reaches.
 *
 * One JSON object per line on stdout, which is what the cluster's Loki already ingests
 * from container output — no agent, no sidecar, no format to teach it.
 *
 * CREDENTIALS MUST NEVER BE LOGGED. Nothing here redacts anything, so the discipline is
 * at the call sites: log identifiers and outcomes, never a token, a credential path's
 * contents, or a raw HTTP header. `GitError` is safe to log by construction — §9.2
 * keeps tokens out of argv, so its message cannot contain one.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Scalars only: a record has to survive JSON and stay one grep-able line. */
export type LogValue = string | number | boolean;

export interface LogFields {
  readonly [key: string]: LogValue | undefined;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface JsonLoggerOptions {
  /** Records below this severity are dropped. */
  readonly level?: LogLevel;
  /** Sink for one finished line, newline included. Defaults to stdout. */
  readonly write?: (line: string) => void;
}

export class JsonLogger implements Logger {
  private readonly threshold: number;
  private readonly write: (line: string) => void;

  constructor(options: JsonLoggerOptions = {}) {
    this.threshold = SEVERITY[options.level ?? "info"];
    this.write = options.write ?? ((line) => void process.stdout.write(line));
  }

  debug(event: string, fields?: LogFields): void {
    this.emit("debug", event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.emit("info", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.emit("warn", event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.emit("error", event, fields);
  }

  private emit(level: LogLevel, event: string, fields?: LogFields): void {
    if (SEVERITY[level] < this.threshold) return;

    // Fields are spread FIRST so the reserved keys always win. A caller passing a field
    // called `level` would otherwise rewrite the severity that alerts filter on.
    // `JSON.stringify` drops undefined values, so optional context needs no guarding.
    this.write(
      `${JSON.stringify({
        ...fields,
        ts: new Date().toISOString(),
        level,
        event,
      })}\n`,
    );
  }
}

/** Discards everything. For tests, and for callers that must not touch the streams. */
export const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Normalise a thrown value into something loggable, preferring the stack. */
export const errorFields = (error: unknown): LogFields =>
  error instanceof Error
    ? { error: error.message, stack: error.stack ?? "", kind: error.name }
    : { error: String(error) };
