import {
  executionEventSchema,
  type ExecutionEvent,
} from "../../application/contracts/agent-execution.js";

export type ExecutionEventDraft = ExecutionEvent extends infer E
  ? E extends ExecutionEvent
    ? Omit<E, "sequence">
    : never
  : never;

/** Bounded, replayable progress stream. The terminal event always has a reserved slot. */
export class ExecutionEventStream {
  private readonly buffer: ExecutionEvent[] = [];
  private readonly waiters: (() => void)[] = [];
  private finished = false;

  publish(draft: ExecutionEventDraft): void {
    if (this.finished || this.buffer.length >= 9999) return;
    this.buffer.push(executionEventSchema.parse({ ...draft, sequence: this.buffer.length }));
    this.wake();
  }

  finish(outcome: string): void {
    if (this.finished) return;
    this.buffer.push({ kind: "finished", sequence: this.buffer.length, outcome });
    this.finished = true;
    this.wake();
  }

  async *replay(): AsyncGenerator<ExecutionEvent, void> {
    let index = 0;
    for (;;) {
      while (index < this.buffer.length) {
        const event = this.buffer[index];
        index += 1;
        if (event !== undefined) yield event;
      }
      if (this.finished) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}
