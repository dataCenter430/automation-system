Your task is **blocked**. Not broken — blocked. The gate never even reached Docker.

This is attempt {{attempt}}.

```
{{failureReport}}
```

## Read this before you touch anything

**A blocked category is not a bug you patch. It is a task you rebuild.**

The classifier does not read `task.toml`. It reads `instruction.md`, the source you shipped, `solve.sh`, and your **test names**, and it answers one question:

> **What must the agent produce, and what decides whether it is right?**

Your answer to that question is currently in a blocked category. Editing the `category` field changes nothing. Renaming a test changes nothing. Adding domain vocabulary changes nothing — we have tried all three, and Snorkel rejected the task both times.

## The two things that get us blocked, every time

**1. "Here is code. Something in it is wrong. Find it and fix it."**

→ `software-engineering`, or `debugging` if the agent has to locate the fault.

It does not matter that the wrong values are labelled as belonging to a prior version. It does not matter that the instruction never says "bug". If the agent's job is to make existing code produce correct output, the deliverable is **a corrected source file**, and that is blocked.

**2. "Transform this into that, according to this spec."**

→ `data-processing`. A migration is ETL no matter what domain the nouns come from. If the grading sentence ends *"...and the output file is correct"*, it is data-processing.

## What to do instead

The failure report above tells you what your **assigned** category actually requires — its deliverable, what it is graded on, and what its test names look like. That is not a style note. **The test names are what the classifier reads.**

Rebuild the task so that:

1. **The deliverable is the thing that category is about.** Not a corrected file. Not a transformed table. The artifact that category exists to produce.

2. **The tests grade THAT.** Rename is not enough — the assertion itself has to change. `test_output_json_matches_golden` grades an output; `test_forged_signature_is_rejected` grades a security property. Those are different tests, not the same test with a different name.

3. **Nothing in the environment is ever *in error*.** The shipped code is not broken; it is **honestly incomplete against a requirement the agent is given**. The agent's job is to *build the missing capability*, not to *find your mistake*.

4. **The difficulty stays exactly where it was.** You are not making this easier. The engineering underneath — the domain, the long-context payload, the numbers, the languages — all of it survives. What changes is **what the agent is asked for** and **what decides whether it got it**.

## The self-check, and it is the only one that matters

When you are done, read `instruction.md` **alone** — no `task.toml`, no tags, no memory of what you just did — and answer:

> *"What must the agent produce, and what decides whether it is right?"*

Then ask which category that sentence belongs to, and at what confidence.

If the answer is not your assigned category at high confidence — or is a blocked category at **any** confidence — **you are not done.** Go back to the deliverable. Do not go back to the metadata.

## Then prove it still works

Rebuild the image, run `solution/solve.sh` then `tests/test.sh` (reward must be **1**), and run the tests with **no solution applied** (reward must be **0**).

A redesign that breaks the oracle is worse than no redesign: it fails the gate for a second reason and tells us nothing about whether the first one is fixed.
