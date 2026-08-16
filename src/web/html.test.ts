import assert from "node:assert/strict";
import { test } from "node:test";
import { html, join, raw, render, safeUrl } from "./html.ts";

test("an interpolated value is escaped, because every string here is agent-authored", async () => {
  // A journal entry, a question, a goal, a bash result — all of them quote whatever the
  // agent read. A repo containing `<script>` must not become script on this page.
  const evil = `<script>alert("x")</script>`;
  assert.equal(
    render(html`<p>${evil}</p>`),
    `<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>`,
  );
});

test("quotes and ampersands are escaped too, so an attribute cannot be broken out of", async () => {
  assert.equal(
    render(html`<a title="${`" onmouseover="steal()`}">x</a>`),
    `<a title="&quot; onmouseover=&quot;steal()">x</a>`,
  );
  assert.equal(render(html`<p>${"a & b"}</p>`), `<p>a &amp; b</p>`);
  assert.equal(render(html`<p>${"it's"}</p>`), `<p>it&#39;s</p>`);
});

test("nested fragments are composed without being escaped twice", async () => {
  const inner = html`<em>${"a & b"}</em>`;
  assert.equal(render(html`<p>${inner}</p>`), `<p><em>a &amp; b</em></p>`);
});

test("an array of fragments concatenates, which is how a table body is built", async () => {
  const rows = ["one", "two"].map((value) => html`<li>${value}</li>`);
  assert.equal(render(html`<ul>${rows}</ul>`), `<ul><li>one</li><li>two</li></ul>`);
});

test("null and undefined render as nothing rather than as the words", async () => {
  assert.equal(render(html`<p>${undefined}${null}</p>`), `<p></p>`);
});

test("numbers and booleans survive", async () => {
  assert.equal(render(html`<p>${3}${false}</p>`), `<p>3false</p>`);
});

test("raw is the single explicit escape hatch", async () => {
  assert.equal(render(html`<p>${raw("<br>")}</p>`), `<p><br></p>`);
});

test("join puts a separator between fragments", async () => {
  const parts = ["a", "b"].map((value) => html`<b>${value}</b>`);
  assert.equal(render(html`<p>${join(parts, raw(" · "))}</p>`), `<p><b>a</b> · <b>b</b></p>`);
});

test("a url scheme that executes is refused", async () => {
  // A PR url reaches this from a forge, a tracker link from a spec — both agent-adjacent.
  // An href of `javascript:` is script on the same origin as the session transcripts.
  assert.equal(safeUrl("javascript:alert(1)"), undefined);
  assert.equal(safeUrl("JaVaScRiPt:alert(1)"), undefined);
  assert.equal(safeUrl("data:text/html,<script>alert(1)</script>"), undefined);
  assert.equal(safeUrl("vbscript:msgbox"), undefined);
});

test("ordinary links survive", async () => {
  assert.equal(safeUrl("https://github.com/acme/widget/pull/3"), "https://github.com/acme/widget/pull/3");
  assert.equal(safeUrl("http://example.invalid/x"), "http://example.invalid/x");
  assert.equal(safeUrl("/tasks/TASK-1"), "/tasks/TASK-1");
});

test("a url that is not a url at all is refused rather than guessed at", async () => {
  assert.equal(safeUrl(""), undefined);
  assert.equal(safeUrl("   "), undefined);
  assert.equal(safeUrl("not a url"), undefined);
});
