/**
 * Deterministic synthetic edit stream. Spec §6.7.
 *
 * Modelled on the live Wikimedia `recentchange` shape, and used for three
 * things: the `?source=synthetic` URL mode, the bundled replay recording, and
 * every automated test that needs traffic without a network.
 *
 * Determinism is the point: the same seed must produce the same events in Node,
 * in the worker, and in a browser, or the offline audio harness (§13.3) and the
 * unit tests cannot assert anything.
 */
import {
  SYNTH_ABSDELTA_HI,
  SYNTH_ABSDELTA_LO,
  SYNTH_ANON_P,
  SYNTH_BOT_P,
  SYNTH_BURST_HI,
  SYNTH_BURST_LO,
  SYNTH_BURST_PROB,
  SYNTH_BURST_SPREAD_SEC,
  SYNTH_BASE_RATE,
  SYNTH_LANGS,
  SYNTH_LOGNORMAL_MU,
  SYNTH_LOGNORMAL_SIGMA,
  SYNTH_NEW_P,
  SYNTH_POSITIVE_P,
  SYNTH_RATE_AMP,
  SYNTH_RATE_PERIOD_SEC,
  SYNTH_REVERT_NEGATIVE_P,
  SYNTH_REVERT_P,
  SYNTH_ZIPF_S,
} from "../config";
import { classifyActor, magnitudeOf, importanceOf, normalizeTitle, parseHost } from "./normalize";
import { logNormal, mulberry32, pick, type Rng } from "../util/random";
import type { Actor, EditKind, NormalizedEdit } from "../types";

/** Spec §6.7 — built-in pool of plausible article titles. */
export const SYNTH_TITLES: readonly string[] = [
  "Albert_Einstein",
  "Photosynthesis",
  "Mount_Everest",
  "Chess",
  "Jazz",
  "Sushi",
  "Black_hole",
  "Evolution",
  "Quantum_mechanics",
  "Roman_Empire",
  "Internet",
  "Coffee",
  "Climate_change",
  "Armstrong_Ludwig",
  "DNA",
  "Antarctica",
  "Music",
  "Mathematics",
  "Philosophy",
  "Linguistics",
  "Architecture",
  "Olympics",
  "Basketball",
  "Football",
  "Baseball",
  "Tennis",
  "Cycling",
  "Swimming",
  "Painting",
  "Sculpture",
  "Poetry",
  "Novel",
  "Theatre",
  "Cinema",
  "Photography",
  "Television",
  "Radio",
  "Journalism",
  "Publishing",
  "Library",
  "Museum",
  "University",
  "Education",
  "Engineering",
  "Physics",
  "Chemistry",
  "Biology",
  "Astronomy",
  "Geology",
  "Meteorology",
  "Oceanography",
  "Ecology",
  "Zoology",
  "Botany",
  "Mycology",
  "Entomology",
  "Ornithology",
  "Ichthyology",
  "Anatomy",
  "Physiology",
  "Neurology",
  "Psychology",
  "Philosophy_of_mind",
  "Sociology",
  "Anthropology",
  "Economics",
  "Political_science",
  "International_law",
  "Diplomacy",
  "Military_history",
  "Navy",
  "Army",
  "Air_force",
  "Aviation",
  "Railway",
  "Road_transport",
  "Shipping",
  "Maritime_history",
  "Astronautics",
  "Space_exploration",
  "Telescope",
  "Satellite",
  "Rocket",
  "Nuclear_physics",
  "Particle_physics",
  "Astrophysics",
  "Cosmology",
  "Galaxies",
  "Solar_System",
  "Moon",
  "Mars",
  "Venus",
  "Jupiter",
  "Saturn",
  "Mercury",
  "Neptune",
  "Uranus",
  "Pluto",
  "Comet",
  "Meteor",
  "Aurora",
  "Rainbow",
  "Aurora_borealis",
  "Desert",
  "Rainforest",
  "Glacier",
  "Volcano",
  "Earthquake",
  "Tsunami",
  "Hurricane",
  "Tornado",
  "Lightning",
  "Thunderstorm",
  "River",
  "Lake",
  "Mountain",
  "Valley",
  "Canyon",
  "Waterfall",
  "Island",
  "Coral_reef",
  "Whale",
  "Dolphin",
  "Shark",
  "Octopus",
  "Penguin",
  "Eagle",
  "Owl",
  "Wolf",
  "Bear",
  "Elephant",
  "Giraffe",
  "Tiger",
  "Butterfly",
  "Bee",
  "Ant",
  "Spider",
  "Snake",
  "Turtle",
  "Frog",
  "Salmon",
  "Eagle",
  "Migration",
  "Metallurgy",
  "Textile",
  "Weaving",
  "Pottery",
  "Glassmaking",
  "Blacksmith",
  "Carpentry",
  "Masonry",
  "Plumbing",
  "Electricity",
  "Magnetism",
  "Radioactivity",
  "Fission",
  "Fusion",
  "Solar_power",
  "Wind_power",
  "Nuclear_power",
  "Petroleum",
  "Coal",
  "Natural_gas",
  "Renewable_energy",
  "Recycling",
  "Plastic_pollution",
  "Deforestation",
  "Conservation",
  "Endangered_species",
  "Biodiversity",
  "Eclipse",
  "Tide",
  "Seismology",
  "Petrology",
  "Mineralogy",
  "Gemstone",
  "Diamond",
  "Gold",
  "Silver",
  "Iron",
  "Steel",
  "Aluminium",
  "Copper",
  "Titanium",
  "Silicon",
  "Semiconductor",
  "Transistor",
  "Integrated_circuit",
  "Microprocessor",
  "Computer",
  "Algorithm",
  "Programming_language",
  "Operating_system",
  "Database",
  "Cryptography",
  "Computer_graphics",
  "Artificial_intelligence",
  "Machine_learning",
  "Neural_network",
  "Robotics",
  "Satellite_navigation",
  "Telescope",
  "Observatory",
  "Planetarium",
  "Biodiversity",
  "Vaccine",
  "Antibiotic",
  "Immune_system",
  "Virus",
  "Bacteria",
  "Epidemiology",
  "Public_health",
  "Mental_health",
  "Nutrition",
  "Sleep",
  "Exercise",
  "Human_anatomy",
  "Human_evolution",
  "Primatology",
  "Ethology",
];

const PROJECT_FOR_LANG = (lang: string): string =>
  lang === "wikidata" ? "www.wikidata.org" : `${lang}.wikipedia.org`;

/** Spec §6.7 — Zipf(s = 1.1) probability per language rank. */
const zipfWeights: number[] = (() => {
  const w: number[] = [];
  let total = 0;
  for (let i = 0; i < SYNTH_LANGS.length; i++) {
    const v = 1 / Math.pow(i + 1, SYNTH_ZIPF_S);
    w.push(v);
    total += v;
  }
  for (let i = 0; i < w.length; i++) w[i] = w[i]! / total;
  return w;
})();

function pickLang(r: Rng): string {
  let x = r();
  for (let i = 0; i < zipfWeights.length; i++) {
    x -= zipfWeights[i]!;
    if (x < 0) return SYNTH_LANGS[i]!;
  }
  return SYNTH_LANGS[0]!;
}

export interface SyntheticOptions {
  seed?: number;
  /** overrides the modelled rate; used by `?rateMul=` in tests/soak (T6.3). */
  rateMul?: number;
  /** start timestamp, unix ms */
  startTs?: number;
}

/**
 * Spec §6.7 — arrival rate `r(t) = base · (1 + 0.6·sin(2π t / 90))`, plus
 * per-second bursts: 2 % chance of 20–60 extra events spread over 3 s.
 *
 * Carries the burst budget as a small queue of `(remaining, rate)` so bursts
 * overlap and decay naturally instead of being emitted in one instant spike.
 */
export class SyntheticSource {
  private readonly rng: Rng;
  private readonly base: number;
  private timeSec = 0;
  private idSeq = 1_000_000;
  /** pending burst emissions: {left, perSec} */
  private readonly bursts: { left: number; perSec: number }[] = [];
  private carry = 0;
  private burstCheckNext = 1;

  readonly startTs: number;

  constructor(opts: SyntheticOptions = {}) {
    this.rng = mulberry32(opts.seed ?? 1);
    this.base = SYNTH_BASE_RATE * (opts.rateMul ?? 1);
    this.startTs = opts.startTs ?? 1_790_000_000_000;
  }

  /** Instantaneous arrival rate at the current virtual time (events/s). */
  rateAt(t: number): number {
    const diurnal =
      SYNTH_BASE_RATE * (1 + SYNTH_RATE_AMP * Math.sin((2 * Math.PI * t) / SYNTH_RATE_PERIOD_SEC));
    let burst = 0;
    for (let i = 0; i < this.bursts.length; i++) {
      burst += this.bursts[i]!.perSec;
    }
    return (diurnal + burst) * (this.base / SYNTH_BASE_RATE);
  }

  /** Advance the clock by `dtMs` and return the events that arrived. */
  next(dtMs: number): NormalizedEdit[] {
    const dtSec = dtMs / 1000;
    if (!(dtSec > 0)) return [];

    const out: NormalizedEdit[] = [];

    // Sub-step so long ticks still see burst roll-outs correctly.
    const MAX_STEP_SEC = 0.25;
    let remaining = dtSec;
    while (remaining > 1e-9) {
      const step = remaining > MAX_STEP_SEC ? MAX_STEP_SEC : remaining;
      remaining -= step;
      this.timeSec += step;

      // Burst roll: once per virtual second.
      while (this.timeSec >= this.burstCheckNext) {
        this.burstCheckNext += 1;
        if (this.rng() < SYNTH_BURST_PROB) {
          const count = SYNTH_BURST_LO + this.rng() * (SYNTH_BURST_HI - SYNTH_BURST_LO);
          this.bursts.push({ left: count, perSec: count / SYNTH_BURST_SPREAD_SEC });
        }
      }

      // Decay active bursts.
      for (let i = this.bursts.length - 1; i >= 0; i--) {
        const b = this.bursts[i]!;
        b.left -= b.perSec * step;
        if (b.left <= 0) this.bursts.splice(i, 1);
      }

      // Poisson-ish accumulation.
      this.carry += this.rateAt(this.timeSec - step) * step;
      let n = Math.floor(this.carry);
      this.carry -= n;
      if (n > 500) n = 500; // guard against a pathological multiplier

      for (let i = 0; i < n; i++) out.push(this.makeEdit());
    }

    return out;
  }

  /** One synthetic edit, following the §6.7 model. */
  private makeEdit(): NormalizedEdit {
    const r = this.rng;
    const lang = pickLang(r);
    const host = PROJECT_FOR_LANG(lang);
    const { lang: parsedLang, project } = parseHost(host);

    // Actor: 20 % bot, 22 % anon, 58 % registered.
    const ap = r();
    let actor: Actor;
    if (ap < SYNTH_BOT_P) actor = "bot";
    else if (ap < SYNTH_BOT_P + SYNTH_ANON_P) actor = "anon";
    else actor = "registered";

    // Kind: 3 % revert, 3 % new, rest edit.
    const kp = r();
    let kind: EditKind;
    if (kp < SYNTH_REVERT_P) kind = "revert";
    else if (kp < SYNTH_REVERT_P + SYNTH_NEW_P) kind = "new";
    else kind = "edit";

    // Delta magnitude: log-normal, clamped.
    const absDelta = Math.round(
      logNormal(r, SYNTH_LOGNORMAL_MU, SYNTH_LOGNORMAL_SIGMA, SYNTH_ABSDELTA_LO, SYNTH_ABSDELTA_HI),
    );

    // Sign: 62 % positive, but reverts are 70 % negative-biased.
    const positive = kind === "revert" ? r() > SYNTH_REVERT_NEGATIVE_P : r() < SYNTH_POSITIVE_P;
    const delta = positive ? absDelta : -absDelta;

    const title = normalizeTitle(pick(r, SYNTH_TITLES) ?? "Example");
    const ns = kind === "new" ? 0 : r() < 0.85 ? 0 : 1 + Math.floor(r() * 10);
    const minor = r() < 0.4;
    const magnitude = magnitudeOf(absDelta);

    return {
      id: this.idSeq++,
      ts: Math.round(this.startTs + this.timeSec * 1000),
      wiki: `${lang}wiki`,
      host,
      lang: parsedLang,
      project,
      ns,
      title,
      actor,
      kind,
      minor,
      delta,
      absDelta,
      magnitude,
      importance: importanceOf(magnitude, kind, ns, actor),
      revNew: 1 + Math.floor(r() * 100000),
    };
  }
}

/**
 * Exposed for tests and the generator script: the actor mix must come out at
 * ~20 % bot / 22 % anon / 58 % registered over a large sample.
 */
export function synthActorRoll(r: Rng): Actor {
  const ap = r();
  if (ap < SYNTH_BOT_P) return "bot";
  if (ap < SYNTH_BOT_P + SYNTH_ANON_P) return "anon";
  return "registered";
}

export { classifyActor };
