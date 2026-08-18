import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { capabilitiesSatisfy, KNOWN_CAPABILITIES, type Capability } from "./task.ts";

/**
 * The shell installer cannot import the enum, so it carries a fourth copy. A capability
 * that exists here and not there is refused by `--capabilities` and the machine never gets
 * installed; one that exists there and not here starts a runner that config loading then
 * rejects at boot. Both are silent until someone tries to add a machine, which is exactly
 * when nobody wants to debug a list.
 */
test("install-runner.sh advertises the same capabilities the code knows", async () => {
  const script = fileURLToPath(new URL("../../scripts/install-runner.sh", import.meta.url));
  const source = await readFile(script, "utf8");

  const match = /^KNOWN_CAPABILITIES="([^"]*)"$/m.exec(source);
  assert.ok(match !== null, "install-runner.sh has no KNOWN_CAPABILITIES= line to check");

  assert.deepEqual(
    match[1]?.split(" ").filter((entry) => entry.length > 0),
    [...KNOWN_CAPABILITIES],
  );
});

test("capabilitiesSatisfy is subset containment, not equality", () => {
  const runner: readonly Capability[] = ["linux", "gpu", "usb"];

  assert.ok(capabilitiesSatisfy(runner, []));
  assert.ok(capabilitiesSatisfy(runner, ["gpu"]));
  assert.ok(capabilitiesSatisfy(runner, ["linux", "usb"]));
  assert.ok(!capabilitiesSatisfy(runner, ["k8s"]));
  assert.ok(!capabilitiesSatisfy(runner, ["gpu", "human-present"]));
});
