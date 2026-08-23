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

  submit(sessionId: string, prompt: string): void {
    this.interrupt(sessionId);
    const model = this.getSessionModel(sessionId);

    const controller = new AbortController();
    const promise = harness.runAutonomousLoop(sessionId, prompt, controller.signal, model).finally(() => {
      if (this.activeTasks.get(sessionId)?.controller === controller) {
        this.activeTasks.delete(sessionId);
      }
    });

    this.activeTasks.set(sessionId, { controller, promise });
  }

  regenerate(sessionId: string): void {
    this.interrupt(sessionId);
    const model = this.getSessionModel(sessionId);

    const controller = new AbortController();
    const promise = harness.runAssistantTurn(sessionId, controller.signal, model).finally(() => {
      if (this.activeTasks.get(sessionId)?.controller === controller) {
        this.activeTasks.delete(sessionId);
      }
    });

    this.activeTasks.set(sessionId, { controller, promise });
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
