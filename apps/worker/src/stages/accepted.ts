/**
 * ACCEPTED-TASK RECIPES — turn a task that cleared human review into a reusable implementation
 * summary, so future builds of SIMILAR tasks can copy what actually worked.
 *
 * When Snorkel accepts a task, everything that made it pass is already on disk and in the DB:
 *   - its DESIGN (deliverable, grading axis, test names) — the thing the classifier gated on,
 *   - its three EXPLANATIONS (difficulty, solution, verification) — written at the explain stage,
 *   - its category / languages / title.
 * So the recipe is ASSEMBLED from proven artifacts, not re-generated — reliable, free, and it needs
 * no Claude turn on a task whose session may be long gone. assembleSummary() is pure; recordAccepted()
 * reads the artifacts and upserts.
 */
import type { Design } from "./design-gate.ts";
import type { Explanations } from "./explain.ts";
import { readDesign } from "./design-gate.ts";
import { readState } from "../state.ts";
import { upsertImplementation, getStoredExplanations } from "../../../../packages/shared/src/supabase.ts";
import { canonicalCategory } from "../../../../packages/shared/src/taxonomy.ts";
import type { TerminusRow } from "../../../../packages/shared/src/types.ts";

/** The task facts the recipe is keyed and headed by. A subset of TerminusRow, so the row satisfies it. */
export interface TaskFacts {
  title: string;
  category: string;
  sub_category: string;
  languages: string;
  slug: string | null;
}

/**
 * Build the reusable recipe. PURE — no I/O, so it is unit-tested exactly.
 *
 * The shape is deliberately scannable, not prose: a future build session pattern-matches on the
 * grading axis and test names far more usefully than it reads a paragraph. Missing pieces degrade
 * gracefully (a task built before the design gate has no design.json) — the summary just omits them.
 */
export function assembleSummary(
  facts: TaskFacts,
  design: Design | null,
  explanations: Explanations | null,
): string {
  const parts: string[] = [
    `# ${facts.title} — ACCEPTED`,
    `Category: ${facts.category}${facts.sub_category ? ` / ${facts.sub_category}` : ""} · Languages: ${facts.languages}`,
  ];

  if (design) {
    parts.push(
      ``,
      `## Deliverable`,
      design.deliverable,
      ``,
      `## Graded on — axis \`${design.gradingAxis}\``,
      design.gradedOn,
      ``,
      `## Tests that graded it`,
      design.testNames.map((t) => `  - ${t}`).join("\n"),
    );
  }

  if (explanations?.difficulty) parts.push(``, `## What made it the right difficulty`, explanations.difficulty);
  if (explanations?.solution) parts.push(``, `## Solution approach`, explanations.solution);
  if (explanations?.verification) parts.push(``, `## Verification approach`, explanations.verification);

  return parts.join("\n").trim();
}

/** Does the recipe carry any actual guidance, or is it just the title/category header? */
export function hasBody(design: Design | null, explanations: Explanations | null): boolean {
  if (design) return true;
  return !!(explanations && (explanations.difficulty || explanations.solution || explanations.verification));
}

/** Everything recordAccepted needs, injected so it is testable without disk or DB. */
export interface RecordDeps {
  readDesign: (ws: string) => Design | null;
  readExplanations: (ws: string) => Explanations | null;
  /** Fallback when the workspace is gone: the explanations persisted at build time. */
  readStoredExplanations: (taskId: string) => Promise<Explanations | null>;
  canonicalCategory: (raw: string) => string;
  upsert: typeof upsertImplementation;
  now: () => string;
}

const liveDeps: RecordDeps = {
  readDesign,
  readExplanations: (ws) => readState(ws)?.explanations ?? null,
  readStoredExplanations: getStoredExplanations,
  canonicalCategory,
  upsert: upsertImplementation,
  now: () => new Date().toISOString(),
};

/**
 * Record an accepted task's recipe, marking the row accepted and denormalising the retrieval keys.
 *
 * THROWS ONLY ON A REAL WRITE FAILURE. A missing workspace is not a failure — it just yields a
 * thinner recipe (explanations recovered from the DB; the design section is lost because it lives
 * only on disk). The CALLER relies on this: a throw means "retry next reconcile" (the DB was
 * unreachable), while a clean return means "done" even if the recipe was thin.
 *
 * The category is CANONICALISED so storage and retrieval agree across label spellings. And a
 * body-less recipe (no design AND no explanations anywhere) is recorded as accepted but WITHOUT an
 * implementation_summary — a header-only string would be retrieved as a worthless example, so it is
 * left null and findAcceptedImplementations skips it.
 */
export async function recordAccepted(
  taskId: string,
  ws: string,
  facts: TaskFacts,
  deps: RecordDeps = liveDeps,
): Promise<void> {
  const design = deps.readDesign(ws);
  const explanations = deps.readExplanations(ws) ?? (await deps.readStoredExplanations(taskId));

  const patch: Parameters<typeof upsertImplementation>[1] = {
    accepted: true,
    accepted_at: deps.now(),
    category: deps.canonicalCategory(facts.category),
    sub_category: facts.sub_category,
    languages: facts.languages,
    title: facts.title,
    slug: facts.slug ?? undefined,
  };
  if (hasBody(design, explanations)) patch.implementation_summary = assembleSummary(facts, design, explanations);

  await deps.upsert(taskId, patch);
}

/** Pull the TaskFacts out of a DB row. */
export function factsOf(row: TerminusRow): TaskFacts {
  return {
    title: row.title,
    category: row.category,
    sub_category: row.sub_category,
    languages: row.languages,
    slug: row.slug,
  };
}
