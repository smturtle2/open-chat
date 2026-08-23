import { harness } from "./harness.js";
import { db } from "../db/database.js";
import { CONFIG } from "../config.js";

type TaskEntry = {
  controller: AbortController;
  promise: Promise<void>;
};

export class SessionCoordinator {
  private activeTasks = new Map<string, TaskEntry>();

  private getSessionModel(sessionId: string): string {
    const session = db.getSession(sessionId);
    return session?.model || CONFIG.LLM_MODEL;
  }

  // Interrupts the active/queued task (if any) and returns its promise so a
  // replacement task can wait for the old loop to fully stop before touching
  // shared state (messages, truncation, containers). Prevents two loops from
  // writing to one session concurrently.
  private replaceTask(sessionId: string): Promise<void> {
    const entry = this.activeTasks.get(sessionId);
    if (!entry) return Promise.resolve();
    entry.controller.abort();
    this.activeTasks.delete(sessionId);
    return entry.promise.catch(() => undefined);
  }

  submit(sessionId: string, prompt: string, attachmentIds: string[] = []): void {
    const previous = this.replaceTask(sessionId);
    const model = this.getSessionModel(sessionId);

    const controller = new AbortController();
    const task: TaskEntry = { controller, promise: null as unknown as Promise<void> };
    task.promise = previous.then(() => {
      // Superseded again while waiting for the old run to drain.
      if (controller.signal.aborted) return undefined;
      return harness.runAutonomousLoop(sessionId, prompt, controller.signal, model, attachmentIds) as Promise<void>;
    }).finally(() => {
      if (this.activeTasks.get(sessionId) === task) this.activeTasks.delete(sessionId);
    });
    this.activeTasks.set(sessionId, task);
  }

  regenerate(sessionId: string): void {
    this.regenerateFrom(sessionId, null, null);
  }

  // Atomic edit/regenerate: waits for any running loop to drain BEFORE
  // mutating message history, then starts the assistant turn. Passing
  // newContent edits the target user message; null keeps it intact.
  regenerateFrom(sessionId: string, messageId: string | null, newContent: string | null): void {
    const previous = this.replaceTask(sessionId);
    const model = this.getSessionModel(sessionId);

    const controller = new AbortController();
    const task: TaskEntry = { controller, promise: null as unknown as Promise<void> };
    task.promise = previous.then(() => {
      if (controller.signal.aborted) return undefined;
      if (messageId && newContent !== null) {
        db.updateMessageContent(sessionId, messageId, newContent);
      }
      if (messageId) {
        db.truncateAfterMessage(sessionId, messageId);
      }
      return harness.runAssistantTurn(sessionId, controller.signal, model) as Promise<void>;
    }).finally(() => {
      if (this.activeTasks.get(sessionId) === task) this.activeTasks.delete(sessionId);
    });
    this.activeTasks.set(sessionId, task);
  }

  interrupt(sessionId: string): boolean {
    const entry = this.activeTasks.get(sessionId);
    if (entry) {
      entry.controller.abort();
      this.activeTasks.delete(sessionId);
      return true;
    }
    return false;
  }

  isRunning(sessionId: string): boolean {
    return this.activeTasks.has(sessionId);
  }
}

export const coordinator = new SessionCoordinator();
