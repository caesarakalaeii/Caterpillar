import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAnswer, parseRepoPath, parseRequest } from "./protocol.ts";

test("parses git's key=value block and ignores unknown keys", () => {
  const request = parseRequest(
    ["protocol=https", "host=github.com", "path=caesarakalaeii/Caterpillar.git", "wildcard=x", ""].join("\n"),
  );
  assert.deepEqual(request, {
    protocol: "https",
    host: "github.com",
    path: "caesarakalaeii/Caterpillar.git",
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
  assert.deepEqual(parseRepoPath("caesarakalaeii/Caterpillar.git"), {
    owner: "caesarakalaeii",
    name: "Caterpillar",
  });
  assert.deepEqual(parseRepoPath("ElectricBoogaloo/eb-api"), {
    owner: "ElectricBoogaloo",
    name: "eb-api",
  });
});

test("refuses to guess when the path is missing or malformed", () => {
  // Returning undefined matters: a guess here could hand a token for one repo to a
  // push aimed at another.
  assert.equal(parseRepoPath(undefined), undefined);
  assert.equal(parseRepoPath(""), undefined);
  assert.equal(parseRepoPath("Caterpillar.git"), undefined);
});
