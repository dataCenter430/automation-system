pls build the task for this task:

**Title:** {{title}}

**Category:** {{category}}  →  task.toml `category = "{{toml_category}}"`
**Sub-categories:** {{sub_category}}  →  task.toml `subcategories = {{toml_subcategories}}`
**Languages:** {{languages}}  →  task.toml `languages = {{toml_languages}}`

**Description**

{{description}}

{{#additional_note}}
**Additional Inspiration**

{{additional_note}}
{{/additional_note}}

---

## Where to build

Build it in the current directory: `{{workspace}}`

Lay it out exactly as the standard requires — `task.toml`, `instruction.md`, `environment/` (with `Dockerfile`, `.dockerignore`, and the app the agent works on), `solution/solve.sh`, `tests/test.sh`, `tests/test_outputs.py`. Nothing else at the root. No README is needed.

## The task.toml enum values above are not suggestions

They have already been resolved from the closed vocabularies that `validate_task_fields` checks. Use them verbatim. Do not substitute your own guesses — an invalid enum is a blocking CI failure.

`languages` lists what the *agent* writes. Do not add `python` merely because the verifier tests are pytest.

`codebase_size` is **not** a free choice either — see the checklist at the bottom. It must match the real file count under `environment/`.

## The rule that gets tasks rejected: CATEGORY IS SUBSTANCE, NOT LABEL

Read this before you design anything.

**The category is decided by an LLM classifier that reads the task's content.** It reads `instruction.md`, the source you ship in `environment/`, `solution/solve.sh`, and your test names. **It never reads `task.toml`.** Writing `category = "{{toml_category}}"` in the metadata does not make the task that category — it only tells CI which category to hold you to. If the classifier disagrees with the enum, the classifier wins and the build is rejected:

```
❌ [category_classifier] Predicted category 'software-engineering' (confidence 0.95)
   is blocked for this project. Rework the task so it does not fall into a blocked category.
```

`software-engineering`, `debugging` and `data-processing` are **blocked**. A task framed as *"there are bugs in this code, find and fix them"* **is** software-engineering — at 0.95 confidence — no matter what the enum says, and no matter how ML-flavoured or security-flavoured the *domain* is. Domain nouns (a "classifier", a "feature store", a `model_metadata` table) are **set dressing**. The classifier keys on the **agent's verb and deliverable**: *what must the agent produce, and how is it judged?*

### The gate you must pass before writing `instruction.md`

Complete this sentence in fifteen words or fewer:

> "The agent must produce ______, judged correct by ______."

If blank 1 is *"a corrected source file"* or *"a working build"*, and blank 2 is *"the previously-failing behaviour is now right"* — you have designed a **debugging** task. **Stop and redesign the substance.** Do not proceed to write files.

### Banned framings

These must not appear in `instruction.md`, in the task title, in `solution/solve.sh`, in comments in the shipped source, or in test names. Every one of them is a debugging trigger the classifier reads:

- "the code has a bug" / "there are N bugs" / "N defects are planted"
- "fix the broken X" / "X is broken" / "repair the X"
- "the tool is producing wrong output" / "produces incorrect values" / "clearly something is off" / "I wouldn't trust any of the other calculations"
- "debug the" / "track down the cause" / "root-cause the"
- "make the failing tests pass"
- **planted-defect comments in shipped source** — `// DEFECT #1: WRONG value (30), should be 45`. These are doubly fatal: they classify as debugging *and* they leak the oracle into the agent's environment, so a `long_context` dossier the agent could have shortcut with five comments was never actually exercised.
- **an oracle that is `sed` one-liners over constants**, or a diff that only changes literals and operators. If `solve.sh` is six `sed`s over magic numbers, the task *is* a bug-fix task — that is the definition of one.

### The required framing instead

**Nothing in the environment is ever *in error*.**

Any pre-existing value that is not the current one must be **legitimately correct for a prior version or configuration** — a v2 feature spec, last quarter's calibration, the policy the store was materialized under. It is not a planted mistake; it is history. The agent's job is to **derive the current definition from the shipped specification and build the current artifact**.

This is a *framing inversion*, not a difficulty cut. The identical numeric payload survives: the same five values, the same needle-in-222KB long-context lookup (current §8.4/§9.3 vs superseded §6.1/§6.2), the same verifier tightness. What changes is that the agent is asked to **rematerialize under the current spec**, not to **find your mistakes**.

Worked example — same title, same dossier, same C++/SQLite, same difficulty:

| Debugging (rejected @ 0.95) | Machine-learning (in-category) |
|---|---|
| "migrate.cpp is producing wrong output; grayscale means are incorrect and records retire too aggressively; fix the code" | "Serving now emits v3 features; the store still holds v2 features, so models train skewed against production. Rematerialize the store under the v3 definition." |
| `// DEFECT #1: WRONG threshold (30, should be 45)` in the source | `config/feature_spec_v2.json` shipped and labelled *"the definition the legacy store was materialized under"* — correct for v2, and the agent's **reference distribution**, not its target |
| Deliverable: a corrected `.cpp` | Deliverables: `feature_spec_v3.json` the agent authors from the dossier; a rematerialized feature DB; `feature_drift.json` (per-stratum mean/std/**PSI** v2→v3); `cohort_report.json` (class balance vs the export appendix's targets); `calibration.json` (the threshold meeting the target operating point); provenance/lineage on every row |
| Graded on: "the constant is now 45" | Graded on: the PSI, the per-class counts, the selected operating point — *numbers describing data and model behaviour* |
| `test_retirement_uses_45_day_threshold` | `test_cohort_retention_window`, `test_grayscale_stratum_psi`, `test_defective_class_share_meets_export_targets` |

Note what is **absent** from the right-hand column: *bug, fix, broken, wrong, incorrect, defect, debug, something is off, complaints*. And what is **present**: *rematerialize, feature definition, serving skew, cohort, class balance, drift, calibration, operating point, lineage, reproducible*.

### Positive definition — what makes a task genuinely belong to its category

The **deliverable must be an artifact of that discipline** and the **success criteria must be stated in that discipline's own terms**. At least **two** of the category's core verbs must be the substance of the task — not decoration around a code fix.

- **machine-learning** — feature engineering / feature pipelines; dataset & cohort construction (splits, sampling, class balance, leakage, point-in-time correctness); model evaluation (precision/recall, PR-AUC, confusion matrix, per-stratum metrics); calibration & threshold selection (ECE, Brier, reliability, "max precision subject to recall ≥ 0.95"); drift & skew (PSI, KS, training/serving skew); inference / batch scoring; lineage & reproducibility; feature-store operations (materialization, backfill, definition migration). The "error" being addressed must be a **data/model/distribution** error, never a code error.
- **security** — the deliverable is a policy, a hardened configuration, an exploit-resistant boundary, an audit finding with evidence; graded on what an attacker can and cannot now do.
- **scientific-computing** — the deliverable is a numerical result, a simulation, a solver, a reproducible computation; graded on numerical correctness/stability/convergence against a reference.
- **system-administration** — the deliverable is a configured, converged, observable system; graded on the system's end state.
- **build-and-dependency-management** — the deliverable is a resolved dependency graph, a reproducible/hermetic build; graded on build reproducibility and resolution correctness.
- **games** — the deliverable is a playable rule-correct game or agent; graded on game state and legal play.

**The implementation language is irrelevant to the category.** Heavy coding does not make a task software-engineering. 600 lines of C++ that build a feature pipeline is *machine-learning implemented in C++*. Six `sed` commands over constants is *debugging*, however ML-flavoured the domain. Substance, not medium.

### Mandatory self-check before you finalize

Read `instruction.md` **alone** — no `task.toml`, no tags, no title — and honestly answer:

> "Which single category best describes this task: machine-learning / software-engineering / debugging / data-analysis / security / …? What is my confidence?"

If the answer is not **{{toml_category}}** at high confidence — or is a **blocked** category at any confidence — **the task is not shippable.** Iterate on the instruction and the deliverables. Never on the metadata: relabelling the enum cannot move a classifier that does not read it.

## instruction.md: WHAT, not HOW

An instruction-quality check reads `instruction.md` too, and it rejects prompts that read like a developer runbook.

**State what correct behaviour is, and the acceptance criteria.** Required outputs, their exact paths, their formats, the values and tolerances they must satisfy, which specification governs.

**Do not state how to build or test.** No "rebuild it with `make`", no "set `MIGRATION_TIMESTAMP=...` and run this command", no numbered developer workflow, no test invocations, no "then check that the tests pass". Build procedure, environment variables and verification steps belong in the Dockerfile and in `tests/` — the harness already knows how to build and run; the agent needs to know what *correct* means.

Determinism requirements are a *property of the output* ("outputs must be byte-reproducible across runs"), so state them as such rather than as a command line to copy.

## What you are actually being asked for

Not "a task about this topic". A task that **frontier models fail 80–100% of the time**, that a competent human expert can still solve in a couple of hours, and whose tests prove the difference. Re-read section 8 of the standard before you design it and pick your difficulty levers deliberately.

The description above is the *premise*. The hardness is your job.

## How this will be judged, mechanically, the moment you say you are done

Your build is handed straight to a Docker gate that runs, in a clean container with **no network**:

1. `bash /solution/solve.sh` then `bash /tests/test.sh` → `/logs/verifier/reward.txt` **must be `1`**.
2. The same image again, with **no solution applied** → `/logs/verifier/reward.txt` **must be `0`**.
3. A static lint over the whole tree — pinned base image digest, no `COPY solution/` or `COPY tests/`, canonical reward block, no runtime `pip install`, `allow_internet = false`, LF line endings, size limits.

If any of those fail, the exact failure output comes straight back to you in this same session and you fix it. So there is no upside in guessing — every shortcut you take will be handed back to you in a few minutes with the receipts.

Point (2) is the one people fail. Tests that pass without the solution are worthless and are an explicit rejection criterion. Every assertion must depend on work the agent actually had to do.

Then the platform's own CI runs on top of that — the category classifier above, plus a lint pass that has failed us before on exactly two dumb things. Neither is allowed to happen again.

## Two mechanical failures that are entirely on you

**Ruff.** Every Python file in the zip is linted, and *any* error is blocking. The ones that have actually bitten us:

- `F401` — imported but unused. If you stop using `os` or `subprocess` after a rewrite, delete the import.
- `F541` — f-string with no placeholder. `print(f"cohort report missing")` is an error; drop the `f`.
- `F841` — assigned but never used, including unused `except ... as e` bindings.

Run `ruff check tests/` (and over anything else Python you are shipping) and see it come back clean before you claim done. Do not ship scratch or helper scripts in the tree — they get linted too.

**`codebase_size`.** It is checked against reality: CI counts the files under `environment/`, excluding `Dockerfile` and `docker-compose`, and rejects a mismatch. The bands are `minimal` ≤20 files, `small` 20+, `large` 200+. A six-file environment is **`minimal`**, not `small`. Count it — `find environment -type f | grep -v Dockerfile | wc -l` — and set the field from the count. Never from a vibe about how big the task feels.

## Before you tell me it is done

Run it yourself. Build the image, run the oracle, run the tests, and *look at the reward file*. Then run the tests again without the solution and confirm it scores 0. Run `ruff`. Count the environment files. Re-read `instruction.md` cold and classify it.

Do not report success on the basis of having written plausible-looking code. If you have not seen `reward.txt` contain `1` with the solution and `0` without it, the task is not done, and saying otherwise just costs us both a round trip.

## How to signal that you are done

The automation does not read this chat. It watches the filesystem.

When the task is **genuinely finished and you have seen `reward.txt` contain `1` with the
solution and `0` without it**, write the file `.pipeline/BUILD_DONE` in this workspace. Put
in it one line saying what the task requires and which specific failure mode you designed it
to exploit.

Do not write that file before the task is actually complete. Writing it early does not make
the build finish early — it just means the gate catches an unfinished task and hands it
straight back to you.
