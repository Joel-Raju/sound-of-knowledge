/**
 * NDJSON replay source. Spec §6.7.
 *
 * Each line is `{"dt": <ms since previous>, "e": <NormalizedEdit minus dedupe
 * fields>}`. The recording loops forever, and **fresh, monotonically increasing
 * ids are assigned on every pass** — otherwise the ingest dedupe ring
 * (spec §6.3) would drop the entire second lap and the stream would go silent.
 *
 * The replay file is a bundled fallback for when the live stream is
 * unavailable (spec §6.6), so it must exercise the same
 * filter → sampler → batch path as live traffic.
 */
import type { NormalizedEdit } from "../types";

/** On-disk shape: `dt` is the gap from the previous line, in ms. */
export interface ReplayLine {
  dt: number;
  e: Omit<NormalizedEdit, "id" | "ts" | "wiki"> & { id?: number; ts?: number };
}

export type ReplayFetch = (url: string) => Promise<string>;

export class ReplaySource {
  private readonly lines: ReplayLine[];
  private readonly url: string;
  private readonly fetchText: ReplayFetch;
  private cursor = 0;
  private pending = 0; // ms of `dt` still to elapse
  private nextId = 1;
  private baseTs: number;

  private constructor(lines: ReplayLine[], url: string, fetchText: ReplayFetch, startTs: number) {
    this.lines = lines;
    this.url = url;
    this.fetchText = fetchText;
    this.baseTs = startTs;
  }

  static async load(
    url: string,
    fetchText: ReplayFetch,
    startTs = 1_790_000_000_000,
  ): Promise<ReplaySource> {
    const text = await fetchText(url);
    return ReplaySource.fromText(text, url, fetchText, startTs);
  }

  /** Parse NDJSON. Blank lines and malformed lines are skipped, not fatal. */
  static fromText(
    text: string,
    url = "inline",
    fetchText: ReplayFetch = async () => text,
    startTs = 1_790_000_000_000,
  ): ReplaySource {
    const lines: ReplayLine[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length === 0) continue;
      let parsed: ReplayLine;
      try {
        parsed = JSON.parse(line) as ReplayLine;
      } catch {
        continue; // a corrupt line must not kill the replay
      }
      if (typeof parsed?.dt !== "number" || typeof parsed.e !== "object" || parsed.e === null) {
        continue;
      }
      lines.push(parsed);
    }
    return new ReplaySource(lines, url, fetchText, startTs);
  }

  get length(): number {
    return this.lines.length;
  }

  get loopCount(): number {
    return this.cursor;
  }

  /** Advance by `dtMs`; return whatever events fall in that window. */
  next(dtMs: number): NormalizedEdit[] {
    const out: NormalizedEdit[] = [];
    let remaining = dtMs;

    while (remaining > 0 && this.lines.length > 0) {
      if (this.cursor >= this.lines.length) {
        // Lap: rewind and keep ids climbing so dedupe cannot suppress the replay.
        this.cursor = 0;
        this.pending = 0;
      }
      const line = this.lines[this.cursor]!;
      const dt = Math.max(0, line.dt);

      if (dt > 0 && this.pending === 0) {
        this.pending = dt;
      }
      if (this.pending > 0) {
        const consume = Math.min(remaining, this.pending);
        this.pending -= consume;
        remaining -= consume;
        if (this.pending > 0) return out; // gap spans the whole window
      } else {
        remaining -= 1; // zero-gap line: emit immediately
      }

      out.push(this.materialize(line));
      this.cursor++;
    }

    return out;
  }

  /**
   * Turn a stored line into a `NormalizedEdit` with a **fresh id** and a
   * rebased timestamp, so every lap is distinct and dedupe-safe.
   */
  private materialize(line: ReplayLine): NormalizedEdit {
    const e = line.e as NormalizedEdit;
    return {
      ...e,
      id: this.nextId++,
      ts: this.baseTs + Math.round(this.nextId),
    };
  }
}
