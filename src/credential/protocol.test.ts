import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAnswer, parseInvocation, parseRepoPath, parseRequest } from "./protocol.ts";

test("parses git's key=value block and ignores unknown keys", () => {
  const request = parseRequest(
    ["protocol=https", "host=github.com", "path=acme/Caterpillar.git", "wildcard=x", ""].join("\n"),
  );
  assert.deepEqual(request, {
    protocol: "https",
    host: "github.com",
    path: "acme/Caterpillar.git",
  });
});

test("tolerates a value containing '='", () => {
  const request = parseRequest("host=github.com\nusername=a=b\n");
  assert.equal(request.username, "a=b");
});

test("formats the answer git expects, terminated by a blank line", () => {
  const output = formatAnswer({ username: "x-access-token", password: "ghs_secret" });
  assert.equal(output, "username=x-access-token\npassword=ghs_secret\n\n");
});

test("extracts owner and name from a repo path", () => {
  assert.deepEqual(parseRepoPath("acme/Caterpillar.git"), {
    owner: "acme",
    name: "Caterpillar",
  });
  assert.deepEqual(parseRepoPath("Acme/acme-api"), {
    owner: "Acme",
    name: "acme-api",
  });
});

test("refuses to guess when the path is missing or malformed", () => {
  // Returning undefined matters: a guess here could hand a token for one repo to a
  // push aimed at another.
  assert.equal(parseRepoPath(undefined), undefined);
  assert.equal(parseRepoPath(""), undefined);
  assert.equal(parseRepoPath("Caterpillar.git"), undefined);
});

test("reads the operation from the END of argv, where git puts it", () => {
  // The bug this pins: git appends the operation after the configured helper
  // arguments, so the real invocation is `--socket <path> get`. The old
  // "first argument that is not a flag" rule returned the SOCKET PATH, the `=== "get"`
  // gate never matched, and the helper declined every request in silence — while the
  // suite passed, because it called the helper as `get --socket <path>`.
  assert.deepEqual(parseInvocation(["--socket", "/run/caterpillar/cred.sock", "get"]), {
    operation: "get",
    socketPath: "/run/caterpillar/cred.sock",
  });
});

test("parses the operation whichever side of --socket it lands on", () => {
  for (const argv of [
    ["get", "--socket", "/s.sock"],
    ["--socket", "/s.sock", "get"],
  ]) {
    assert.deepEqual(parseInvocation(argv), { operation: "get", socketPath: "/s.sock" });
  }
});

test("reports a missing socket or operation rather than inventing one", () => {
  assert.deepEqual(parseInvocation(["get"]), { operation: "get", socketPath: undefined });
  assert.deepEqual(parseInvocation(["--socket", "/s.sock"]), {
    operation: undefined,
    socketPath: "/s.sock",
  });
  assert.deepEqual(parseInvocation([]), { operation: undefined, socketPath: undefined });
});

test("store and erase are distinguishable from get", () => {
  // They must stay no-ops: nothing is cached on disk, so silently treating them as
  // `get` would mint a token for no reason on every push.
  assert.equal(parseInvocation(["--socket", "/s.sock", "store"]).operation, "store");
  assert.equal(parseInvocation(["--socket", "/s.sock", "erase"]).operation, "erase");
});
