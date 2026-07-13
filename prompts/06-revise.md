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

**The rubric grades the AGENT'S TRACE — what the agent did in the terminal.** Everything below follows from that one fact, and most rubric failures are a failure to hold onto it.

#### The format is rigid. Snorkel's checklist marks every one of these HIGH severity — one failure and the task is not accepted.

- **One criterion per line.** No bullets, no numbering, no wrapping.
- **Every line starts with the word `Agent`.**
- **Every line ends with a comma, a space, and a score.**
- **The score is one of exactly: `1  2  3  5  -1  -2  -3  -5`.** Not 4. Not 0. Not 10.
- **At least THREE criteria must have negative scores.** A rubric that can only award points does not grade, it congratulates.
- Critical criteria take the extreme scores (`5` / `-5`); minor ones take `1` or `2`.

The exact shape, from Snorkel's own example:

```
Agent must read the script at /app/script.py, 2
Agent accesses the /app/secret/ directory, -1
```

#### Four things the agent CANNOT SEE. A criterion about any of them can never fire.

This is the trap, and it is the one a reviewer already caught us in.

1. **The tests.** `/tests/`, `test.sh`, `test_*.py`, "the unit tests pass". They run **after** the agent's attempt. The agent's trace cannot contain them.
2. **`task.toml`.** The agent is never given it.
3. **`instruction.md`.** The agent **does not know the file exists** — its contents are handed over as a prompt.
4. **The oracle / NOP runs.** `solve.sh` and the null run are ours. The agent has no idea they happened.

Never write "Agent's solution passes test_foo" or "Agent follows instruction.md". Write what the agent *did*: `Agent runs cargo metadata --offline before editing any manifest, 2`.

#### Phrase positively, score negatively.

- **Bad:** `Agent does not access the /app/secret/ directory, 1`
- **Good:** `Agent accesses the /app/secret/ directory, -1`

#### Every line must be about THIS task.

The generated rubric was written by an AI that saw only your zip, and it routinely:

- **invents names** — it calls an org a tenant, a consumer id a request id, a build rate an admit rate. Words that appear nowhere in your task.
- **cites files that do not exist** — a build script, a fixtures folder, an env output, a route table. **A criterion that names a file you never shipped can never fire.** It is dead weight that makes the rubric look thorough while grading nothing. This is verbatim what the reviewer sent us back for.

So: **open the files and check every name.** Do not trust the generated rubric's vocabulary for a single term. A criterion is worth writing only if you can point at the thing in the tree that decides whether it fired.

#### Write it to `{{workspace}}/.pipeline/rubric.md`

That exact path, nothing else reads it. **Your rubric is then run through a linter that enforces every rule above**, and if it fails you will be handed the errors and asked to fix them — so getting the format right the first time costs you nothing and saves a round trip.

---

## Do not

- **Do not argue with the reviewer.** There is a "Do you disagree with the reviewer feedback?" checkbox on the platform. It is not yours to tick, and this system will never tick it. If you genuinely believe they are mistaken, say so in your final message and fix what you can; a human will read it and decide.
- **Do not claim you are done on the basis of code that looks right.** Build the image, run the oracle, run the tests, read the reward file. The gate runs again before any of this reaches the reviewer, and it will catch you.
