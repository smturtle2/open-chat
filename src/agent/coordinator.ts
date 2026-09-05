import crypto from "node:crypto";
import { harness } from "./harness.js";
import { db, type RunOutcome } from "../db/database.js";
import { CONFIG } from "../config.js";

type TaskEntry = { runId: string; controller: AbortController; promise: Promise<void> };

export class SessionCoordinator {
  private activeTasks = new Map<string, TaskEntry>();

  private requestStop(sessionId: string, entry: TaskEntry): void {
    if (entry.controller.signal.aborted) return;
    db.setRunStatus(entry.runId, "stopping");
    db.appendEvent(sessionId, "run_stopping", {}, entry.runId);
    entry.controller.abort();
  }

  private schedule(sessionId: string, execute: (signal: AbortSignal, runId: string) => Promise<RunOutcome>): string {
    if (!db.getSession(sessionId)) throw new Error("Session not found");
    const previous = this.activeTasks.get(sessionId);
    if (previous) this.requestStop(sessionId, previous);
    const runId = "run_" + crypto.randomUUID();
    db.createRun(runId, sessionId);
    const controller = new AbortController();
    const entry: TaskEntry = { runId, controller, promise: Promise.resolve() };
    entry.promise = (previous?.promise ?? Promise.resolve()).then(async () => {
      let outcome: RunOutcome = "interrupted";
      try {
        if (!controller.signal.aborted) {
          db.setRunStatus(runId, "running");
          db.appendEvent(sessionId, "run_started", {}, runId);
          outcome = await execute(controller.signal, runId);
        }
      } catch (error: any) {
        outcome = controller.signal.aborted ? "interrupted" : "failed";
        if (outcome === "failed") db.appendEvent(sessionId, "error", { message: error?.message || "Task failed" }, runId);
      } finally {
        db.finishRun(sessionId, runId, controller.signal.aborted ? "interrupted" : outcome);
      }
    }).finally(() => {
      if (this.activeTasks.get(sessionId) === entry) this.activeTasks.delete(sessionId);
    });
    this.activeTasks.set(sessionId, entry);
    return runId;
  }

  submit(sessionId: string, prompt: string, attachmentIds: string[] = [], clientMsgId?: string): string {
    const model = db.getSession(sessionId)?.model || CONFIG.LLM_MODEL;
    return this.schedule(sessionId, (signal, runId) =>
      harness.runAutonomousLoop(sessionId, prompt, signal, model, attachmentIds, clientMsgId, runId));
  }

  regenerate(sessionId: string): void {
    const message = db.getMessages(sessionId).filter((m) => m.role === "user").pop();
    if (message) this.regenerateFrom(sessionId, message.id, null);
  }

  regenerateFrom(sessionId: string, messageId: string | null, newContent: string | null): string {
    const model = db.getSession(sessionId)?.model || CONFIG.LLM_MODEL;
    return this.schedule(sessionId, (signal, runId) => {
      if (messageId && newContent !== null) db.updateMessageContent(sessionId, messageId, newContent);
      if (messageId) db.truncateAfterMessage(sessionId, messageId);
      return harness.runAssistantTurn(sessionId, signal, model, runId);
    });
  }

  interrupt(sessionId: string): boolean {
    const entry = this.activeTasks.get(sessionId);
    if (!entry) return false;
    this.requestStop(sessionId, entry);
    // Retain the promise: a new submit/delete must await cleanup even after Stop.
    return true;
  }

  async interruptAndWait(sessionId: string): Promise<boolean> {
    const entry = this.activeTasks.get(sessionId);
    if (!entry) return false;
    this.requestStop(sessionId, entry);
    await entry.promise;
    return true;
  }

  isRunning(sessionId: string): boolean { return this.activeTasks.has(sessionId); }
}

export const coordinator = new SessionCoordinator();
