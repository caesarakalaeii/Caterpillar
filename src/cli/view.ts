/**
 * `caterpillar-view` — the aggregating read-only viewer (DESIGN.md §18).
 *
 *   node dist/cli/view.js
 *
 * A second `command` on the image the fleet already runs, not a second image: `dist/` is
 * copied whole, so this costs a Deployment manifest and nothing else. It holds no
 * state-repo credential, no forge token, no provider credential, no PVC and no
 * ServiceAccount token — strictly less privilege than the process serving that page today.
 */
import { JsonLogger, errorFields } from "../obs/log.ts";
import { run } from "../view/main.ts";

const die = (event: string, error: unknown): never => {
  new JsonLogger().error(event, errorFields(error));
  process.exit(1);
};

process.on("uncaughtException", (error) => die("view.uncaught", error));
process.on("unhandledRejection", (reason) => die("view.unhandled-rejection", reason));

run().then(
  () => process.exit(0),
  (error: unknown) => die("view.boot-failed", error),
);
