export interface BufferedEvent {
  json: string;
  bytes: number;
}

/** Bounded FIFO. When full, the OLDEST events are dropped and counted. */
export class EventBuffer {
  private items: BufferedEvent[] = [];
  dropped = 0;

  constructor(private readonly maxSize: number) {}

  get length(): number {
    return this.items.length;
  }

  push(item: BufferedEvent): void {
    this.items.push(item);
    this.trim();
  }

  /** Remove up to maxEvents / maxBytes from the front (always at least one event). */
  take(maxEvents: number, maxBytes: number): BufferedEvent[] {
    let bytes = 0;
    let count = 0;
    while (count < this.items.length && count < maxEvents) {
      const next = this.items[count].bytes;
      if (count > 0 && bytes + next > maxBytes) break;
      bytes += next;
      count++;
    }
    return this.items.splice(0, count);
  }

  /** Put a failed batch back at the front, keeping order. Overflow drops the oldest. */
  requeueFront(items: BufferedEvent[]): void {
    this.items = items.concat(this.items);
    this.trim();
  }

  private trim(): void {
    const excess = this.items.length - this.maxSize;
    if (excess > 0) {
      this.items.splice(0, excess);
      this.dropped += excess;
    }
  }
}
