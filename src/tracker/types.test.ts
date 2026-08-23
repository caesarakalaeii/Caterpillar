import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CANDIDATE_LABEL } from "./types.ts";

test("the candidate label is not a label listAgentItems would pick up", () => {
  // Self-amplifying failure mode: if filing a report applied the ingest label, the
  // report would be minted into a running task on the next intake pass, which could
  // file another report. `agent-candidate` waits for a human to relabel it `agent`.
  assert.equal(DEFAULT_CANDIDATE_LABEL, "agent-candidate");
  assert.notEqual(DEFAULT_CANDIDATE_LABEL, "agent");
});
