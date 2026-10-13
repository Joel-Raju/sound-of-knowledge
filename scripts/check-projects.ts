/**
 * Guard against a Playwright project that matches **zero** tests.
 *
 * The `firefox-smoke` and `webkit-smoke` projects in `playwright.config.ts` use
 * `grep: /@crossbrowser/`. Until `tests/e2e/crossbrowser.spec.ts` existed, that
 * regex matched nothing — and Playwright reported both projects as having run,
 * and passing, without executing a single line. CI showed three green e2e
 * projects; two of them were doing nothing.
 *
 * That is the same failure as a shader that renders nothing and times
 * beautifully: a green result from a process that did no work. A guard is worth
 * more than the tests here, because it stops the next person from adding a
 * project and forgetting its contents.
 *
 * Runs as a pretest step: `npm run test:e2e` cannot report success while any
 * configured project is empty.
 *
 * Usage: npx tsx scripts/check-projects.ts
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = resolve(ROOT, "playwright.config.ts");

/**
 * Parse project names and their `grep` filters out of the config.
 *
 * Deliberately a narrow read rather than importing the config: importing it
 * pulls in Playwright's runtime, and this guard has to run *before* the tests —
 * including before browsers are installed — so it needs to depend on nothing.
 */
function parseProjects(source: string): { name: string; grep: string | null }[] {
  const projects: { name: string; grep: string | null }[] = [];
  // Split on `name:` at the indent Playwright uses inside `projects: [...]`.
  const blocks = source.split(/\n\s{6}name:\s*/).slice(1);
  for (const block of blocks) {
    const nameMatch = /^["'`]([^"'`]+)["'`]/.exec(block);
    if (!nameMatch?.[1]) continue;
    const grepMatch = /grep:\s*\/([^/]+)\/[a-z]*/.exec(block);
    projects.push({ name: nameMatch[1], grep: grepMatch?.[1] ?? null });
  }
  return projects;
}

function main(): void {
  const source = readFileSync(CONFIG, "utf8");
  const projects = parseProjects(source);

  if (projects.length === 0) {
    console.error("✗ could not parse any project out of playwright.config.ts");
    console.error("  the guard cannot vouch for a config it cannot read — fix the parser");
    process.exit(1);
  }

  let failed = false;
  for (const p of projects) {
    const label = p.grep ? `grep /${p.grep}/` : "no grep (runs everything)";
    console.log(`  ${p.name.padEnd(16)} ${label}`);
  }
  console.log();
  console.log("  Cross-browser projects run non-interactively above; Playwright reports an");
  console.log("  empty selection as success, so verify each project lists tests:");
  console.log();
  console.log("    npx playwright test --project=<name> --list");
  console.log();
  console.log("  If a project lists nothing, either tag its tests or delete the project.");

  // Fail if any project is greped and no test file carries that tag at all.
  const specDir = resolve(ROOT, "tests/e2e");
  const specSources = ["audio-boot", "visual-boot", "reduced-motion", "crossbrowser"]
    .map((n) => {
      try {
        return readFileSync(resolve(specDir, `${n}.spec.ts`), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");

  for (const p of projects) {
    if (!p.grep) continue;
    if (!new RegExp(p.grep).test(specSources)) {
      console.error(`✗ project "${p.name}" greps for /${p.grep}/ but no spec carries that tag`);
      failed = true;
    }
  }

  if (failed) process.exit(1);
  console.log("✓ every grepped project has at least one matching test");
}

main();