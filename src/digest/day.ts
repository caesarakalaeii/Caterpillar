/**
 * The digest's calendar. See DESIGN.md §19.
 *
 * A day is a LOCAL day. "What did the fleet do today" is a question about the operator's
 * day, and in Berlin the last two hours of every summer day belong to tomorrow in UTC —
 * so a digest keyed on the UTC date reports two hours of work under the wrong heading for
 * half the year, and does it silently.
 *
 * A window RUNS BETWEEN PUBLICATIONS rather than from local midnight: the digest for the
 * 16th covers 18:00 on the 15th to 18:00 on the 16th. Midnight-to-publication is the
 * obvious alternative and it loses an evening a day — work done after 18:00 falls into a
 * window that has already been published and is never reported by anything. Consecutive
 * windows meet exactly, so every hour is reported once.
 *
 * Nothing here does I/O, and nothing here reads the clock: `now` is always a parameter,
 * which is what makes a DST boundary a test rather than a thing to wait a year for.
 */

/** Where and when a runner considers a day to have ended. */
export interface DayBoundary {
  /** Local hour of the publication cutoff, 0–23. */
  readonly hour: number;
  /** IANA zone name — `Europe/Berlin`, not `+02:00`, so DST is handled by the zone. */
  readonly timeZone: string;
}

export interface DigestWindow {
  /** `YYYY-MM-DD` of the local day the window ENDS on. Names the digest and its file. */
  readonly date: string;
  /** Inclusive start instant — the previous day's cutoff. */
  readonly start: Date;
  /** Exclusive end instant — this day's cutoff. */
  readonly end: Date;
  /** When this digest becomes publishable. The same instant as `end`. */
  readonly dueAt: Date;
}

/**
 * How far back a runner that has been off will reach.
 *
 * One day, deliberately. A runner returning after a week must not post seven digests into
 * the channel at once — the point of catching up is that a pod rolled through 18:00, which
 * Keel does on every push to main, not that a fortnight of history should arrive in a
 * burst. Days older than this are readable in the state repo and are not re-announced.
 */
export const CATCH_UP_DAYS = 1;

/**
 * True when `zone` is a NAMED zone `Intl` recognises. Used at config load, so a typo fails
 * at boot rather than at 18:00 inside the poll loop.
 *
 * A fixed offset — `+02:00`, which `Intl` accepts — is refused. It is right for five
 * months of the year and an hour wrong for the other seven, and the wrongness is silent:
 * the digest simply arrives at 17:00 or 19:00 and covers a window shifted by an hour. The
 * whole reason for taking a zone rather than an offset is that DST is the zone database's
 * problem, so accepting an offset would defeat the parameter.
 */
export const isTimeZone = (zone: string): boolean => {
  if (zone === "") return false;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions()
      .timeZone;
    return !/^[+-]/.test(resolved);
  } catch {
    return false;
  }
};

/**
 * Wall-clock parts of `instant` in `timeZone`.
 *
 * `formatToParts` rather than a formatted string: a locale's date order is not a contract,
 * and assembling the parts by name is the only reading that cannot be broken by an ICU
 * update. `hourCycle: "h23"` because `en-US` renders midnight as `24` in `h24`, which
 * parses to a day that does not exist.
 */
const partsIn = (
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const found = new Map<string, string>(
    formatter.formatToParts(instant).map((part) => [String(part.type), part.value]),
  );
  const value = (type: string): number => Number.parseInt(found.get(type) ?? "0", 10);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
};

/** The zone's offset from UTC at `instant`, in milliseconds. */
const offsetAt = (instant: Date, timeZone: string): number => {
  const parts = partsIn(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Whole seconds on both sides: `formatToParts` has no milliseconds field, so the
  // instant's own must be removed before the subtraction or every offset is off by them.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
};

/** The local calendar date at `instant`, as `YYYY-MM-DD`. */
export const localDate = (instant: Date, timeZone: string): string => {
  const { year, month, day } = partsIn(instant, timeZone);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
};

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instant of a local wall-clock time.
 *
 * Two passes, because the offset depends on the answer: the first pass reads the offset at
 * roughly the right instant, the second at the instant that produced. They differ only
 * within an hour of a DST change, and one refinement is enough to land on the correct side
 * of it. A wall-clock time that a spring-forward deletes has no instant at all; it
 * resolves to the moment the clocks reach, which is the only answer that exists.
 */
const instantOf = (date: string, hour: number, timeZone: string): Date => {
  const match = DATE.exec(date);
  if (match === null) throw new Error(`'${date}' is not a YYYY-MM-DD date`);

  const [year, month, day] = [
    Number.parseInt(match[1] as string, 10),
    Number.parseInt(match[2] as string, 10),
    Number.parseInt(match[3] as string, 10),
  ];

  const naive = Date.UTC(year, month - 1, day, hour);
  const first = naive - offsetAt(new Date(naive), timeZone);
  return new Date(naive - offsetAt(new Date(first), timeZone));
};

/** The local date `days` before `date`, as `YYYY-MM-DD`. */
const minusDays = (date: string, days: number): string => {
  const match = DATE.exec(date);
  if (match === null) throw new Error(`'${date}' is not a YYYY-MM-DD date`);

  // Plain UTC arithmetic on the calendar date. This never touches a zone, so a DST day
  // cannot shorten it: 29 March minus one day is 28 March in every zone there is.
  const shifted = new Date(
    Date.UTC(
      Number.parseInt(match[1] as string, 10),
      Number.parseInt(match[2] as string, 10) - 1,
      Number.parseInt(match[3] as string, 10) - days,
    ),
  );
  return shifted.toISOString().slice(0, 10);
};

/** The window the digest named `date` covers. */
export const windowFor = (date: string, boundary: DayBoundary): DigestWindow => {
  const end = instantOf(date, boundary.hour, boundary.timeZone);
  return {
    date,
    start: instantOf(minusDays(date, 1), boundary.hour, boundary.timeZone),
    end,
    dueAt: end,
  };
};

/**
 * The window immediately before `window` — the baseline a trend is measured against.
 *
 * Recomputed from the calendar date rather than by subtracting the window's own length.
 * Consecutive windows meet exactly but are not equal in length: 18:00 to 18:00 across a
 * spring-forward is 23 hours, and a baseline built by subtraction would silently compare a
 * 23-hour day against a 24-hour one on exactly the day the clocks moved.
 */
export const previousWindow = (window: DigestWindow, boundary: DayBoundary): DigestWindow =>
  windowFor(minusDays(window.date, 1), boundary);

/**
 * Every window that is publishable at `now`, oldest first.
 *
 * Oldest first matters: a runner that missed yesterday's cutoff owes two digests, and
 * posting today's before yesterday's leaves the channel reading backwards.
 */
export const dueWindows = (now: Date, boundary: DayBoundary): readonly DigestWindow[] => {
  const today = localDate(now, boundary.timeZone);

  const candidates: DigestWindow[] = [];
  for (let back = CATCH_UP_DAYS; back >= 0; back -= 1) {
    candidates.push(windowFor(minusDays(today, back), boundary));
  }

  return candidates.filter((window) => window.dueAt.getTime() <= now.getTime());
};
