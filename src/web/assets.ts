/**
 * The stylesheet and the handful of scripted behaviours, as strings. See DESIGN.md §18.
 *
 * They are TypeScript modules rather than files under `public/` for one blunt reason: the
 * image copies `dist/` and nothing else (Dockerfile), so a `.css` file on disk would
 * type-check, run in development, and 404 in the cluster. A string that `tsc` emits
 * cannot go missing.
 *
 * They are served as their own routes rather than inlined, which is what lets the
 * Content-Security-Policy stay `script-src 'self'` with no `unsafe-inline` — on an origin
 * that serves agent-authored prose, that header is the second line of defence behind
 * `html.ts` escaping, and it is worth two extra requests.
 *
 * The look is deliberate and dark-only: an instrument panel, not a document. Ink and
 * paper with one signal colour, hairline rules instead of cards, a serif for prose
 * because half of what this shows IS prose, and mono for everything measured. No web
 * font is loaded — the CSP forbids the request and the pod should not need the network to
 * render a page about itself.
 */

export const STYLESHEET = `
:root {
  --ink-900: #0b0e11;
  --ink-800: #10141a;
  --ink-700: #161b22;
  --ink-600: #1d242c;
  --rule: rgba(232, 227, 217, 0.10);
  --rule-strong: rgba(232, 227, 217, 0.22);
  --paper: #e8e3d9;
  --paper-dim: #9aa3ab;
  --paper-faint: #6b747d;
  --signal: #e0a458;
  --signal-dim: rgba(224, 164, 88, 0.16);
  --running: #e0a458;
  --ready: #7d8894;
  --done: #7fb28a;
  --failed: #c9705f;
  --parked: #9b8bb4;
  --awaiting: #d9a441;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Charter, "Bitstream Charter", Georgia, serif;
  --mono: "Berkeley Mono", "JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --rail: 15rem;
}

*, *::before, *::after { box-sizing: border-box; }

html { color-scheme: dark; }

body {
  margin: 0;
  min-height: 100vh;
  background-color: var(--ink-900);
  /* Hairline ruling, like a ledger. Two degrees off nothing, so it reads as texture
     rather than as a pattern anybody is meant to notice. */
  background-image:
    repeating-linear-gradient(
      180deg,
      rgba(232, 227, 217, 0.022) 0px,
      rgba(232, 227, 217, 0.022) 1px,
      transparent 1px,
      transparent 4px
    ),
    radial-gradient(120% 80% at 50% 0%, rgba(224, 164, 88, 0.05), transparent 60%);
  color: var(--paper);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--signal); text-decoration: none; border-bottom: 1px solid transparent; }
a:hover { border-bottom-color: var(--signal); }
h1, h2, h3 { font-weight: 600; margin: 0; }

/* ---------------------------------------------------------------- shell */

.shell { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); min-height: 100vh; }

.rail {
  position: sticky;
  top: 0;
  align-self: start;
  height: 100vh;
  padding: 1.6rem 1.1rem;
  border-right: 1px solid var(--rule);
  background: linear-gradient(180deg, var(--ink-800), var(--ink-900));
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  overflow-y: auto;
}

.brand { display: flex; flex-direction: column; gap: 0.15rem; }
.brand .mark {
  font-family: var(--serif);
  font-size: 1.5rem;
  letter-spacing: 0.01em;
  color: var(--paper);
}
/* The segments of the thing the project is named after. Also the only decoration. */
.brand .segments { display: flex; gap: 3px; margin-top: 0.45rem; }
.brand .segments i {
  width: 9px; height: 4px; border-radius: 2px;
  background: var(--signal); opacity: 0.25;
}
.brand .segments i:nth-child(1) { opacity: 0.85; }
.brand .segments i:nth-child(2) { opacity: 0.6; }
.brand .segments i:nth-child(3) { opacity: 0.42; }

nav { display: flex; flex-direction: column; gap: 0.1rem; }
nav a {
  padding: 0.35rem 0.5rem;
  border-bottom: none;
  border-left: 2px solid transparent;
  color: var(--paper-dim);
  letter-spacing: 0.04em;
  text-transform: lowercase;
}
nav a:hover { color: var(--paper); background: var(--ink-700); }
nav a[aria-current="page"] {
  color: var(--paper);
  border-left-color: var(--signal);
  background: var(--signal-dim);
}

.rail-block { display: flex; flex-direction: column; gap: 0.4rem; }
.rail-label {
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-faint);
}
.rail-value { color: var(--paper); overflow-wrap: anywhere; }

main { padding: 2.2rem 2.4rem 5rem; max-width: 82rem; }

/* ---------------------------------------------------------------- headings */

.page-head { margin-bottom: 1.8rem; }
.page-head h1 {
  font-family: var(--serif);
  font-size: 1.9rem;
  line-height: 1.15;
  letter-spacing: -0.01em;
}
.page-head .sub { color: var(--paper-dim); margin-top: 0.35rem; }
.eyebrow {
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--paper-faint);
  margin-bottom: 0.5rem;
}

section { margin-bottom: 2.4rem; }
section > h2 {
  font-size: 11px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--paper-faint);
  padding-bottom: 0.5rem;
  margin-bottom: 0.9rem;
  border-bottom: 1px solid var(--rule);
}

/* ---------------------------------------------------------------- counters */

.counts { display: flex; flex-wrap: wrap; gap: 0; border: 1px solid var(--rule); }
.counts .count {
  flex: 1 1 7rem;
  padding: 0.85rem 1rem;
  border-right: 1px solid var(--rule);
  border-top: 2px solid var(--tone, var(--rule-strong));
}
.counts .count:last-child { border-right: none; }
.counts .count b { display: block; font-size: 1.7rem; font-weight: 500; line-height: 1.1; }
.counts .count span {
  font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--paper-dim);
}

/* ---------------------------------------------------------------- ledger */

.ledger { width: 100%; border-collapse: collapse; }
.ledger th {
  text-align: left;
  font-weight: 400;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--paper-faint);
  padding: 0 0.75rem 0.5rem;
  border-bottom: 1px solid var(--rule-strong);
}
.ledger td { padding: 0.7rem 0.75rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
.ledger tbody tr { border-left: 2px solid transparent; }
.ledger tbody tr:hover { background: var(--ink-800); border-left-color: var(--tone, var(--rule-strong)); }
.ledger .num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.ledger .title { font-family: var(--serif); font-size: 15px; }
.ledger .title a { border-bottom: none; color: var(--paper); }
.ledger .title a:hover { color: var(--signal); }
.ledger .id { color: var(--paper-faint); font-size: 11px; letter-spacing: 0.04em; }

/* ---------------------------------------------------------------- status */

.status { display: inline-flex; align-items: center; gap: 0.45rem; white-space: nowrap; }
.status::before {
  content: "";
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--tone, var(--paper-faint));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone, var(--paper-faint)) 18%, transparent);
}
.status span { color: var(--paper-dim); letter-spacing: 0.06em; }

[data-status="running"] { --tone: var(--running); }
[data-status="ready"] { --tone: var(--ready); }
[data-status="done"] { --tone: var(--done); }
[data-status="failed"] { --tone: var(--failed); }
[data-status="parked"] { --tone: var(--parked); }
[data-status="awaiting-human"] { --tone: var(--awaiting); }

.status[data-status="running"]::before { animation: breathe 2.4s ease-in-out infinite; }

@keyframes breathe {
  0%, 100% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--running) 10%, transparent); }
  50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--running) 26%, transparent); }
}

/* Sessions burned against the limit — the instars of the thing. */
.instar { display: flex; gap: 2px; align-items: center; flex-wrap: wrap; }
.instar i { width: 6px; height: 12px; border-radius: 1px; background: var(--rule); }
.instar i.spent { background: var(--tone, var(--signal)); }
.instar i.over { background: var(--failed); }
.instar .count { margin-left: 0.5rem; white-space: nowrap; }

.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.chip {
  border: 1px solid var(--rule-strong);
  padding: 0.05rem 0.4rem;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--paper-dim);
}
.chip.on { border-color: var(--signal); color: var(--signal); }

/* Where a task came from (§14). An alert task is the one worth spotting in a scan: it is
   work the fleet opened for itself, without a human asking for it. */
.chip[data-origin="alert"] { border-color: var(--awaiting); color: var(--awaiting); }
.chip[data-origin="brainstorm"] { border-color: var(--ready); color: var(--ready); }

/* ---------------------------------------------------------------- panels */

.panel {
  border: 1px solid var(--rule);
  border-left: 2px solid var(--tone, var(--rule-strong));
  background: var(--ink-800);
  padding: 1rem 1.15rem;
}
.panel + .panel { margin-top: 0.75rem; }
.panel > h3.second { margin-top: 0.9rem; }
.panel > h3 {
  font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--paper-faint); margin-bottom: 0.6rem;
}
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); }
.grid > div { background: var(--ink-800); padding: 0.75rem 0.9rem; }
.grid dt { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--paper-faint); }
.grid dd { margin: 0.25rem 0 0; word-break: break-word; }

.prose {
  font-family: var(--serif);
  font-size: 15px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--paper);
}
pre.raw {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  color: var(--paper-dim);
  max-height: 34rem;
  overflow: auto;
}

details { border-top: 1px solid var(--rule); }
details > summary {
  cursor: pointer;
  padding: 0.55rem 0;
  color: var(--paper-dim);
  letter-spacing: 0.05em;
  list-style: none;
}
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: "▸ "; color: var(--paper-faint); }
details[open] > summary::before { content: "▾ "; }
details > summary:hover { color: var(--paper); }
details > .body { padding: 0 0 1rem 1rem; border-left: 1px solid var(--rule); margin-left: 0.2rem; }

/* ---------------------------------------------------------------- transcript */

.turn { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); gap: 1rem; padding: 0.9rem 0; border-top: 1px solid var(--rule); }
.turn:first-child { border-top: none; }
.turn .gutter { color: var(--paper-faint); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
.turn .gutter .when { display: block; color: var(--paper-faint); opacity: 0.7; letter-spacing: 0; text-transform: none; margin-top: 0.2rem; }
.turn[data-role="assistant"] .gutter { color: var(--signal); }
.turn[data-role="user"] .gutter { color: var(--done); }
.turn[data-role="toolResult"] .gutter { color: var(--paper-dim); }
.turn .say { font-family: var(--serif); font-size: 15px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.turn .thought {
  border-left: 2px solid var(--rule-strong);
  padding-left: 0.9rem;
  color: var(--paper-faint);
  font-style: italic;
  font-family: var(--serif);
  white-space: pre-wrap;
  word-break: break-word;
  margin-bottom: 0.6rem;
}
.call { margin-top: 0.6rem; border: 1px solid var(--rule); background: var(--ink-900); }
.call .name { padding: 0.35rem 0.7rem; border-bottom: 1px solid var(--rule); color: var(--signal); letter-spacing: 0.08em; }
.call .name b { color: var(--paper-faint); font-weight: 400; margin-left: 0.5rem; letter-spacing: 0; }
.call pre { margin: 0; padding: 0.6rem 0.7rem; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--paper-dim); max-height: 20rem; overflow: auto; }
.result { margin: 0; padding: 0.6rem 0.75rem; background: var(--ink-900); border: 1px solid var(--rule); white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--paper-dim); max-height: 24rem; overflow: auto; }
.result.bad { border-color: color-mix(in srgb, var(--failed) 45%, transparent); color: color-mix(in srgb, var(--failed) 70%, var(--paper)); }
.turn .flag { color: var(--failed); }
.turn .meter { color: var(--paper-faint); font-size: 11px; margin-top: 0.45rem; }

/* ---------------------------------------------------------------- logs */

.logs { display: flex; flex-direction: column; }
.logline { display: grid; grid-template-columns: 6.5rem 4rem 14rem minmax(0, 1fr); gap: 0.8rem; padding: 0.28rem 0.5rem; border-bottom: 1px solid rgba(232, 227, 217, 0.05); }
.logline:hover { background: var(--ink-800); }
.logline .t { color: var(--paper-faint); font-variant-numeric: tabular-nums; }
.logline .lv { letter-spacing: 0.12em; text-transform: uppercase; font-size: 10px; padding-top: 2px; }
.logline .ev { color: var(--paper); }
.logline .fields { color: var(--paper-dim); word-break: break-word; }
.logline .fields b { color: var(--paper-faint); font-weight: 400; }
.logline[data-level="error"] .lv { color: var(--failed); }
.logline[data-level="warn"] .lv { color: var(--awaiting); }
.logline[data-level="info"] .lv { color: var(--ready); }
.logline[data-level="debug"] .lv { color: var(--paper-faint); }
.logline[data-level="error"] { background: color-mix(in srgb, var(--failed) 7%, transparent); }

/* ---------------------------------------------------------------- misc */

.toolbar { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; color: var(--paper-dim); }
.toolbar .spacer { flex: 1; }
.pill {
  border: 1px solid var(--rule-strong); padding: 0.15rem 0.55rem;
  color: var(--paper-dim); letter-spacing: 0.08em; font-size: 11px; background: transparent;
  font-family: var(--mono); cursor: pointer;
}
.pill[aria-pressed="true"] { border-color: var(--signal); color: var(--signal); }
.empty { color: var(--paper-faint); font-family: var(--serif); font-size: 15px; font-style: italic; }
.crumb { color: var(--paper-faint); margin-bottom: 0.6rem; }
.crumb a { color: var(--paper-dim); }

.banner {
  border: 1px solid color-mix(in srgb, var(--running) 40%, transparent);
  border-left-width: 2px;
  background: var(--signal-dim);
  padding: 0.8rem 1rem;
  margin-bottom: 1.6rem;
  display: flex;
  align-items: center;
  gap: 0.8rem;
}

/* One orchestrated reveal on load, not a dozen scattered ones. */
@media (prefers-reduced-motion: no-preference) {
  main > * { animation: rise 380ms cubic-bezier(0.2, 0.7, 0.3, 1) backwards; }
  main > *:nth-child(2) { animation-delay: 45ms; }
  main > *:nth-child(3) { animation-delay: 90ms; }
  main > *:nth-child(4) { animation-delay: 135ms; }
  main > *:nth-child(n + 5) { animation-delay: 170ms; }
}
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

@media (max-width: 60rem) {
  .shell { grid-template-columns: 1fr; }
  .rail { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; }
  nav { flex-direction: row; }
  main { padding: 1.4rem 1.1rem 4rem; }
  .turn, .logline { grid-template-columns: 1fr; gap: 0.3rem; }
}
`;

/**
 * Three behaviours, none of which the page depends on to be readable.
 *
 * Refresh replaces `<main>` from a fetch of the same URL rather than re-rendering
 * client-side: the server already knows how to draw every one of these pages, and a
 * second renderer in the browser is a second thing to keep in step with the first.
 */
export const SCRIPT = `
(() => {
  const body = document.body;

  const relative = (iso) => {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    const seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 60) return seconds + "s ago";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
    return Math.floor(seconds / 86400) + "d ago";
  };

  const stamp = (root) => {
    for (const element of root.querySelectorAll("time[datetime]")) {
      const text = relative(element.getAttribute("datetime"));
      if (text) {
        element.title = element.getAttribute("datetime");
        element.textContent = text;
      }
    }
  };

  let live = body.dataset.refresh !== undefined;
  const seconds = Number(body.dataset.refresh || "0");

  const toggle = document.querySelector("[data-live-toggle]");
  if (toggle) {
    toggle.hidden = false;
    toggle.setAttribute("aria-pressed", String(live));
    toggle.addEventListener("click", () => {
      live = !live;
      toggle.setAttribute("aria-pressed", String(live));
      if (live) schedule();
    });
  }

  const refresh = async () => {
    try {
      const response = await fetch(location.href, { headers: { accept: "text/html" } });
      if (!response.ok) return;
      const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
      const next = parsed.querySelector("main");
      const current = document.querySelector("main");
      if (!next || !current) return;
      const y = window.scrollY;
      current.replaceWith(next);
      stamp(next);
      window.scrollTo(0, y);
    } catch {
      /* A failed poll is a page that stays as it was. The next tick tries again. */
    }
  };

  const schedule = () => {
    if (!live || !seconds) return;
    window.setTimeout(async () => {
      if (!live) return;
      if (!document.hidden) await refresh();
      schedule();
    }, seconds * 1000);
  };

  stamp(document);
  schedule();
  window.setInterval(() => stamp(document), 30000);
})();
`;
