The task came back from Snorkel's difficulty check as **too easy**. That is not a defect to patch — it means a frontier model solved it more often than the bar allows, and the task must be made genuinely harder without changing what it is about.

The bar, verbatim: a task where the *worst* eval model scores above 80% is rejected. Yours is above it. Your job is to find out **why the model found it easy** and remove that ease — not to bolt on unrelated difficulty.

## The evidence

This is the reviewer / AI feedback:

```
{{feedback}}
```

These are the actual agent-run transcripts from the difficulty check — what the model did, where it succeeded, what it never had to struggle with:

```
{{artifacts}}
```

## Read the transcripts before you touch anything

You are looking for the *shortcut*. A too-easy task almost always has one, and the transcript shows it:

- **The answer was inferable from the tests or the instruction.** The model read the assertion, or a comment, or an over-specified instruction, and worked backwards. → the difficulty is leaking.
- **The hard part was optional.** The model skipped the reasoning you intended and still passed, because the tests did not require it. → the tests grade the easy path.
- **The long-context payload was greppable.** The needle was findable by a literal search instead of by understanding. → the context is not actually load-bearing.
- **One obvious approach just works.** There is no branch where a plausible wrong approach fails. → the task has no discriminating difficulty.

Name the specific shortcut the transcripts show. If several models solved it, they may have used different shortcuts — close all of them.

## What "harder" must and must not mean

**Must:** the reasoning or discovery bottleneck the model bypassed becomes unavoidable. The same domain, the same deliverable, the same grading axis — but the path to a correct answer now requires the step the model skipped. Raise the floor by making the *thinking* necessary, not by adding volume.

**Must not:** do not make it harder by piling on requirements or edge cases. The Review Checklist rejects that explicitly — "a task primarily hard due to a large number of edge cases/requirements should be rejected." More clauses is not more difficulty; it is more tedium, and it gets declined too.

And do not, in making it harder, drift into a blocked category or off your grading axis. Re-read the design you committed to; stay on it.

## Then prove it is still valid

Rebuild the image, run `solution/solve.sh` then `tests/test.sh` (reward must be **1**), and the tests with no solution applied (reward must be **0**). A harder task that the oracle can no longer solve is worse than a too-easy one — it fails the gate for a new reason and tells us nothing.

When you are done, state in one line: the shortcut you found in the transcripts, and the specific change that closes it.
