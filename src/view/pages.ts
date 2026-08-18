/**
 * The two pages the viewer draws differently from a runner. See DESIGN.md §18.
 *
 * Everything else \u2014 a task, a session, `/intake`, `/runner`, a digest \u2014 is the runner's own
 * template rendering the runner's own view model, because the data is identical and a
 * second renderer would be a second thing to keep in step. These two are not: the fleet
 * page has to say which replicas did not answer, and the log page is four rings merged and
 * each line has to name the process it came out of.
 *
 * Same rules as everything else here: `html.ts` escapes by default, `raw` appears on
 * literals only, and a runner NAME is a DNS label from a SRV record \u2014 not a string this
 * process chose.
 */
import type { LogRecord } from "../obs/ring.ts";
import { html, join, raw, type Html } from "../web/html.ts";
import { fleetPage } from "../web/pages.ts";
import type { AggregateFleet, AggregateLogs, TaggedLog } from "./aggregate.ts";

/**
 * The fleet, with a banner for every runner that did not answer.
 *
 * The banner is the point of the whole process. A dashboard that silently dropped a replica
 * would render it as a runner holding nothing \u2014 indistinguishable from an idle one \u2014 and
 * "three of the four are idle" is a sentence an operator acts on.
 */
export const fleetWithRunners = (merged: AggregateFleet): Html => html`${unreachableBanner(
  merged.unreachable,
)}${fleetPage(merged.view)}${sourceNote(merged)}`;

const unreachableBanner = (
  unreachable: AggregateFleet["unreachable"],
): Html =>
  unreachable.length === 0
    ? raw("")
    : html`<div class="banner" data-status="failed">
        <span class="status" data-status="failed"><span>unreachable</span></span>
        <span>
          ${join(
            unreachable.map(
              (entry) => html`<b>${entry.runner}</b> \u2014 ${entry.error}`,
            ),
            raw(" \u00b7 "),
          )}
        </span>
      </div>`;

const sourceNote = (merged: AggregateFleet): Html =>
  merged.source === undefined
    ? html`<p class="crumb">No runner answered, so this page has no task list to show.</p>`
    : html`<p class="crumb">
        Tasks read from <b>${merged.source}</b> \u2014 the state repo is identical on every
        runner, so one answer is the whole fleet's. Live sessions and logs are asked of
        every replica, because those exist in one process's memory each.
      </p>`;

/**
 * Every runner's ring, merged newest-first, each line tagged with its process.
 *
 * `/logs` used to be one pod's thousand lines out of four thousand, chosen by whichever
 * replica the Service picked, and nothing on the page said so.
 */
export const viewerLogsPage = (merged: AggregateLogs): Html => html`<main>
  <div class="page-head">
    <div class="eyebrow">every runner \u00b7 in memory</div>
    <h1>Logs</h1>
    <p class="sub">
      Every replica's ring, merged newest-first and tagged with the process that wrote it.
      Loki has the history; this is what the fleet is saying right now.
    </p>
  </div>

  ${unreachableBanner(merged.unreachable)}

  <section>
    <div class="toolbar">
      <span>${merged.records.length} held \u00b7 ${merged.answered.length} runner(s) answered</span>
      <span class="spacer"></span>
      <button class="pill" type="button" data-live-toggle hidden>following</button>
    </div>
    ${
      merged.records.length === 0
        ? html`<p class="empty">
            ${merged.answered.length === 0
              ? "No runner answered, so there is nothing to show \u2014 which is not the same as nothing being logged."
              : "Nothing logged since those processes started."}
          </p>`
        : html`<div class="logs">${merged.records.map(taggedLine)}</div>`
    }
  </section>
</main>`;

const taggedLine = (record: TaggedLog): Html => html`<div class="logline" data-level="${record.level}">
  <span class="t">${record.ts === "" ? raw("\u2014") : timeTag(record.ts)}</span>
  <span class="lv">${record.level}</span>
  <span class="chip">${record.runner}</span>
  <span class="ev">${record.event}</span>
  <span class="fields"
    >${join(
      Object.entries(record.fields as LogRecord["fields"]).map(
        ([key, value]) => html`<b>${key}</b>=${String(value)}`,
      ),
      raw(" "),
    )}</span
  >
</div>`;

const timeTag = (iso: string): Html => html`<time datetime="${iso}">${iso}</time>`;
