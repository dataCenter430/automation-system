Snorkel's own static checks rejected the task you built. This is feedback attempt {{attempt}} of {{maxAttempts}}.

This is not our local gate — this is the platform's CI, run against the exact zip we uploaded. It is the opinion that actually counts, and it caught something our local checks did not.

Here is its output, verbatim:

```
{{feedback}}
```

Fix it in `{{workspace}}`.

## Read the failure class first

Most of these are **structural** — an unpinned base image, a file in the wrong place, a missing key in `task.toml`, a size limit, something COPY'd into the image that shouldn't be, a ruff error. For those, the rule is:

- **Only fix what the checks are complaining about.** Do not change what the task asks for, do not redesign the tests, do not make it easier. The task was already verified working locally — the oracle scored 1 and the null run scored 0. Keep it that way.
- Read the message literally. It usually names the file and the line.

**One failure class is different, and it is the one below.**

## `[category_classifier]` — this is a REDESIGN, not a relabel

```
❌ [category_classifier] Predicted category '<blocked>' (confidence 0.9x) is blocked
```

If you see this, **do not touch `task.toml`.** Changing `category`, `subcategories` or `tags` cannot fix it: **the classifier never reads `task.toml`.** It reads `instruction.md`, the source you shipped in `environment/`, `solution/solve.sh`, and your test names, and it answers one question — *what must the agent produce, and how is it judged?* It has told you, at high confidence, that the honest answer is a blocked category. **It is right.** Treat its verdict as correct and change the task's **substance** so the honest answer becomes the assigned category.

This is the single exception to "only fix what the checks are complaining about". Here you *must* change what the task asks the agent to do. The premise, the domain, the difficulty, the long-context dossier, the languages and the numeric payload all stay — the **deliverable and the grading criteria** change.

**Diagnose it.** A prediction of `software-engineering` / `debugging` almost always means `instruction.md` is a bug report: it says the code produces wrong output, asks the agent to find and fix defects, and is graded on "the code is now correct". It is confirmed by planted-defect comments in the shipped source (`// DEFECT #1: WRONG, should be 45`) and by a `solve.sh` that is `sed` one-liners over constants. A prediction of `data-processing` usually means the deliverable is "transform this file into that file" with no discipline-specific reasoning being graded.

**Fix it by inversion, not by deletion.** Nothing in the environment is ever *in error*. Every value that is not the current one becomes **legitimately correct for a prior version or configuration** — a v2 spec, an old calibration, the policy the store was materialized under. The agent is no longer hunting your mistakes; it is **deriving the current definition from the shipped specification and building the current artifact**. The numbers stay identical. The framing inverts.

Concretely, work through all of these:

1. **Rewrite `instruction.md`** so the agent's verb is in-category. Purge every one of: *bug, fix, broken, wrong, incorrect, defect, debug, root-cause, something is off, complaints, make the tests pass*. State instead what artifact must be produced and what makes it correct.
2. **Strip planted-defect comments from the shipped source.** `// DEFECT #n: WRONG ... should be ...` classifies as debugging *and* leaks the oracle — with those comments present, a `long_context` dossier was never actually exercised, because the agent could solve the task by reading five comments.
3. **Move the payload from "a mistake to find" to "a spec to derive."** Externalize the constants the agent must get right into a configuration the agent has to *author* from the specification, alongside a prior-version config that is shipped, labelled, and genuinely correct for that prior version.
4. **Re-shape the deliverables** so at least two of the assigned category's core verbs are the substance. For `machine-learning`: materialize features, construct a cohort, measure drift (PSI/KS), evaluate, select a calibrated threshold at a stated operating point, record lineage. Grade on *numbers describing data or model behaviour*, never on "the code is now correct".
5. **Rename the tests.** The classifier reads test names. `test_retirement_uses_45_day_threshold` is a bug-fix regression test; `test_cohort_retention_window` is the same assertion, in-category.
6. **Keep the verifier exactly as tight.** The same wrong value must still fail — expressed as a wrong PSI, a wrong class balance, a wrong operating point. This is a reframing, never a difficulty cut. The null run must still score 0.

Then re-run the self-check: read `instruction.md` **alone**, with no metadata, and ask which single category it is and at what confidence. If the answer is not the assigned category at high confidence, you are not done — iterate on the deliverables again, never on the enum.

## Other named checks

- **`codebase_size`** — CI counts the files under `environment/`, excluding `Dockerfile`/`docker-compose`, and rejects a mismatch: ≤20 → `minimal`, 20+ → `small`, 200+ → `large`. Fix the *field* to match the count, not the environment to match the field (unless the environment is genuinely under-built).
- **`ruff`** — every error is blocking. Delete unused imports (`F401`), drop the `f` from f-strings with no placeholder (`F541`), remove unused bindings (`F841`). Run `ruff check tests/` and see it clean before you answer.
- **`[instruction_check]`** — if it says the instruction prescribes a developer workflow, remove the build and test procedure from the prompt: no "rebuild with `make`", no "set `VAR=...` and run this", no numbered command sequence. Replace it with *what correct output looks like* — exact paths, formats, values, tolerances, acceptance criteria. Build and verification steps live in the Dockerfile and `tests/`. This changes the wording, not what the task requires.
- **Warnings (⚠️) are advisory**, and some are known false positives — notably the single-stage-Dockerfile warning when the task legitimately requires the agent to compile at runtime. Do not break a working build chasing a warning. Fix every ❌.

## Before you say you are done

After you fix it, the task goes back through the **local Docker gate first**, before it is re-uploaded. If your fix breaks the oracle or lets the null run pass, you will hear about that instead, and we will have burned a round trip for nothing.

Run the oracle and the null run yourself. If you redesigned the task, both matter more than usual: the oracle must still score 1 against the new deliverables, and the null run must still score 0.
