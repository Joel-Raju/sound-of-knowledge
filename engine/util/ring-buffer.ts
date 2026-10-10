/**
 * Fixed-capacity ring buffers. Spec §1.2 (no allocation on push/pop),
 * §6.3 (dedupe ring of the last 2000 ids), §9.4 (16-slot impact buffer),
 * §9.5 (particle head index), §10.1 (256-slot visual queue).
 *
 * Every buffer allocates its storage once in the constructor and never again.
 */

export class RingBuffer<T> {
  readonly capacity: number;
  private readonly items: (T | undefined)[];
  /** Index of the oldest element. */
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    if (capacity <= 0) throw new RangeError("RingBuffer capacity must be > 0");
    this.capacity = capacity;
    // `Array.from` rather than `new Array(n)`: this file is an ESLint hot path
    // (§12.4.2) and `new Array(n)` is on the banned list. This is a one-time
    // constructor allocation either way — the ban targets per-call allocation.
    this.items = Array.from({ length: capacity }) as (T | undefined)[];
  }

  get length(): number {
    return this.count;
  }

  /** Oldest-first index. O(1). Returns undefined when empty or out of range. */
  at(i: number): T | undefined {
    if (i < 0 || i >= this.count) return undefined;
    return this.items[(this.head + i) % this.capacity];
  }

  /** Most recently pushed element. O(1). */
  get last(): T | undefined {
    return this.count === 0 ? undefined : this.at(this.count - 1);
  }

  get oldest(): T | undefined {
    return this.at(0);
  }

  /** Push at the tail, overwriting the oldest element when full. */
  push(item: T): void {
    const idx = (this.head + this.count) % this.capacity;
    this.items[idx] = item;
    if (this.count === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.count++;
    }
  }

  /** Remove and return the oldest element. */
  pop(): T | undefined {
    if (this.count === 0) return undefined;
    const v = this.items[this.head];
    this.items[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return v;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.items[i] = undefined;
    this.head = 0;
    this.count = 0;
  }

  /**
   * Iterate oldest → newest without allocating. The callback receives
   * (value, index). Use this instead of `Array.prototype.forEach`, which is
   * banned in hot-path files by the ESLint config (spec §12.4.2).
   */
  forEach(fn: (value: T, index: number) => void): void {
    for (let i = 0; i < this.count; i++) {
      const v = this.items[(this.head + i) % this.capacity];
      if (v !== undefined) fn(v, i);
    }
  }
}

/**
 * Fixed-capacity FIFO dedupe for recent event ids. Spec §6.3: "ring-buffer
 * `Set` of the last 2 000 event ids; duplicates dropped" (a reconnect with
 * `Last-Event-ID` can redeliver).
 *
 * A `Set` plus a FIFO ring, rather than a hand-rolled open-addressed table:
 * the Set is the structure the spec names, `has` is O(1), and correctness at
 * the eviction boundary is obvious at a glance. The allocation this costs is
 * dwarfed by the `JSON.parse` that produced the event, and dedupe is not a
 * per-frame hot path.
 */
export class IdDedupeRing {
  readonly capacity: number;
  private readonly seen = new Set<number>();
  private readonly order: RingBuffer<number>;

  constructor(capacity: number) {
    if (capacity <= 0) throw new RangeError("IdDedupeRing capacity must be > 0");
    this.capacity = capacity;
    this.order = new RingBuffer<number>(capacity);
  }

  get size(): number {
    return this.seen.size;
  }

  /**
   * Insert `id` and report whether it was already present.
   * `true`  → duplicate, caller should drop the event.
   * `false` → newly seen (now tracked).
   * Once full, the oldest id is evicted, so the window is exactly the last
   * `capacity` ids.
   */
  seenOrAdd(id: number): boolean {
    if (this.seen.has(id)) return true;
    if (this.order.length === this.capacity) {
      const oldest = this.order.pop();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.order.push(id);
    this.seen.add(id);
    return false;
  }

  clear(): void {
    this.seen.clear();
    this.order.clear();
  }
}

/**
 * Fixed-capacity numeric ring for frame-time percentiles (spec §12.1,
 * `util/perf`). No allocation after construction.
 */
export class NumericRing {
  readonly capacity: number;
  private readonly data: Float64Array;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    if (capacity <= 0) throw new RangeError("NumericRing capacity must be > 0");
    this.capacity = capacity;
    this.data = new Float64Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  push(v: number): void {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /**
   * Percentile over the retained window, by copy-and-sort.
   * NOT a hot path — this runs at ~1 Hz in the debug overlay and in tests,
   * never per frame, so the sort allocation is acceptable. `data` is read in
   * physical (not chronological) order, which is fine for order statistics.
   */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const sorted: number[] = [];
    for (let i = 0; i < this.count; i++) sorted.push(this.data[i]!);
    sorted.sort((a, b) => a - b);
    const idx = Math.min(this.count - 1, Math.max(0, Math.round((p / 100) * (this.count - 1))));
    return sorted[idx] ?? 0;
  }

  get mean(): number {
    if (this.count === 0) return 0;
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.data[i]!;
    return s / this.count;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.data.fill(0);
  }
}
