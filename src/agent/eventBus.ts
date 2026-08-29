import { EventEmitter } from "node:events";
import type { EventRecord } from "../db/database.js";

export class SessionEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  publish(sessionId: string, event: EventRecord): void {
    this.emitter.emit(`session:${sessionId}`, event);
  }

  subscribe(sessionId: string, listener: (event: EventRecord) => void): () => void {
    const channel = `session:${sessionId}`;
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }
}

export const eventBus = new SessionEventBus();
