/**
 * Docs consistency check. Run by `npm run check:docs`.
 *
 * **Why this exists.** Three separate times this session the progress docs went stale
 * in exactly the same way — a task was ticked but the status line kept the old test
 * count, a phase list still read `T4.1–T4.3` after T4.4 shipped, and a closed
 * human-checklist item never reached `PROGRESS.md`'s summary. Each was caught by
 * reading the file after the fact, not by any mechanism.
 *
 * Nothing in a markdown file fails a build when it goes out of date, so this is the
 * only thing that will notice. It checks the specific claims that have drifted before,
 * rather than trying to prove the documents correct in general.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

const progress = read("docs/PROGRESS.md");
const checklist = read("docs/HUMAN-CHECKLIST.md");

const failures: string[] = [];

// --- task ticks -------------------------------------------------------------
const taskLines = [...progress.matchAll(/^- \[([ x])\] \*\*(T\d+\.\d+)\*\*/gm)];
const ticked = taskLines.filter((m) => m[1] === "x").length;
const total = taskLines.length;

const status = progress.match(/\*\*(\d+) of (\d+) tasks\*\*/);
if (!status) {
  failures.push("PROGRESS.md has no 'N of M tasks' status line");
} else {
  const [, claimedDone, claimedTotal] = status;
  if (Number(claimedTotal) !== total) {
    failures.push(
      `status line claims ${claimedTotal} tasks, checklist lists ${total}`,
    );
  }
  if (Number(claimedDone) !== ticked) {
    failures.push(
      `status line claims ${claimedDone} tasks ticked, ${ticked} actually are`,
    );
  }
}

// --- human checklist -------------------------------------------------------
const openItems = (checklist.match(/^- \[ \]/gm) ?? []).length;
const closedItems = (checklist.match(/^- \[x\]/gm) ?? []).length;

const clStatus = progress.match(
  /Human checklist: (\d+) of (\d+) closed, (\d+) open/,
);
if (!clStatus) {
  failures.push(
    "PROGRESS.md has no 'Human checklist: N of M closed, K open' line",
  );
} else {
  const cDone = Number(clStatus[1]);
  const cTotal = Number(clStatus[2]);
  const cOpen = Number(clStatus[3]);
  if (cTotal !== openItems + closedItems) {
    failures.push(
      `checklist line claims ${cTotal} items, file has ${openItems + closedItems}`,
    );
  }
  if (cDone !== closedItems) {
    failures.push(`checklist line claims ${cDone} closed, file has ${closedItems}`);
  }
  if (cOpen !== openItems) {
    failures.push(`checklist line claims ${cOpen} open, file has ${openItems}`);
  }
}

// --- phase list ------------------------------------------------------------
// The parenthetical after "Phases 0–4 open" must name the last ticked task.
const phaseLine = progress.match(/\(T0\.1–T0\.3.*?\)/);
const lastTicked = taskLines.filter((m) => m[1] === "x").pop()?.[2];
if (phaseLine && lastTicked) {
  // Annotated explicitly: `?? []` after a regex match infers `never[]`, and
  // `.includes(string)` against that does not compile under strict mode.
  const phases: string[] = phaseLine[0].match(/T\d\.\d/g) ?? [];
  if (!phases.includes(lastTicked)) {
    failures.push(
      `phase list "${phaseLine[0]}" omits ${lastTicked}, the last ticked task`,
    );
  }
}

/**
 * Every item `DECISIONS.md` declares resolved must actually be ticked.
 *
 * **Why this exists.** Asked "is the progress being updated" three times, and the
 * third time it was true: C6 and C11 had been reported as closed in conversation, the
 * reasoning had been written into `DECISIONS.md`, and the items were still `- [ ]` in
 * the checklist. Nothing caught it, because the checks above verify the documents
 * agree **with each other** — and they did. The drift was between a claim and the file
 * it was about.
 *
 * **Why the marker is an HTML comment.** The first version of this matched `**C11.** ✅`
 * in `DECISIONS.md`, and that shape occurs zero times in the file — resolutions are
 * recorded as markdown *headings* (`### C11 closed — …`). It passed every test because
 * it was silent, which is the exact failure mode it was written to catch. So the marker
 * is explicit, and the next assertion exists so the marker set cannot rot away unnoticed
 * (an inert guard is worse than no guard: it reads as coverage).
 */
const decisions = read("docs/DECISIONS.md");
const declared = [...decisions.matchAll(/<!--\s*sok-resolved:\s*([^>]*?)\s*-->/g)]
  .flatMap((m) => (m[1] as string).split(",").map((id) => id.trim()))
  .filter(Boolean);

if (declared.length === 0) {
  failures.push(
    "DECISIONS.md has no `<!-- sok-resolved: X -->` markers — the resolved-items " +
      "guard is inert, so it is reporting coverage it does not have",
  );
}

for (const id of declared) {
  if (new RegExp(`^- \\[ \\] \\*\\*${id}\\.\\*\\*`, "m").test(checklist)) {
    failures.push(`declared resolved in DECISIONS.md but still unticked: ${id}`);
  }
}

if (failures.length > 0) {
  console.error(`✗ docs are out of date (${failures.length}):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}

console.log(
  `✓ docs consistent — ${ticked}/${total} tasks, ${closedItems}/${openItems + closedItems} human items closed`,
);