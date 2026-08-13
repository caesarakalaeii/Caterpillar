import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStateRepoUrl, tokenGitEnv } from "./credential.ts";
import { Git } from "./git.ts";

test("a state repo URL parses into a repo ref", () => {
  assert.deepEqual(parseStateRepoUrl("https://github.com/caesarakalaeii/caterpillar-state.git"), {
    host: "github.com",
    owner: "caesarakalaeii",
    name: "caterpillar-state",
  });
  assert.deepEqual(parseStateRepoUrl("https://github.com/o/n"), {
    host: "github.com",
    owner: "o",
    name: "n",
  });
});

test("an ssh state repo URL is refused", () => {
  // The token authenticates as an HTTP header. Over ssh git would ignore it and fall
  // back to whatever key the host has — on a machine runner, the operator's own.
  assert.throws(
    () => parseStateRepoUrl("git@github.com:caesarakalaeii/caterpillar-state.git"),
    /must be https/,
  );
});

test("the token rides in git config env, not in argv or on disk", () => {
  const env = tokenGitEnv("ghs_example");

  assert.equal(env["GIT_CONFIG_COUNT"], "1");
  assert.equal(env["GIT_CONFIG_KEY_0"], "http.extraheader");
  assert.equal(
    env["GIT_CONFIG_VALUE_0"],
    `Authorization: Basic ${Buffer.from("x-access-token:ghs_example").toString("base64")}`,
  );
  // A prompt would hang the supervisor on a terminal that does not exist.
  assert.equal(env["GIT_TERMINAL_PROMPT"], "0");
});

test("the credential does not follow git into another checkout", async () => {
  // Load-bearing: `http.extraHeader` is sent on EVERY http request git makes, so a
  // state-repo GitHub token inherited into a task worktree would be handed to
  // Codeberg on the next push.
  let provided = 0;
  const git = new Git(process.cwd(), process.env, async () => {
    provided += 1;
    return tokenGitEnv("ghs_example");
  });

  await git.run("rev-parse", "--git-dir");
  assert.equal(provided, 1);

  await git.at(process.cwd()).run("rev-parse", "--git-dir");
  assert.equal(provided, 1, "at() must not carry the credential provider");
});
