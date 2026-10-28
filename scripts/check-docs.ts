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

// --- phase list: REMOVED ---------------------------------------------------
/**
 * This block used to assert that every ticked task appears in a hand-maintained
 * parenthetical in the Status section, and it was rewritten at T6.6 to check all of
 * them rather than just the last. **It was then deleted, in the same session, by an
 * unrelated edit to the Status prose.**
 *
 * The mechanism: the guard anchored on a literal regex, `/\(T0\.1–T0\.3.*?\)/`. When
 * the Status rewrite dropped that parenthetical, `phaseLine` became `null`, the
 * `if (phaseLine && …)` body never ran, and the guard began passing unconditionally —
 * while still being reported as part of `check:docs`.
 *
 * **This is the failure mode this file already documents twice**, and it is worse than
 * having no guard: a missing guard is visible, a silently-disabled one reads as
 * coverage. Two guards in this script were previously found inert for exactly this
 * reason — one matched `**C11.** ✅` in a file where that string occurs zero times, and
 * `test:soak` pointed at a spec that did not exist and exited 0.
 *
 * **Why it is deleted rather than repaired.** The parenthetical was a *restatement* of
 * the checkbox list. The checkbox list is the single source of truth, and the count
 * assertion above already validates the only number the summary makes a claim about.
 * A guard whose subject is a hand-maintained duplicate of something already checked
 * earns nothing and can be switched off by editing a sentence.
 *
 * If a phase summary is ever wanted again, it should be **derived** in this script and
 * compared, not maintained by hand beside the thing it duplicates.
 */

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

/**
 * A declared-resolved id must (a) name an item that actually exists and (b) be ticked.
 *
 * **Why this changed at T6.6.** The original asserted only "is not still `- [ ]`", which
 * a nonexistent id satisfies vacuously — `<!-- sok-resolved: ZZZ -->` passed clean. A
 * guard that accepts an item which has never existed is not checking that the item was
 * resolved; it is checking that a string is absent. Both halves are now asserted, and
 * the assertion was verified to fail on `ZZZ` before this comment was written.
 */
for (const id of declared) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anyForm = new RegExp(`^- \\[[ x]\\] \\*\\*${escaped}\\.?\\*\\*`, "m");
  const stillOpen = new RegExp(`^- \\[ \\] \\*\\*${escaped}\\.?\\*\\*`, "m");

  if (!anyForm.test(checklist)) {
    failures.push(
      `DECISIONS.md declares ${id} resolved, but no such item exists in ` +
        `HUMAN-CHECKLIST.md — the marker is checking a string, not an item`,
    );
  } else if (stillOpen.test(checklist)) {
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