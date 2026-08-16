/**
 * The last N log lines, in memory. See DESIGN.md §18.
 *
 * Loki keeps the history and always will; this exists because the read-only web view has
 * to answer "what is this runner doing RIGHT NOW" without a Grafana round trip, and
 * because a machine runner outside the cluster has no Loki at all.
 *
 * It is wired as `JsonLogger`'s `write` sink rather than as a second Logger implementation,
 * and that is the whole trick: the sink runs only for records that already survived the
 * configured level, so the ring and the container's stdout cannot disagree about what was
 * emitted. A decorator would have had to re-implement the threshold, and the two copies
 * would have drifted the first time either changed.
 *
 * Lines are stored raw and parsed on read. Pushing is on the logging hot path and happens
 * for every record; reading happens when a human opens a page.
 *
 * It holds exactly what stdout holds, so it carries no credential that stdout does not —
 * the §11 rule ("never log a credential") is what keeps both clean, and there is no second
 * discipline to remember here.
 */
import type { LogLevel, LogValue } from "./log.ts";

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly event: string;
  /** Everything the call site passed, minus the three reserved keys above. */
  readonly fields: Readonly<Record<string, LogValue>>;
}

const LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

const isLevel = (value: unknown): value is LogLevel =>
  typeof value === "string" && LEVELS.includes(value);

export class LogRing {
  private readonly capacity: number;
  private readonly lines: string[] = [];
  /** Index of the oldest entry once the buffer has wrapped. */
  private next = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(0, capacity);
  }

  push(line: string): void {
    if (this.capacity === 0) return;

    if (this.lines.length < this.capacity) {
      this.lines.push(line);
      return;
    }
    this.lines[this.next] = line;
    this.next = (this.next + 1) % this.capacity;
  }

  /** Newest first — the order an operator reads a log in. */
  records(): readonly LogRecord[] {
    const ordered =
      this.lines.length < this.capacity
        ? this.lines
        : [...this.lines.slice(this.next), ...this.lines.slice(0, this.next)];

    return ordered.map(parse).reverse();
  }
}

/**
 * One stored line back into a record.
 *
 * A line that is not a log record is reported as one rather than dropped: something
 * writing past the logger — a dependency's warning, a runtime notice — is precisely the
 * kind of thing this view exists to make visible.
 */
const parse = (line: string): LogRecord => {
  const unparsed = (): LogRecord => ({
    ts: "",
    level: "info",
    event: "log.unparsed",
    fields: { line: line.trimEnd() },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return unparsed();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unparsed();

  const record = parsed as Record<string, unknown>;
  const { ts, level, event, ...rest } = record;
  if (typeof event !== "string" || !isLevel(level)) return unparsed();

  const fields: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields[key] = value;
    }
  }

  return { ts: typeof ts === "string" ? ts : "", level, event, fields };
};
