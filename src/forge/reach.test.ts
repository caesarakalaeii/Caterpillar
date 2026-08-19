import assert from "node:assert/strict";
import { test } from "node:test";
import { nearestName, nearestSlug, rankRepos, unreachableSummary } from "./reach.ts";

const repo = (slug: string) => {
  const [owner, name] = slug.split("/") as [string, string];
  return { host: "github.com", owner, name };
};

test("a separator the human left out is still the same repo", () => {
  // The failure this exists for: `/brainstorm caesarakalaeii/allchat` against an
  // installation whose repo is `all-chat`. GitHub answers the mint with the same 422 it
  // gives for a repo the App is not installed on, so the name is the thing to say.
  assert.equal(
    nearestSlug(repo("caesarakalaeii/allchat"), [
      "caesarakalaeii/Caterpillar",
      "caesarakalaeii/all-chat",
      "caesarakalaeii/all-chat-extension",
    ]),
    "caesarakalaeii/all-chat",
  );
});

test("case and the other separators count as the same name too", () => {
  const candidates = ["acme/all-chat"];
  assert.equal(nearestSlug(repo("acme/AllChat"), candidates), "acme/all-chat");
  assert.equal(nearestSlug(repo("acme/all_chat"), candidates), "acme/all-chat");
  assert.equal(nearestSlug(repo("acme/all.chat"), candidates), "acme/all-chat");
});

test("one typo in a name is a near miss; a different word is not", () => {
  assert.equal(nearestSlug(repo("acme/widgot"), ["acme/widget"]), "acme/widget");
  assert.equal(nearestSlug(repo("acme/tractor"), ["acme/widget"]), undefined);
});

test("a repo named under the wrong owner is matched on the name", () => {
  // `caesar/all-chat` for `caesarakalaeii/all-chat` — the owner is a shorthand nobody
  // spells out, and refusing without the suggestion sends the human to the settings page
  // of an installation that was never the problem.
  assert.equal(
    nearestSlug(repo("caesar/all-chat"), ["caesarakalaeii/all-chat"]),
    "caesarakalaeii/all-chat",
  );
});

test("an exact match is never suggested — it is not unreachable", () => {
  assert.equal(nearestSlug(repo("acme/widget"), ["acme/widget"]), undefined);
});

test("nothing to compare against yields no suggestion rather than a guess", () => {
  assert.equal(nearestSlug(repo("acme/widget"), []), undefined);
});

test("a bare name is what a mint 422 has to work with, and it is enough", () => {
  // `POST /app/installations/{id}/access_tokens` takes `repositories` as names, so the
  // owner is not part of what GitHub refused. Matching on the name is all the request had.
  assert.equal(nearestName("allchat", ["caesarakalaeii/all-chat"]), "caesarakalaeii/all-chat");
  assert.equal(
    nearestName("all-chat", ["caesarakalaeii/all-chat"]),
    undefined,
    "a name the installation does list is not the one the 422 was about",
  );
  assert.equal(nearestName("tractor", ["caesarakalaeii/all-chat"]), undefined);
});

test("the summary reads as prose, whichever number of repos it covers", () => {
  const one = unreachableSummary([{ repo: repo("acme/a"), reason: "`acme/a` is not there." }]);
  assert.equal(one, "`acme/a` is not there.");

  const two = unreachableSummary([
    { repo: repo("acme/a"), reason: "`acme/a` is not there." },
    { repo: repo("acme/b"), reason: "`acme/b` is not there either." },
  ]);
  assert.equal(two, "`acme/a` is not there. `acme/b` is not there either.");
});

/**
 * Ranking for the `/brainstorm repo:` autocomplete.
 *
 * The point is that a human should not be able to type a repo that does not exist, so the
 * ranking has to be forgiving in exactly the way the incident was: `allchat` must find
 * `all-chat` while it is still being typed.
 */
const CATALOG = [
  "caesarakalaeii/Caterpillar",
  "caesarakalaeii/all-chat",
  "caesarakalaeii/all-chat-extension",
  "caesarakalaeii/caesar-deployment",
  "caesarakalaeii/streamer-shield",
];

test("no query yet lists the catalog, so the box is never empty", () => {
  // An empty suggestion list is indistinguishable from a broken bot. The first keystroke
  // is `owner/…` for every repo, so there is nothing to narrow on yet.
  assert.deepEqual(rankRepos("", CATALOG, 3), [
    "caesarakalaeii/Caterpillar",
    "caesarakalaeii/all-chat",
    "caesarakalaeii/all-chat-extension",
  ]);
});

test("the separator the human omits does not hide the repo they meant", () => {
  assert.deepEqual(rankRepos("allchat", CATALOG), [
    "caesarakalaeii/all-chat",
    "caesarakalaeii/all-chat-extension",
  ]);
});

test("a prefix beats a match in the middle of a name", () => {
  const ranked = rankRepos("cat", CATALOG);
  assert.equal(ranked[0], "caesarakalaeii/Caterpillar", ranked.join(", "));
});

test("the owner is searchable too, and case never matters", () => {
  assert.deepEqual(rankRepos("CAESARAKALAEII/STREAMER", CATALOG), [
    "caesarakalaeii/streamer-shield",
  ]);
});

test("a typo still finds it, and a different word finds nothing", () => {
  assert.deepEqual(rankRepos("all-chta", CATALOG), ["caesarakalaeii/all-chat"]);
  assert.deepEqual(rankRepos("tractor", CATALOG), []);
});

test("the list is capped, because Discord rejects more than 25 choices", () => {
  const many = Array.from({ length: 60 }, (_, index) => `acme/repo-${index}`);
  assert.equal(rankRepos("repo", many).length, 25);
});
