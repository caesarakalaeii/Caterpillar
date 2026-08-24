/**
 * Every page the web view serves. See DESIGN.md §18.
 *
 * Server-rendered, and the browser is handed no state to re-derive: the server already
 * knows how to draw each of these, so the refresh in `assets.ts` re-fetches the page and
 * swaps `<main>` rather than shipping a second renderer that has to be kept in step.
 *
 * Nothing here reads a file or a ref — the caller hands in a finished view model. That is
 * what keeps "the UI cannot write" checkable by reading one file (`view.ts`) rather than
 * by auditing every template.
 */
import type { LogRecord } from "../obs/ring.ts";
import { html, join, raw, safeUrl, type Html } from "./html.ts";
import type { TranscriptEntry } from "./transcript.ts";
import type {
  DigestView,
  DiskEntry,
  DiskView,
  FleetView,
  IntakeView,
  RunnerExport,
  TaskDetail,
  TaskOrigin,
  TaskRow,
} from "./view.ts";

export type Page = "fleet" | "intake" | "digests" | "logs" | "runner";

export interface Chrome {
  readonly runnerId: string;
  readonly capabilities: readonly string[];
  readonly current: Page;
  /** Seconds between automatic refreshes. Absent means the page is static. */
  readonly refresh?: number;
  readonly title: string;
  /** The task this runner is executing right now, for the rail. */
  readonly liveTask?: string;
}

export const layout = (chrome: Chrome, body: Html): string => {
  const document = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${chrome.title} · caterpillar</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="data:,">
</head>
<body${chrome.refresh === undefined ? raw("") : html` data-refresh="${chrome.refresh}"`}>
<div class="shell">
  <aside class="rail">
    <div class="brand">
      <span class="mark">caterpillar</span>
      <span class="rail-label">supervisor · read only</span>
      <span class="segments"><i></i><i></i><i></i><i></i></span>
    </div>
    <nav>
      <a href="/"${chrome.current === "fleet" ? raw(' aria-current="page"') : raw("")}>fleet</a>
      <a href="/intake"${chrome.current === "intake" ? raw(' aria-current="page"') : raw("")}>intake</a>
      <a href="/digests"${chrome.current === "digests" ? raw(' aria-current="page"') : raw("")}>digests</a>
      <a href="/logs"${chrome.current === "logs" ? raw(' aria-current="page"') : raw("")}>logs</a>
      <a href="/runner"${chrome.current === "runner" ? raw(' aria-current="page"') : raw("")}>runner</a>
    </nav>
    <div class="rail-block">
      <span class="rail-label">this runner</span>
      <span class="rail-value">${chrome.runnerId}</span>
    </div>
    <div class="rail-block">
      <span class="rail-label">capabilities</span>
      <div class="chips">${chrome.capabilities.map((capability) => html`<span class="chip on">${capability}</span>`)}</div>
    </div>
    ${
      chrome.liveTask === undefined
        ? html`<div class="rail-block"><span class="rail-label">now</span><span class="rail-value">idle</span></div>`
        : html`<div class="rail-block">
            <span class="rail-label">now running</span>
            <span class="status" data-status="running"><a href="/tasks/${chrome.liveTask}">${chrome.liveTask}</a></span>
          </div>`
    }
  </aside>
  ${body}
</div>
<script src="/assets/app.js"></script>
</body>
</html>`;
  return document.__html;
};

/* -------------------------------------------------------------------- fleet */

export const fleetPage = (view: FleetView): Html => html`<main>
  <div class="page-head">
    <div class="eyebrow">state repo · authoritative</div>
    <h1>The fleet</h1>
    <p class="sub">Every task the state repo knows about, and which runner is holding it.</p>
  </div>

  ${view.live.map(
    (live) => html`<div class="banner">
      <span class="status" data-status="running"><span>session ${live.session}</span></span>
      <span>
        <a href="/tasks/${live.task}">${live.task}</a> is running on ${live.runner}
        (${live.model}) · ${live.messages} messages · started
        <time datetime="${live.startedAt}">${live.startedAt}</time>
      </span>
    </div>`,
  )}

  <section>
    ${intakeLine(view)}
  </section>

  <section>
    <div class="counts">
      ${(["running", "ready", "awaiting-human", "parked", "done", "failed"] as const).map(
        (status) => html`<div class="count" data-status="${status}">
          <b>${view.counts[status] ?? 0}</b><span>${status}</span>
        </div>`,
      )}
    </div>
  </section>

  <section>
    <h2>Runners</h2>
    <table class="ledger">
      <thead><tr><th>runner</th><th>holding</th><th>since</th></tr></thead>
      <tbody>
        ${view.runners.map(
          (runner) => html`<tr data-status="${runner.tasks.length > 0 ? "running" : "ready"}">
            <td>${runner.id}${runner.self ? html` <span class="chip on">this one</span>` : raw("")}</td>
            <td>
              ${
                runner.tasks.length === 0
                  ? html`<span class="id">nothing</span>`
                  : join(
                      runner.tasks.map((task) => html`<a href="/tasks/${task}">${task}</a>`),
                      raw(", "),
                    )
              }
            </td>
            <td>${runner.since === undefined ? raw("—") : timeTag(runner.since)}</td>
          </tr>`,
        )}
      </tbody>
    </table>
    <p class="crumb">
      A runner appears here when it holds a lease. One that is idle and is not this one owns
      nothing, so nothing names it.
    </p>
  </section>

  <section>
    <h2>Tasks</h2>
    ${
      view.tasks.length === 0
        ? html`<p class="empty">No tasks yet. Label a tracker item <code>agent</code>, or commit a spec.</p>`
        : html`<table class="ledger">
            <thead>
              <tr>
                <th>task</th><th>from</th><th>status</th><th>phase</th><th>sessions</th>
                <th class="num">cost</th><th>runner</th><th class="num">updated</th>
              </tr>
            </thead>
            <tbody>${view.tasks.map(taskRow)}</tbody>
          </table>`
    }
  </section>
</main>`;

const taskRow = (task: TaskRow): Html => html`<tr data-status="${task.status}">
  <td class="title">
    <a href="/tasks/${task.id}">${task.title}</a>
    <div class="id">${task.id}${task.wave === undefined ? raw("") : html` · wave ${task.wave}`}</div>
  </td>
  <td>${originCell(task.origin)}</td>
  <td>${statusCell(task.status)}</td>
  <td><span class="id">${task.phase}</span></td>
  <td>${instar(task.sessions, task.maxSessions)}</td>
  <td class="num">$${task.usage.costUsd.toFixed(2)}</td>
  <td>
    ${
      task.owner === undefined
        ? html`<span class="id">—</span>`
        : task.held
          ? html`${task.owner.runner}`
          : html`<span class="id" title="not holding it now — this is who ran it last"
              >${task.owner.runner}</span
            >`
    }
  </td>
  <td class="num">${timeTag(task.updatedAt)}</td>
</tr>`;

const statusCell = (status: string): Html =>
  html`<span class="status" data-status="${status}"><span>${status}</span></span>`;

/**
 * One line saying when intake last ran here and what it found (§14, §18).
 *
 * On the page an operator opens FIRST, because the question this answers — "I labelled an
 * issue and nothing happened" — is asked while looking at an empty fleet, and until this
 * existed the only evidence intake was alive at all was a line in one pod's stdout.
 *
 * Three distinct sentences rather than one with blanks in it, because the three states are
 * different facts: this runner ingested, another replica did (three of four, every
 * interval, by design — see `intakeRef`), or the pass threw and the counts would be a lie.
 */
const intakeLine = (view: FleetView): Html => {
  const pass = view.intake;
  if (pass === undefined) {
    return html`<p class="crumb">
      intake · no pass on this runner yet · <a href="/intake">what intake has refused</a>
    </p>`;
  }

  if (pass.outcome === "claimed-elsewhere") {
    return html`<p class="crumb">
      intake · ${timeTag(pass.at)} · another runner served this interval
      (<span class="id">${pass.ref}</span>) · <a href="/intake">what intake has refused</a>
    </p>`;
  }

  if (pass.outcome === "failed") {
    return html`<p class="crumb" data-status="failed">
      intake · ${timeTag(pass.at)} · failed: ${pass.error ?? "no detail"} ·
      <a href="/intake">what intake has refused</a>
    </p>`;
  }

  return html`<p class="crumb">
    intake · ${timeTag(pass.at)} · ${pass.seen ?? 0} seen · ${pass.created ?? 0} created ·
    ${pass.rejected ?? 0} refused${pass.failed === undefined || pass.failed === 0
      ? raw("")
      : html` · ${pass.failed} tracker(s) unreachable`} · by ${pass.runner} ·
    <a href="/intake">what intake has refused</a>
  </p>`;
};

/**
 * Where a task came from, as one cell.
 *
 * A CHIP rather than prose: the fleet table is scanned, and the fact worth scanning for is
 * that a row is a `remediation` task nobody asked for by hand. `safeUrl` gates the link
 * because the URL was recovered from a goal, which is agent-adjacent text (§18).
 */
const originCell = (origin: TaskOrigin | undefined): Html => {
  if (origin === undefined) return html`<span class="id">—</span>`;
  const url = safeUrl(origin.url);
  const label = html`<span class="chip" data-origin="${origin.kind}">${origin.kind}</span>`;

  return url === undefined
    ? html`<span title="${origin.label}">${label}</span>`
    : html`<a href="${url}" rel="noreferrer noopener" title="${origin.label}">${label}</a>`;
};

/**
 * Sessions spent against the limit, as segments.
 *
 * Capped at a readable number of marks: the limit is configurable and a task with a
 * hundred allowed sessions would otherwise draw a hundred bars across the row.
 */
const instar = (spent: number, limit: number): Html => {
  const marks = Math.min(Math.max(limit, 1), 20);
  const filled = Math.min(Math.round((spent / Math.max(limit, 1)) * marks), marks);
  const over = spent > limit;

  return html`<span class="instar" title="${spent} of ${limit} sessions"
    >${Array.from({ length: marks }, (_, index) =>
      index < filled ? html`<i class="spent${over ? " over" : ""}"></i>` : html`<i></i>`,
    )}<span class="id count">${spent}/${limit}</span></span
  >`;
};

const timeTag = (iso: string): Html => html`<time datetime="${iso}">${iso}</time>`;

/**
 * The source of one task, spelled out.
 *
 * `spec.tracker` has been on every ingested task since intake shipped and no page rendered
 * it: the goal's prose said "Tracker item: …" and that was the whole of it. For an alert
 * task the alertname comes from `alerts/refusals/`, because `ALERT-<fingerprint>` is a hash
 * and does not carry one.
 */
const originDetail = (origin: TaskOrigin | undefined): Html => {
  if (origin === undefined) return raw("—");
  const url = safeUrl(origin.url);

  return html`<span class="chip" data-origin="${origin.kind}">${origin.kind}</span>
    ${url === undefined
      ? html`<span class="id">${origin.label}</span>`
      : html`<a href="${url}" rel="noreferrer noopener">${origin.label}</a>`}`;
};

/* ------------------------------------------------------------------- intake */

/**
 * The intake paths that refuse things, on one page (DESIGN.md §14, §20, §22).
 *
 * The page exists because a REFUSAL was invisible: a warn line in one pod's stdout, a JSON
 * file in the state repo, and a comment on a tracker item nobody is watching. A fleet whose
 * only labelled issue was refused looked exactly like a fleet nobody had given work to, and
 * that is how the issue behind this page was reported — "I have never seen an agent pick up
 * an issue".
 *
 * Every string on it is untrusted in the §18 sense and then some: a refusal reason quotes a
 * tracker item written by anyone with an account, and an alert annotation is whatever a
 * Prometheus rule's template produced. `html.ts` escapes all of it; nothing here calls
 * `raw` on anything but a literal.
 */
export const intakePage = (view: IntakeView): Html => html`<main>
  <div class="page-head">
    <div class="eyebrow">state repo · intake/, alerts/ and schedules/</div>
    <h1>Intake</h1>
    <p class="sub">
      What the tracker, the alert receiver and the clock have been asked to turn into tasks,
      and what they refused. A refusal is durable: it is a file in the state repo and, where
      there is somebody to tell, a comment on the item — which is what stops the same item
      being commented on every poll.
    </p>
  </div>

  <section>
    <h2>Last pass on this runner</h2>
    ${passPanel(view)}
    <p class="crumb">
      Held in memory, not in git. One runner serves each interval — the others contend for
      the same ref and skip — so a runner reporting nothing here is the normal case on a
      fleet, not a broken one.
    </p>
  </section>

  <section>
    <h2>Refused tracker items</h2>
    ${
      view.rejections.length === 0
        ? html`<p class="empty">
            Nothing refused. An item is recorded here when it is labelled for the agent and
            cannot be turned into a task — usually a missing <code>agent</code> block.
          </p>`
        : html`<table class="ledger">
            <thead><tr><th>item</th><th>workspace</th><th>reason</th><th class="num">at</th></tr></thead>
            <tbody>${view.rejections.map(rejectionRow)}</tbody>
          </table>`
    }
  </section>

  <section>
    <h2>Alert ledger</h2>
    ${
      view.alerts.length === 0
        ? html`<p class="empty">
            No alert has reached this fleet. Every decision about one is recorded — including
            the ones that became tasks — so an empty ledger means nothing was delivered.
          </p>`
        : html`<table class="ledger">
            <thead><tr><th>alertname</th><th>outcome</th><th>task</th><th class="num">at</th></tr></thead>
            <tbody>${view.alerts.map(alertRow)}</tbody>
          </table>`
    }
    <p class="crumb">
      Filed under <code>alerts/refusals/&lt;fingerprint&gt;.json</code>, which is a record of
      every decision rather than only the refusals — the success path writes one too.
    </p>
  </section>

  <section>
    <h2>Which alerts are opted in</h2>
    ${policyPanel(view)}
  </section>

  <section>
    <h2>Scheduled work</h2>
    ${schedulePanel(view)}
    <p class="crumb">
      One file per schedule under <code>schedules/</code> in the state repo, each carrying its
      trigger, its repos, its prompt and its acceptance commands. Adding one is a commit, not
      a redeploy, and a malformed one is refused on the intake pass rather than at the hour it
      would have fired.
    </p>
  </section>

  <section>
    <h2>Occurrences</h2>
    ${
      view.occurrences.length === 0
        ? html`<p class="empty">
            No occurrence has been settled${
              view.scheduling
                ? raw(" yet")
                : html` on this runner — <code>schedule.enabled</code> is false here, so it
                  fires none of them`
            }. Every occurrence is recorded, including the ones a precheck skipped, so an
            empty ledger means nothing has come due.
          </p>`
        : html`<table class="ledger">
            <thead><tr><th>schedule</th><th>occurrence</th><th>outcome</th><th>task</th><th class="num">at</th></tr></thead>
            <tbody>${view.occurrences.map(occurrenceRow)}</tbody>
          </table>`
    }
    <p class="crumb">
      Filed under <code>schedules/occurrences/&lt;schedule&gt;-&lt;occurrence&gt;.json</code>.
      A <strong>skipped</strong> occurrence is one whose precheck exited non-zero: no session
      was spent, which is the whole point of the gate.
    </p>
  </section>

  <section>
    <h2>Is anything listening</h2>
    <dl class="grid">
      <div>
        <dt>alert receiver</dt>
        <dd>${
          view.receiver.enabled
            ? html`<span class="chip on">listening</span> on port ${view.receiver.port}`
            : html`<span class="chip">disabled</span> · <code>remediation.enabled</code> is false`
        }</dd>
      </div>
      <div>
        <dt>cluster reads</dt>
        <dd>${
          view.receiver.clusterEnabled
            ? html`<span class="chip on">enabled</span>`
            : html`<span class="chip">disabled</span>`
        }</dd>
      </div>
      <div>
        <dt>namespaces</dt>
        <dd>${
          view.receiver.namespaces.length === 0
            ? html`<span class="id">none — every cluster read is refused</span>`
            : html`<div class="chips">${view.receiver.namespaces.map(
                (namespace) => html`<span class="chip">${namespace}</span>`,
              )}</div>`
        }</dd>
      </div>
    </dl>
    <p class="crumb">
      A receiver that is not listening is the most likely reason a firing alert produced
      nothing at all. It refuses to start without its webhook token, and that refusal is an
      error line in this runner's log.
    </p>
  </section>
</main>`;

/**
 * The schedules, their parse errors, and whether this runner fires any of them (§22).
 *
 * The errors come FIRST and are a panel rather than a row, for `policyPanel`'s reason: a
 * schedule that will not parse is the likeliest explanation for scheduled work that never
 * happens, and it is the one an operator cannot get at any other way — the intake pass logs
 * it into a stream nobody is reading.
 */
const schedulePanel = (view: IntakeView): Html => html`${
  view.scheduleErrors.length === 0
    ? raw("")
    : html`<div class="panel" data-status="failed">
        <h3>${view.scheduleErrors.length} file(s) under schedules/ are not schedules</h3>
        ${view.scheduleErrors.map(
          (error) => html`<p><span class="id">${error.schedule}</span> — ${error.message}</p>`,
        )}
        <p class="crumb">
          These fire nothing and refuse nothing else: one schedule per file, so a typo costs
          that schedule alone.
        </p>
      </div>`
}
${
  view.schedules.length === 0
    ? html`<p class="empty">
        No schedule in the state repo. A schedule is a file under <code>schedules/</code>
        carrying a cron expression, a named IANA timezone, the repos, the prompt and the
        acceptance commands — which are required, because work that cannot be verified as
        done cannot be scheduled either.
      </p>`
    : html`<table class="ledger">
        <thead>
          <tr><th>schedule</th><th>trigger</th><th>workspace</th><th>precheck</th><th class="num">max open</th></tr>
        </thead>
        <tbody>${view.schedules.map(scheduleRow)}</tbody>
      </table>`
}
${
  view.scheduling
    ? raw("")
    : html`<p class="crumb">
        This runner fires none of them: <code>schedule.enabled</code> is false. Another
        replica may — exactly one runner in the fleet wins each occurrence.
      </p>`
}`;

const scheduleRow = (schedule: IntakeView["schedules"][number]): Html => html`<tr
  data-status="${schedule.enabled ? "running" : "parked"}"
>
  <td class="title">
    ${schedule.id}
    <div class="id">${schedule.enabled ? "enabled" : "disabled"}</div>
  </td>
  <td>
    <span class="id">${schedule.trigger.cron}</span>
    <div class="id">${schedule.trigger.timeZone}</div>
  </td>
  <td><span class="id">${schedule.workspace}</span></td>
  <td>${
    schedule.precheck === undefined
      ? html`<span class="id">none</span>`
      : html`<span class="id">${schedule.precheck.command}</span>`
  }</td>
  <td class="num">${schedule.maxOpenTasks}</td>
</tr>`;

const occurrenceRow = (record: IntakeView["occurrences"][number]): Html => html`<tr
  data-status="${record.outcome === "fired" ? "running" : "parked"}"
>
  <td class="title">${record.schedule}</td>
  <td><span class="id">${record.occurrence}</span></td>
  <td>
    ${record.outcome}
    ${record.detail === undefined ? raw("") : html`<div class="prose">${record.detail}</div>`}
  </td>
  <td>${
    record.task === undefined
      ? html`<span class="id">none</span>`
      : html`<a href="/tasks/${record.task}">${record.task}</a>`
  }</td>
  <td class="num">${record.at === undefined ? raw("—") : timeTag(record.at)}</td>
</tr>`;

const passPanel = (view: IntakeView): Html => {
  const pass = view.pass;
  if (pass === undefined) {
    return html`<p class="empty">
      Intake has not completed a pass on this runner since it started.
    </p>`;
  }

  if (pass.outcome !== "ingested") {
    return html`<div class="panel" data-status="${pass.outcome === "failed" ? "failed" : "ready"}">
      <h3>${pass.outcome === "failed" ? "the last pass failed" : "another runner served this interval"}</h3>
      <p>
        ${timeTag(pass.at)} · <span class="id">${pass.ref}</span>
        ${pass.error === undefined ? raw("") : html` · ${pass.error}`}
      </p>
    </div>`;
  }

  return html`<dl class="grid">
    <div><dt>ran</dt><dd>${timeTag(pass.at)}</dd></div>
    <div><dt>by</dt><dd>${pass.runner}</dd></div>
    <div><dt>seen</dt><dd>${pass.seen ?? 0}</dd></div>
    <div><dt>created</dt><dd>${pass.created ?? 0}</dd></div>
    <div><dt>refused</dt><dd>${pass.rejected ?? 0}</dd></div>
    <div><dt>trackers unreachable</dt><dd>${pass.failed ?? 0}</dd></div>
  </dl>`;
};

const rejectionRow = (record: IntakeView["rejections"][number]): Html => {
  const url = safeUrl(record.url);
  return html`<tr data-status="awaiting-human">
    <td class="title">
      ${
        url === undefined
          ? html`${record.title ?? record.task}`
          : html`<a href="${url}" rel="noreferrer noopener">${record.title ?? record.task}</a>`
      }
      <div class="id">${record.task}</div>
    </td>
    <td><span class="id">${record.workspace ?? "—"}</span></td>
    <td><div class="prose">${record.reason}</div></td>
    <td class="num">${record.at === undefined ? raw("—") : timeTag(record.at)}</td>
  </tr>`;
};

const alertRow = (record: IntakeView["alerts"][number]): Html => html`<tr
  data-status="${record.task === undefined ? "parked" : "running"}"
>
  <td class="title">
    ${record.alertname}
    <div class="id">${record.fingerprint}</div>
  </td>
  <td><div class="prose">${record.reason}</div></td>
  <td>${
    record.task === undefined
      ? html`<span class="id">none</span>`
      : html`<a href="/tasks/${record.task}">${record.task}</a>`
  }</td>
  <td class="num">${record.at === undefined ? raw("—") : timeTag(record.at)}</td>
</tr>`;

/**
 * The opt-in list, or the sentence that explains its absence.
 *
 * A missing `alerts/policy.yaml` is rendered as a statement with the runbook next to it,
 * not as an empty table: "the alert fired and nobody had listed it" is the refusal an
 * operator is least likely to guess, and an empty table reads as "nothing has happened".
 */
const policyPanel = (view: IntakeView): Html => {
  if (view.policyError !== undefined) {
    return html`<div class="panel" data-status="failed">
      <h3>alerts/policy.yaml does not parse</h3>
      <p>${view.policyError}</p>
      <p class="crumb">
        Every alert is refused until this is fixed, and the supervisor logs it once per poll.
      </p>
    </div>`;
  }

  if (view.policyMissing) {
    return html`<p class="empty">
      There is no <code>alerts/policy.yaml</code> in the state repo, so no alert is opted in
      and every delivery is refused with <code>refused-no-policy</code>. Adding one is a
      commit to the state repo, not a redeploy — see <code>docs/remediation-runbook.md</code>.
    </p>`;
  }

  if (view.policy.length === 0) {
    return html`<p class="empty">
      <code>alerts/policy.yaml</code> exists and lists no alerts, so every delivery is
      refused with <code>refused-no-policy</code>.
    </p>`;
  }

  return html`<table class="ledger">
    <thead>
      <tr><th>alertname</th><th>workspace</th><th>repos</th><th class="num">max open</th><th>runbook</th></tr>
    </thead>
    <tbody>
      ${view.policy.map((entry) => {
        const runbook = safeUrl(entry.runbook);
        return html`<tr>
          <td class="title">${entry.alertname}</td>
          <td><span class="id">${entry.workspace}</span></td>
          <td><span class="id">${entry.repos.map((r) => `${r.host}/${r.owner}/${r.name}`).join(", ")}</span></td>
          <td class="num">${entry.maxOpenTasks}</td>
          <td>${
            runbook === undefined
              ? html`<span class="id">—</span>`
              : html`<a href="${runbook}" rel="noreferrer noopener">runbook</a>`
          }</td>
        </tr>`;
      })}
    </tbody>
  </table>`;
};

/* --------------------------------------------------------------------- task */

const acceptanceList = (acceptance: readonly string[]): Html =>
  acceptance.length === 0
    ? html`<p class="empty">none declared</p>`
    : html`<pre class="raw">${acceptance.join("\n")}</pre>`;

/**
 * The gate, as one panel or as two (DESIGN.md §12.3).
 *
 * One panel unless the two lists actually DIFFER. `filedAcceptance` is absent for a task
 * nobody amended, and an amendment can also leave the list unchanged — a re-amendment that
 * restores what an earlier one removed — in which case there is a single list and labelling
 * it twice would say something untrue about it. The amendment record itself is still shown
 * below, because the reason is the whole point of looking.
 */
const acceptancePanels = (
  inForce: readonly string[],
  filed: readonly string[] | undefined,
): Html => {
  const amended =
    filed !== undefined &&
    (filed.length !== inForce.length || filed.some((entry) => !inForce.includes(entry)));

  if (!amended) {
    return html`<div class="panel">
      <h3>acceptance — run by the supervisor, never by the agent</h3>
      ${acceptanceList(inForce)}
    </div>`;
  }

  return html`<div class="panel">
      <h3>acceptance in force — what the supervisor runs</h3>
      ${acceptanceList(inForce)}
    </div>
    <div class="panel">
      <h3>acceptance as filed — what <code>spec.md</code> asked for</h3>
      ${acceptanceList(filed ?? [])}
      <p class="crumb">
        <code>spec.md</code> is immutable, so an amendment overlays it rather than
        rewriting it. This is the record of what the task was originally asked to do.
      </p>
    </div>`;
};

/**
 * Every amendment to the gate, or nothing at all.
 *
 * Nothing for a task with no amendments, which is almost all of them: an empty section on
 * every task page would be noise, and a reader would learn to skip the place the answer
 * appears. Newest first, because the last one is the gate in force — the highest number
 * wins entirely (§12.3) and the earlier ones are history.
 */
const amendmentSection = (amendments: TaskDetail["amendments"]): Html =>
  amendments.length === 0
    ? raw("")
    : html`<section>
        <h2>Amendments to the acceptance criteria</h2>
        <p class="sub">
          The newest one is the gate; they are never merged and never applied in sequence.
          <code>spec.md</code> is untouched by all of them.
        </p>
        ${[...amendments].reverse().map(
          (amendment) => html`<div class="panel">
            <h3>
              amendment ${amendment.index} · ${amendment.author} · ${timeTag(amendment.at)}
            </h3>
            <div class="prose">${amendment.why}</div>
            <h3 class="second">the list it put in force</h3>
            ${acceptanceList(amendment.acceptance)}
          </div>`,
        )}
      </section>`;

export const taskPage = (detail: TaskDetail): Html => {
  const state = detail.state;
  const pr = safeUrl(state.pr?.url);

  return html`<main>
    <div class="page-head">
      <div class="crumb"><a href="/">fleet</a> / ${detail.id}</div>
      <h1>${detail.title}</h1>
      <p class="sub">
        ${statusCell(state.status)} · ${state.phase} · session ${state.sessions} of
        ${state.limits.maxSessions} · updated ${timeTag(state.updatedAt)}
      </p>
    </div>

    ${
      detail.live === undefined
        ? raw("")
        : html`<div class="banner">
            <span class="status" data-status="running"><span>live</span></span>
            <span
              >Session ${detail.live.session} is running on this runner
              (${detail.live.model}), started
              <time datetime="${detail.live.startedAt}">${detail.live.startedAt}</time>.</span
            >
          </div>`
    }

    <section>
      <h2>Control record</h2>
      <dl class="grid">
        <div><dt>status</dt><dd>${statusCell(state.status)}</dd></div>
        <div><dt>phase</dt><dd>${state.phase}</dd></div>
        <div><dt>sessions</dt><dd>${instar(state.sessions, state.limits.maxSessions)}</dd></div>
        <div><dt>no-progress streak</dt><dd>${state.progress.noProgressStreak}</dd></div>
        <div><dt>input tokens</dt><dd>${state.usage.inputTokens.toLocaleString("en-US")}</dd></div>
        <div><dt>output tokens</dt><dd>${state.usage.outputTokens.toLocaleString("en-US")}</dd></div>
        <div><dt>cost</dt><dd>$${state.usage.costUsd.toFixed(2)}</dd></div>
        <div><dt>requires</dt><dd><div class="chips">${state.requires.map((c) => html`<span class="chip">${c}</span>`)}</div></dd></div>
        <div>
          <dt>${state.status === "running" ? "held by" : "last run by"}</dt>
          <dd>${state.owner === undefined ? raw("—") : html`${state.owner.runner} since ${timeTag(state.owner.since)}`}</dd>
        </div>
        <div>
          <dt>pull request</dt>
          <dd>${pr === undefined ? raw("—") : html`<a href="${pr}" rel="noreferrer noopener">#${state.pr?.number}</a>`}</dd>
        </div>
        <div>
          <dt>came from</dt>
          <dd>${originDetail(detail.origin)}</dd>
        </div>
        ${
          state.review === undefined
            ? raw("")
            : html`<div><dt>council</dt><dd>${state.review.last ?? "—"} · ${state.review.rounds} round(s)</dd></div>`
        }
        ${
          state.plan === undefined
            ? raw("")
            : html`<div>
                <dt>plan</dt>
                <dd>
                  wave ${state.plan.wave} of <a href="/tasks/${state.plan.parent}">${state.plan.parent}</a>
                  ${
                    state.plan.blockedBy.length === 0
                      ? raw("")
                      : html`<br />blocked by
                          ${join(
                            state.plan.blockedBy.map((id) => html`<a href="/tasks/${id}">${id}</a>`),
                            raw(", "),
                          )}`
                  }
                </dd>
              </div>`
        }
      </dl>
    </section>

    ${
      detail.spec === undefined
        ? html`<section>
            <h2>Spec</h2>
            <div class="panel" data-status="failed">
              <h3>unreadable</h3>
              <p>${detail.specError ?? "no spec.md for this task"}</p>
            </div>
          </section>`
        : html`<section>
            <h2>Spec</h2>
            <div class="panel">
              <div class="prose">${detail.spec.goal}</div>
            </div>
            ${acceptancePanels(detail.spec.acceptance, detail.filedAcceptance)}
            <div class="panel">
              <h3>repos</h3>
              <pre class="raw">${detail.spec.repos.map((r) => `${r.host}/${r.owner}/${r.name}`).join("\n")}</pre>
            </div>
          </section>`
    }

    ${amendmentSection(detail.amendments)}

    ${
      detail.live === undefined
        ? raw("")
        : html`<section>
            <h2>Live session ${detail.live.session}</h2>
            <div class="toolbar">
              <span>${detail.live.entries.length} messages so far</span>
              <span class="spacer"></span>
              <button class="pill" type="button" data-live-toggle hidden>following</button>
            </div>
            ${transcript(detail.live.entries)}
          </section>`
    }

    <section>
      <h2>Sessions</h2>
      ${
        detail.sessions.length === 0
          ? html`<p class="empty">No session has finished yet.</p>`
          : html`<div class="chips">
              ${detail.sessions.map(
                (session) =>
                  html`<a class="chip" href="/tasks/${detail.id}/sessions/${session}">session ${session}</a>`,
              )}
            </div>`
      }
    </section>

    ${
      detail.questions.length === 0
        ? raw("")
        : html`<section>
            <h2>Questions</h2>
            ${detail.questions.map(
              (entry) => html`<div class="panel" data-status="${entry.answer === undefined ? "awaiting-human" : "done"}">
                <h3>question ${entry.index}${entry.answer === undefined ? " · unanswered" : ""}</h3>
                <div class="prose">${entry.question}</div>
                ${
                  entry.answer === undefined
                    ? raw("")
                    : html`<h3 class="second">answer</h3>
                        <div class="prose">${entry.answer}</div>`
                }
              </div>`,
            )}
          </section>`
    }

    ${
      // The reason on its own is enough to render this section. A plan refused by
      // MATERIALISATION — a dependency cycle, a child with no acceptance criteria — never
      // convened a council, so it has no verdict file and this section used to disappear
      // entirely on exactly the rejections that had a mechanical, fixable cause.
      detail.verdicts.length === 0 && state.review?.reason === undefined
        ? raw("")
        : html`<section>
            <h2>Review council</h2>
            ${
              state.review?.reason === undefined
                ? raw("")
                : html`<div class="panel" data-status="awaiting-human">
                    <h3>why it was last sent back — after ${state.review.rounds} round(s)</h3>
                    <div class="prose">${state.review.reason}</div>
                  </div>`
            }
            ${detail.verdicts.map(
              (verdict) => html`<details>
                <summary>verdict ${verdict.index}</summary>
                <div class="body"><div class="prose">${verdict.body}</div></div>
              </details>`,
            )}
          </section>`
    }

    ${
      detail.artifacts.length === 0
        ? raw("")
        : html`<section>
            <h2>Artifacts</h2>
            <p class="sub">
              What this task published for the tasks after it, and what its acceptance gate
              rendered while it ran — a screenshot, a trace, a report. Each one downloads;
              nothing here is shown on this page, because these are bytes an agent wrote
              and this is the origin that serves every transcript.
            </p>
            <div class="chips">
              ${detail.artifacts.map(
                (name) =>
                  html`<a class="chip" download href="/tasks/${detail.id}/artifacts/${name}">${name}</a>`,
              )}
            </div>
          </section>`
    }

    <section>
      <h2>Documents</h2>
      <details>
        <summary>handoff.md — the baton, overwritten each session</summary>
        <div class="body">
          ${detail.handoff === undefined ? html`<p class="empty">none</p>` : html`<div class="prose">${detail.handoff}</div>`}
        </div>
      </details>
      <details>
        <summary>journal/ — append-only, the audit trail</summary>
        <div class="body">
          ${detail.journal === undefined ? html`<p class="empty">none</p>` : html`<div class="prose">${detail.journal}</div>`}
        </div>
      </details>
    </section>
  </main>`;
};

/* ---------------------------------------------------------------- transcript */

export interface SessionPageInput {
  readonly task: string;
  readonly session: number;
  readonly sessions: readonly number[];
  readonly entries: readonly TranscriptEntry[];
}

export const sessionPage = (input: SessionPageInput): Html => html`<main>
  <div class="page-head">
    <div class="crumb"><a href="/">fleet</a> / <a href="/tasks/${input.task}">${input.task}</a> / session ${input.session}</div>
    <h1>Session ${input.session}</h1>
    <p class="sub">
      ${input.entries.length} messages ·
      <a href="/tasks/${input.task}/sessions/${input.session}/raw">raw transcript</a>
    </p>
  </div>

  <section>
    <div class="chips">
      ${input.sessions.map(
        (session) =>
          html`<a class="chip${session === input.session ? " on" : ""}" href="/tasks/${input.task}/sessions/${session}"
            >${session}</a
          >`,
      )}
    </div>
  </section>

  <section>${transcript(input.entries)}</section>
</main>`;

const transcript = (entries: readonly TranscriptEntry[]): Html =>
  entries.length === 0
    ? html`<p class="empty">Nothing recorded.</p>`
    : html`<div class="turns">${entries.map(turn)}</div>`;

const turn = (entry: TranscriptEntry): Html => html`<div class="turn" data-role="${entry.role}">
  <div class="gutter">
    ${entry.role === "toolResult" ? entry.tool ?? "tool" : entry.role}
    ${entry.at === undefined ? raw("") : html`<span class="when">${timeTag(entry.at)}</span>`}
  </div>
  <div>
    ${entry.thinking === undefined ? raw("") : html`<div class="thought">${entry.thinking}</div>`}
    ${
      entry.error === undefined
        ? raw("")
        : html`<div class="flag">the provider stopped answering: ${entry.error}</div>`
    }
    ${
      entry.text === ""
        ? raw("")
        : entry.role === "toolResult"
          ? html`<pre class="result${entry.isError === true ? " bad" : ""}">${entry.text}</pre>`
          : html`<div class="say">${entry.text}</div>`
    }
    ${entry.calls.map(
      (call) => html`<div class="call">
        <div class="name">${call.name}<b>${call.id}</b></div>
        <pre>${call.arguments}</pre>
      </div>`,
    )}
    ${
      entry.usage === undefined
        ? raw("")
        : html`<div class="meter">
            ${entry.usage.inputTokens.toLocaleString("en-US")} in ·
            ${entry.usage.outputTokens.toLocaleString("en-US")} out · $${entry.usage.costUsd.toFixed(4)}
            ${entry.stopReason === undefined ? raw("") : html` · ${entry.stopReason}`}
          </div>`
    }
  </div>
</div>`;

/* --------------------------------------------------------------------- logs */

export const logsPage = (records: readonly LogRecord[], capacity: number): Html => html`<main>
  <div class="page-head">
    <div class="eyebrow">this runner only · in memory</div>
    <h1>Logs</h1>
    <p class="sub">
      The last ${capacity} records this process wrote to stdout, newest first. Loki has the
      history and the rest of the fleet.
    </p>
  </div>

  <section>
    <div class="toolbar">
      <span>${records.length} held</span>
      <span class="spacer"></span>
      <button class="pill" type="button" data-live-toggle hidden>following</button>
    </div>
    ${
      records.length === 0
        ? html`<p class="empty">Nothing logged since this process started.</p>`
        : html`<div class="logs">${records.map(logLine)}</div>`
    }
  </section>
</main>`;

const logLine = (record: LogRecord): Html => html`<div class="logline" data-level="${record.level}">
  <span class="t">${record.ts === "" ? raw("—") : timeTag(record.ts)}</span>
  <span class="lv">${record.level}</span>
  <span class="ev">${record.event}</span>
  <span class="fields"
    >${join(
      Object.entries(record.fields).map(([key, value]) => html`<b>${key}</b>=${String(value)}`),
      raw(" "),
    )}</span
  >
</div>`;

/* ------------------------------------------------------------------- runner */

/**
 * Bytes as a human reads them, in binary units — `1.4 GiB`, not `1.5 GB`.
 *
 * Binary because that is what `df`, the PVC request and every Kubernetes quantity in this
 * repo mean by `Gi`, and a page that disagreed with the manifest by 7% would have somebody
 * chasing a discrepancy that does not exist. One decimal place from MiB up: the walk is
 * apparent size and hourly, so a third significant figure would be precision the number
 * does not have.
 */
export const bytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${unit <= 1 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
};

/** One `name — size` row of the mirror or task breakdown. */
const diskRow = (entry: DiskEntry): Html =>
  html`<tr><td>${entry.name}</td><td class="num">${bytes(entry.bytes)}</td></tr>`;

const diskTable = (caption: string, entries: readonly DiskEntry[]): Html =>
  entries.length === 0
    ? html`<p class="empty">No ${caption} measured.</p>`
    : html`<table class="ledger">
        <thead><tr><th>${caption}</th><th class="num">size</th></tr></thead>
        <tbody>${entries.map(diskRow)}</tbody>
      </table>`;

/**
 * What is on the work volume, and when anyone last looked.
 *
 * `measuredAt` is rendered as prominently as the bytes on purpose. This measurement is
 * idle-only and hourly (`workspace/usage.ts`), so on a busy runner the newest answer can
 * be an hour old — and a disk figure with no timestamp is one somebody will act on as if
 * it were live, which for the one number that says "is the volume about to fill" is the
 * expensive mistake.
 */
const diskSection = (exported: RunnerExport, disk: DiskView | undefined): Html => html`<section>
  <h2>Disk</h2>
  ${
    disk === undefined
      ? html`<p class="empty">
          Not measured yet. The walk runs only when this runner is idle, at most every
          ${exported.usage.intervalHours}h.
        </p>`
      : html`<p class="crumb">
            Measured ${timeTag(disk.measuredAt)}, in ${Math.round(disk.durationMs)}ms, at most
            every ${exported.usage.intervalHours}h while idle. Apparent size, read-only.
            ${
              disk.partial
                ? html`<strong
                    >Partial: the ${exported.usage.deadlineSeconds}s deadline stopped the walk,
                    so every figure below is a floor.</strong
                  >`
                : raw("")
            }
          </p>
          <dl class="grid">
            <div><dt>volume</dt><dd>${exported.paths.root}</dd></div>
            <div><dt>capacity</dt><dd>${bytes(disk.totalBytes)}</dd></div>
            <div><dt>used</dt><dd>${bytes(disk.usedBytes)}</dd></div>
            <div><dt>free</dt><dd>${bytes(disk.freeBytes)}</dd></div>
          </dl>
          <table class="ledger">
            <thead><tr><th>category</th><th class="num">size</th><th class="num">of volume</th></tr></thead>
            <tbody>
              ${disk.categories.map(
                (category) => html`<tr>
                  <td>${category.name}</td>
                  <td class="num">${bytes(category.bytes)}</td>
                  <td class="num">${(category.fraction * 100).toFixed(1)}%</td>
                </tr>`,
              )}
            </tbody>
          </table>
          ${diskTable("largest tasks", disk.tasks)} ${diskTable("largest mirrors", disk.mirrors)}`
  }
</section>`;

/**
 * How many tasks this runner works at once, in words the page can be read for.
 *
 * `undefined` is NOT rendered as 1, and the difference is the whole reason this is a
 * function. The field is optional so the aggregating viewer (§18) can render a replica
 * still on an older image (see `RunnerExport.concurrency`), and printing "1 task at a
 * time" for a runner that never said so would be the viewer inventing a configuration
 * value — which is exactly what an operator would then go looking for in a ConfigMap that
 * does not contain it.
 */
const concurrencyLabel = (concurrency: number | undefined): string => {
  if (concurrency === undefined) return "not reported";
  return concurrency === 1 ? "1 task at a time" : `up to ${concurrency} tasks at once`;
};

export const runnerPage = (exported: RunnerExport, disk?: DiskView): Html => html`<main>
  <div class="page-head">
    <div class="eyebrow">configuration · no credentials</div>
    <h1>${exported.runnerId}</h1>
    <p class="sub">Everything this runner is willing to say about itself.</p>
  </div>

  <section>
    <h2>Identity</h2>
    <dl class="grid">
      <div><dt>runner id</dt><dd>${exported.runnerId}</dd></div>
      <div><dt>capabilities</dt><dd><div class="chips">${exported.capabilities.map((c) => html`<span class="chip on">${c}</span>`)}</div></dd></div>
      <div><dt>poll interval</dt><dd>${exported.pollSeconds}s</dd></div>
      <div><dt>concurrency</dt><dd>${concurrencyLabel(exported.concurrency)}</dd></div>
      <div><dt>log level</dt><dd>${exported.log.level}</dd></div>
      <div><dt>intake interval</dt><dd>${exported.intake.intervalSeconds}s</dd></div>
    </dl>
  </section>

  <section>
    <h2>Model</h2>
    <dl class="grid">
      <div><dt>model</dt><dd>${exported.llm.modelId}</dd></div>
      <div><dt>provider</dt><dd>${exported.llm.providerId}</dd></div>
      <div><dt>auth</dt><dd>${exported.llm.auth}</dd></div>
      <div><dt>context window</dt><dd>${exported.llm.contextWindow.toLocaleString("en-US")}</dd></div>
      <div><dt>max tokens</dt><dd>${exported.llm.maxTokens.toLocaleString("en-US")}</dd></div>
      <div><dt>handoff at</dt><dd>${Math.round(exported.handoff.thresholdFraction * 100)}% of the window</dd></div>
      <div><dt>cooldown</dt><dd>${exported.llm.cooldown.initialSeconds}s → ${exported.llm.cooldown.maxSeconds}s</dd></div>
    </dl>
  </section>

  <section>
    <h2>Limits</h2>
    <dl class="grid">
      <div><dt>sessions per task</dt><dd>${exported.limits.maxSessionsPerTask}</dd></div>
      <div><dt>no-progress limit</dt><dd>${exported.limits.noProgressLimit}</dd></div>
      <div><dt>review rounds</dt><dd>${exported.limits.maxReviewRounds}</dd></div>
      <div><dt>session wall clock</dt><dd>${Math.round(exported.limits.maxSessionSeconds / 60)} min</dd></div>
      <div><dt>lease heartbeat</dt><dd>${exported.lease.heartbeatSeconds}s</dd></div>
      <div><dt>lease stale after</dt><dd>${exported.lease.staleAfterSeconds}s</dd></div>
    </dl>
  </section>

  <section>
    <h2>Environment</h2>
    <dl class="grid">
      <div><dt>nixpkgs</dt><dd>${exported.toolchain.nixpkgs}</dd></div>
      <div><dt>resolve timeout</dt><dd>${exported.toolchain.timeoutSeconds}s</dd></div>
      <div><dt>store gc</dt><dd>every ${exported.toolchain.gcIntervalHours}h, keep ${exported.toolchain.gcKeepDays}d</dd></div>
      <div><dt>worktree reap</dt><dd>${
        exported.workspace === undefined
          ? "—"
          : `every ${exported.workspace.reap.intervalHours}h, keep ${exported.workspace.reap.keepHours}h`
      }</dd></div>
      <div><dt>mirrors</dt><dd>${exported.paths.mirrors}</dd></div>
      <div><dt>worktrees</dt><dd>${exported.paths.tasks}</dd></div>
    </dl>
  </section>

  ${diskSection(exported, disk)}

  <section>
    <h2>State repo</h2>
    <dl class="grid">
      <div><dt>url</dt><dd>${exported.stateRepo.url}</dd></div>
      <div><dt>branch</dt><dd>${exported.stateRepo.branch}</dd></div>
      <div><dt>checkout</dt><dd>${exported.stateRepo.path}</dd></div>
    </dl>
  </section>

  <section>
    <h2>Alerts</h2>
    <dl class="grid">
      <div>
        <dt>receiver</dt>
        <dd>${
          exported.remediation.enabled
            ? html`<span class="chip on">listening</span> on port ${exported.remediation.port}`
            : html`<span class="chip">disabled</span>`
        }</dd>
      </div>
      <div>
        <dt>cluster reads</dt>
        <dd>${
          exported.cluster.enabled
            ? html`<span class="chip on">enabled</span>`
            : html`<span class="chip">disabled</span>`
        }</dd>
      </div>
      <div>
        <dt>namespaces</dt>
        <dd>${
          exported.cluster.namespaces.length === 0
            ? html`<span class="id">none — every read refused</span>`
            : html`<div class="chips">${exported.cluster.namespaces.map(
                (namespace) => html`<span class="chip">${namespace}</span>`,
              )}</div>`
        }</dd>
      </div>
      <div><dt>log lines per read</dt><dd>${exported.cluster.maxLogLines}</dd></div>
    </dl>
    <p class="crumb">
      What the receiver has actually decided is on <a href="/intake">intake</a>. A disabled
      receiver is the most likely reason a firing alert produced no task at all.
    </p>
  </section>

  <section>
    <h2>Workspaces</h2>
    ${
      exported.workspaces.length === 0
        ? html`<p class="empty">None configured.</p>`
        : html`<table class="ledger">
            <thead><tr><th>name</th><th>forge</th><th>owner</th><th>tracker</th><th>ingest label</th></tr></thead>
            <tbody>
              ${exported.workspaces.map(
                (workspace) => html`<tr>
                  <td>${workspace.name}</td>
                  <td>${workspace.forge.kind} · ${workspace.forge.host}</td>
                  <td>${workspace.forge.owner}</td>
                  <td>${workspace.tracker?.kind ?? "—"}</td>
                  <td>${workspace.tracker?.ingestLabel ?? "—"}</td>
                </tr>`,
              )}
            </tbody>
          </table>`
    }
  </section>

  <section>
    <h2>Machine readable</h2>
    <p class="crumb">
      The same fields as JSON: <a href="/api/runner">/api/runner</a>. The fleet is at
      <a href="/api/fleet">/api/fleet</a>, one task at <code>/api/tasks/&lt;id&gt;</code>, and
      Prometheus scrapes <code>/metrics</code> on the metrics port, not this one.
    </p>
  </section>
</main>`;

/* ------------------------------------------------------------------ digests */

export const digestsPage = (dates: readonly string[]): Html => html`<main>
  <div class="page-head">
    <div class="eyebrow">state repo · digests/</div>
    <h1>Daily digests</h1>
    <p class="sub">
      One document per day, published at the configured hour by whichever runner won the
      claim for it. The same text went to Discord.
    </p>
  </div>

  <section>
    ${
      dates.length === 0
        ? html`<p class="empty">
            No digest has been published yet. One appears after the first cutoff hour with
            the digest enabled.
          </p>`
        : html`<div class="chips">
            ${dates.map((date) => html`<a class="chip" href="/digests/${date}">${date}</a>`)}
          </div>`
    }
  </section>
</main>`;

/**
 * One day, exactly as it was published.
 *
 * Rendered as prose rather than parsed as markdown, like every other document this view
 * shows. It is generated text quoting agent-authored prose, and `html.ts` escaping it is
 * the whole defence — a markdown renderer here would be a second thing to get right.
 */
export const digestPage = (view: DigestView): Html => html`<main>
  <div class="page-head">
    <div class="crumb"><a href="/digests">digests</a> / ${view.date}</div>
    <h1>${view.date}</h1>
    <p class="sub">As published. Discord got this text; the state repo keeps it.</p>
  </div>

  <section>
    <div class="panel"><div class="prose">${view.body}</div></div>
  </section>

  <section>
    <h2>Other days</h2>
    <div class="chips">
      ${view.dates.map(
        (date) =>
          html`<a class="chip${date === view.date ? " on" : ""}" href="/digests/${date}"
            >${date}</a
          >`,
      )}
    </div>
  </section>
</main>`;

/* -------------------------------------------------------------------- error */

export const errorPage = (status: number, detail: string): Html => html`<main>
  <div class="page-head">
    <div class="eyebrow">${status}</div>
    <h1>${detail}</h1>
    <p class="sub"><a href="/">Back to the fleet</a></p>
  </div>
</main>`;
