A **human reviewer** at Snorkel read the task you built and sent it back. This is revision attempt {{attempt}} of {{maxAttempts}}.

This is not CI. This is not a linter. A person read your task, formed an opinion, and wrote it down. Their words are the spec now.

## What they wrote, verbatim

```
{{feedback}}
```

## The rubric Snorkel's AI generated from your zip

```
{{rubric}}
```

The task lives in `{{workspace}}` and is exactly the tree you shipped.

---

## There are TWO deliverables, and skipping either wastes the round trip

### 1. Fix the task tree

Do what the reviewer asked. Read their words literally — they are describing *your* task, and they have seen it.

- **Only change what they raised**, plus anything strictly required to keep the task working. They did not ask for a redesign. A reviewer who says "three rubric lines point at files that do not exist" is not inviting you to rewrite the tests.
- **The task must still pass its own gate.** After your fix, the oracle (`bash /solution/solve.sh` then `bash /tests/test.sh`) must still score reward=1, and the null run — the same tests with NO solution — must still score 0. A revision that breaks either is worse than no revision: it fails our gate and never reaches the reviewer at all.
- **Rule 8 still binds.** The predicted category must not drift into a blocked one (`software-engineering`, `debugging`, `data-processing`) while you are editing `instruction.md` or renaming tests. Re-read it before you finish.

### 2. Rewrite the rubric — write it to `.pipeline/rubric.md`

The rubric is what the reviewer grades against, and it is the thing they complain about most. Snorkel's guide is blunt about the generated one:

> *"Don't simply accept the synthetic rubric as-is. It is a general guideline that often misses specific task nuances."*

The generated rubric above was written by an AI that saw only your zip. It routinely:

- **invents names.** It calls an org a tenant, a consumer id a request id, a build rate an admit rate — words that appear nowhere in your task.
- **cites files that do not exist.** A build script, a fixtures directory, an env output, a route table. A criterion that points at a file you never shipped **can never fire**, so it is dead weight that makes the rubric look thorough while grading nothing.
- **grades the wrong things.** It describes a generic task in your task's shape.

Rewrite it so that **every single line refers to something that actually exists in this tree** — the real filenames, the real field names, the real identifiers, the real values. Open the files and check the names. Do not trust the generated rubric's vocabulary for even one term.

A criterion is worth writing only if you can point at the file and the line that decides whether it passed.

**Write the finished rubric to `{{workspace}}/.pipeline/rubric.md`.** That exact path. Nothing else reads it, and nothing else will pick it up — if you skip it, the reviewer gets the AI's untouched rubric with the mistakes they just complained about, and they will send it straight back.

Keep the generated rubric's format and structure. You are correcting its content, not redesigning the artifact.

---

## Do not

- **Do not argue with the reviewer.** There is a "Do you disagree with the reviewer feedback?" checkbox on the platform. It is not yours to tick, and this system will never tick it. If you genuinely believe they are mistaken, say so in your final message and fix what you can; a human will read it and decide.
- **Do not claim you are done on the basis of code that looks right.** Build the image, run the oracle, run the tests, read the reward file. The gate runs again before any of this reaches the reviewer, and it will catch you.
