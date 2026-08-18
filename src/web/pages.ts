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
  RunnerExport,
  TaskDetail,
  TaskRow,
} from "./view.ts";

export type Page = "fleet" | "digests" | "logs" | "runner";

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

  ${
    view.live === undefined
      ? raw("")
      : html`<div class="banner">
          <span class="status" data-status="running"><span>session ${view.live.session}</span></span>
          <span>
            <a href="/tasks/${view.live.task}">${view.live.task}</a> is running here on
            ${view.live.model} · ${view.live.messages} messages · started
            <time datetime="${view.live.startedAt}">${view.live.startedAt}</time>
          </span>
        </div>`
  }

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
                <th>task</th><th>status</th><th>phase</th><th>sessions</th>
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

/* --------------------------------------------------------------------- task */

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
            <div class="panel">
              <h3>acceptance — run by the supervisor, never by the agent</h3>
              ${
                detail.spec.acceptance.length === 0
                  ? html`<p class="empty">none declared</p>`
                  : html`<pre class="raw">${detail.spec.acceptance.join("\n")}</pre>`
              }
            </div>
            <div class="panel">
              <h3>repos</h3>
              <pre class="raw">${detail.spec.repos.map((r) => `${r.host}/${r.owner}/${r.name}`).join("\n")}</pre>
            </div>
          </section>`
    }

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
      detail.verdicts.length === 0
        ? raw("")
        : html`<section>
            <h2>Review council</h2>
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
            <div class="chips">
              ${detail.artifacts.map(
                (name) =>
                  html`<a class="chip" href="/tasks/${detail.id}/artifacts/${name}">${name}</a>`,
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
        <summary>journal.md — append-only, the audit trail</summary>
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
