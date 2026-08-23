/**
 * Which Discord message belongs to which task. See DESIGN.md §7.3.
 *
 * Not yet implemented — the tests in `bridge.test.ts` state what it must do.
 */
import type { TaskId } from "../domain/task.ts";

export const MAX_REMEMBERED_MESSAGES = 4096;

export class MessageIndex {
  record(_messageId: string, _task: TaskId): void {
    throw new Error("not implemented");
  }

  taskFor(_messageId: string): TaskId | undefined {
    throw new Error("not implemented");
  }

  get size(): number {
    throw new Error("not implemented");
  }
}
