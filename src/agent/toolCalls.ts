import crypto from "node:crypto";
import type { NormalizedStreamEvent } from "./protocols.js";

type Delta = NonNullable<NormalizedStreamEvent["toolCall"]>;
export type StreamingToolCall = { id: string; name: string; arguments: string };

/** Wire indexes include text/reasoning items; they are not array positions. */
export class ToolCallAssembler {
  private calls: StreamingToolCall[] = [];
  private byIndex = new Map<number, StreamingToolCall>();
  private byId = new Map<string, StreamingToolCall>();

  add(delta: Delta): void {
    const ids = [delta.id, delta.itemId].filter((id): id is string => !!id);
    let call = ids.map((id) => this.byId.get(id)).find(Boolean)
      ?? (delta.index !== undefined ? this.byIndex.get(delta.index) : undefined);
    // Unindexed deltas can only unambiguously refer to one existing call.
    if (!call && delta.index === undefined && ids.length === 0 && this.calls.length === 1) call = this.calls[0];
    if (!call) {
      call = { id: delta.id || `call_${crypto.randomUUID()}`, name: "", arguments: "" };
      this.calls.push(call);
    }
    if (delta.id) call.id = delta.id;
    if (delta.name) call.name = delta.name;
    if (delta.argumentsDelta) call.arguments += delta.argumentsDelta;
    if (delta.index !== undefined) this.byIndex.set(delta.index, call);
    for (const id of ids) this.byId.set(id, call);
  }

  values(): StreamingToolCall[] { return this.calls; }
}
