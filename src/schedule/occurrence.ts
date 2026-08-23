/**
 * When a schedule fires. See DESIGN.md §22.
 *
 * Pure occurrence maths with the clock injected, exactly like `digest/day.ts`: `now` is
 * always a parameter and nothing here does IO. That is what makes a DST boundary a test
 * rather than a thing to wait a year for — and this subsystem has two of them, because a
 * schedule can name an hour the clocks skip over as well as one they repeat.
 *
 * A schedule's time is a LOCAL time in a NAMED zone. "Every weekday at 09:00" is a
 * statement about the operator's wall clock; stored as `+02:00` it is an hour wrong for
 * seven months a year and says nothing about it (§19), so a fixed offset is refused where
 * the zone is validated (`isTimeZone`).
 *
 * The cron dialect is deliberately the small one: five fields, `*`, lists, ranges and
 * steps, with three-letter month and day names. No `@daily`, no seconds field, no `L`,
 * no `#`, no `?`. Every one of those is a thing an operator would have to learn is
 * supported here and not elsewhere, and none of them expresses work this fleet does.
 */
import { instantOfWallClock, wallClockIn, type WallClock } from "../digest/day.ts";

/** A trigger: a cron expression read in a named IANA zone. */
export interface ScheduleTrigger {
  readonly cron: string;
  /** IANA zone name — `Europe/Berlin`, never `+02:00`. */
  readonly timeZone: string;
}

/**
 * How far back a runner that has been away will reach: one occurrence.
 *
 * `digest/day.ts`'s `CATCH_UP_DAYS` for the same reason, stated for a schedule. Keel rolls
 * this pod on every push to main, so rolling THROUGH an occurrence is routine and the
 * occurrence is still worth firing a few minutes late. Being away for a week is not
 * routine, and waking up to fire seven dependency audits at once — seven sessions, seven
 * branches, seven pull requests — turns an outage into a mess someone has to clean up.
 */
export const CATCH_UP_OCCURRENCES = 1;

/**
 * How stale an occurrence may be and still fire, in milliseconds.
 *
 * Bounded in TIME as well as in count, because count alone is not a bound: "the previous
 * occurrence" of an hourly schedule is an hour old and worth running, while the previous
 * occurrence of a yearly one may be eleven months old and is not work anybody is waiting
 * for. Six hours is chosen to cover a rolled pod, a node drain and a night of cluster
 * maintenance without covering a holiday.
 */
export const MAX_LATENESS_MS = 6 * 60 * 60 * 1000;

/** A parsed cron expression: the set of wall-clock values each field admits. */
export interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /**
   * Whether BOTH day fields are restricted, which is the one place cron is not a plain
   * conjunction: `0 9 1 * 1` means the first of the month OR every Monday. Recorded at
   * parse time because the answer is a property of the expression, not of a candidate day.
   */
  readonly dayUnion: boolean;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES },
  // 0 and 7 are both Sunday, which every cron implementation accepts and operators type
  // interchangeably. Normalised to 0 below, so the two spellings select the same day.
  { min: 0, max: 7, names: DAY_NAMES },
];

/** One field's admitted values, or undefined when the term is not one this understands. */
const parseField = (raw: string, spec: FieldSpec): Set<number> | undefined => {
  const out = new Set<number>();

  for (const term of raw.split(",")) {
    if (term.length === 0) return undefined;

    const [range, stepText, ...extra] = term.split("/");
    if (range === undefined || extra.length > 0) return undefined;

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return undefined;
      step = Number.parseInt(stepText, 10);
      if (step < 1) return undefined;
    }

    let from: number;
    let to: number;
    if (range === "*") {
      from = spec.min;
      to = spec.max;
    } else {
      const [lowText, highText, ...rest] = range.split("-");
      if (lowText === undefined || rest.length > 0) return undefined;

      const low = named(lowText, spec);
      if (low === undefined) return undefined;
      from = low;

      if (highText === undefined) {
        // A bare value with a step means "from here to the end of the field", which is
        // what `*/15` is a special case of. `5/10` is unusual and unambiguous.
        to = stepText === undefined ? low : spec.max;
      } else {
        const high = named(highText, spec);
        if (high === undefined) return undefined;
        to = high;
      }
    }

    // Refused rather than wrapped. `5-2` is a typo, and cron implementations disagree
    // about whether it means "5 to 2 next cycle" or nothing at all — either reading is a
    // guess about what the operator meant.
    if (from > to) return undefined;

    for (let value = from; value <= to; value += step) out.add(value);
  }

  return out.size === 0 ? undefined : out;
};

/** A number, or a three-letter name where the field has them. Case-insensitive. */
const named = (text: string, spec: FieldSpec): number | undefined => {
  if (/^\d+$/.test(text)) {
    const value = Number.parseInt(text, 10);
    return value >= spec.min && value <= spec.max ? value : undefined;
  }

  const index = spec.names?.indexOf(text.toLowerCase()) ?? -1;
  if (index === -1) return undefined;
  // Names are 0-based in both lists; months start at 1, days at 0.
  return spec.names === MONTH_NAMES ? index + 1 : index;
};

/**
 * `minute hour day-of-month month day-of-week` → the values it admits, or undefined.
 *
 * Undefined rather than a throw: the caller is a parser reading a file an operator wrote,
 * and it has a better message to give than a stack trace. Every refusal here happens when
 * the schedule is COMMITTED, not at the moment it would have fired (§22).
 */
export const parseCron = (expression: string): CronFields | undefined => {
  const parts = expression.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length !== FIELDS.length) return undefined;

  const parsed: Set<number>[] = [];
  for (const [index, spec] of FIELDS.entries()) {
    const field = parseField(parts[index] as string, spec);
    if (field === undefined) return undefined;
    parsed.push(field);
  }

  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = parsed as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];

  const daysOfWeek = new Set([...rawDaysOfWeek].map((day) => day % 7));

  const fields: CronFields = {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayUnion:
      (parts[2] as string) !== "*" &&
      (parts[4] as string) !== "*" &&
      daysOfMonth.size < 31 &&
      daysOfWeek.size < 7,
  };

  // An expression that matches no day of any year — `0 9 31 2 *` is the classic — is
  // refused here rather than left to never fire. A schedule that silently never runs is
  // indistinguishable from a fleet that is not scheduling at all, and the only moment
  // anybody is watching is when the file is committed.
  return firesEver(fields) ? fields : undefined;
};

/**
 * Whether any calendar day satisfies both day fields and the month field.
 *
 * Bounded at four years, which covers a leap year in every position: an expression that
 * matches nothing in four years matches nothing, and 29 February is the only date whose
 * existence depends on the year.
 */
const firesEver = (fields: CronFields): boolean => {
  const start = 2024; // A leap year, so all four February lengths are covered.
  for (let year = start; year < start + 4; year += 1) {
    for (const month of fields.months) {
      const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= length; day += 1) {
        if (dayMatches(fields, year, month, day)) return true;
      }
    }
  }
  return false;
};

/**
 * Whether the day fields admit this date.
 *
 * The union is cron's one genuine oddity and it is load-bearing: with both day fields
 * restricted, `0 9 1 * 1` means "the first of the month OR every Monday". Read as a
 * conjunction it fires roughly a tenth as often as its author expects, which is the kind
 * of wrong nobody notices for a month.
 */
const dayMatches = (fields: CronFields, year: number, month: number, day: number): boolean => {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const byMonth = fields.daysOfMonth.has(day);
  const byWeek = fields.daysOfWeek.has(weekday);
  return fields.dayUnion ? byMonth || byWeek : byMonth && byWeek;
};

/**
 * How far forward `nextOccurrence` will search before giving up, in days.
 *
 * A parsed expression is known to fire within four years (`firesEver`), so this cannot be
 * reached by a valid schedule — it exists so a bug in a field set cannot spin a loop
 * inside the housekeeping pass.
 */
const SEARCH_DAYS = 366 * 4;

/**
 * The first occurrence strictly after `now`, or undefined if the expression cannot fire.
 *
 * STRICTLY after, which is the difference between a schedule and a stuck loop: called with
 * an occurrence as `now` it must answer the following one, or a runner polling every thirty
 * seconds would fire the same occurrence until the minute elapsed.
 *
 * Searched over WALL-CLOCK minutes and converted to an instant per candidate, rather than
 * stepped in UTC. The zone is the authority on what the clocks read, so the search must
 * ask it — an autumn hour that happens twice yields the same wall-clock minute twice and
 * therefore the same instant, and a spring hour that never happens is resolved by
 * `instantOfWallClock` to the moment the clocks reach.
 */
export const nextOccurrence = (now: Date, trigger: ScheduleTrigger): Date | undefined => {
  const fields = parseCron(trigger.cron);
  if (fields === undefined) return undefined;
  return nextFrom(now, fields, trigger.timeZone);
};

const nextFrom = (now: Date, fields: CronFields, timeZone: string): Date | undefined => {
  const from = wallClockIn(now, timeZone);

  // Start at the minute after `now`: the current minute may itself be the occurrence, and
  // an occurrence exactly at `now` has already fired as far as this function is concerned.
  let candidate: WallClock = { ...from, second: 0 };
  let minutes = 1;

  for (let step = 0; step < SEARCH_DAYS * 24 * 60; step += 1) {
    const at = addMinutes(candidate, minutes);
    minutes = 1;

    if (!fields.months.has(at.month) || !dayMatches(fields, at.year, at.month, at.day)) {
      // Skip the rest of the day in one go rather than a minute at a time: a schedule of
      // "the first of February" would otherwise take a third of a million iterations.
      candidate = { ...at, hour: 0, minute: 0 };
      minutes = 24 * 60;
      continue;
    }
    if (!fields.hours.has(at.hour)) {
      candidate = { ...at, minute: 0 };
      minutes = 60;
      continue;
    }
    if (!fields.minutes.has(at.minute)) {
      candidate = at;
      continue;
    }

    const instant = instantOfWallClock(at, timeZone);
    // A wall-clock minute a spring-forward deleted resolves to the instant the clocks
    // reach, which may be BEFORE the minute we asked for is due — 02:30 on a spring
    // morning resolves to 03:00, and asking again from 02:31 would resolve to 03:00 again.
    // Accepting only an instant strictly after `now` keeps that one occurrence, once.
    if (instant.getTime() > now.getTime()) return instant;
    candidate = at;
  }

  return undefined;
};

/** Wall-clock arithmetic, which is plain calendar arithmetic: no zone, no DST. */
const addMinutes = (wall: WallClock, minutes: number): WallClock => {
  const shifted = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute + minutes),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: 0,
  };
};

/**
 * Occurrences that are due at `now`, oldest first — at most `CATCH_UP_OCCURRENCES`.
 *
 * Found by searching FORWARD from a point before the window rather than backward from
 * `now`, because forward is the only direction `nextOccurrence` knows and a second search
 * in the other direction would be a second thing to be wrong about.
 *
 * An occurrence older than `MAX_LATENESS_MS` is not returned at all. It is not recorded as
 * skipped either: nothing claimed it, and a runner that was switched off for a fortnight
 * would otherwise write a ledger entry for every occurrence it slept through.
 */
export const dueOccurrences = (now: Date, trigger: ScheduleTrigger): readonly Date[] => {
  const fields = parseCron(trigger.cron);
  if (fields === undefined) return [];

  const earliest = now.getTime() - MAX_LATENESS_MS;
  const found: Date[] = [];

  let cursor = new Date(earliest - 60_000);
  for (;;) {
    const at = nextFrom(cursor, fields, trigger.timeZone);
    if (at === undefined || at.getTime() > now.getTime()) break;
    found.push(at);
    cursor = at;
  }

  return found.slice(-CATCH_UP_OCCURRENCES);
};

/**
 * The name of one occurrence: `YYYY-MM-DDTHHMMZ`.
 *
 * It becomes a git ref component (`refs/schedules/<id>/<occurrence>`), so it carries no
 * colon and no plus sign, and it is stated in UTC rather than in the schedule's own zone.
 * UTC is what makes two runners agree without talking: the same instant has one name
 * whatever either of them believes the local zone to be, and an operator who edits the
 * zone does not make an occurrence that already fired look unfired.
 */
export const occurrenceId = (at: Date): string =>
  `${at.toISOString().slice(0, 10)}T${at.toISOString().slice(11, 13)}${at.toISOString().slice(14, 16)}Z`;

/** True when a string is an occurrence id this produced. Guards a ref and a file name. */
export const isOccurrenceId = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{4}Z$/.test(value);
