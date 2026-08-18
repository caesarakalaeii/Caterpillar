import assert from "node:assert/strict";
import { test } from "node:test";
import { nearestName, nearestSlug, unreachableSummary } from "./reach.ts";

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
