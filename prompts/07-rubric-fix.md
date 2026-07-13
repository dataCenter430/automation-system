The rubric you wrote to `{{workspace}}/.pipeline/rubric.md` breaks Snorkel's rules.

Every one of these is marked **High severity** in the reviewer's own checklist, which means **a single failure and the task is not accepted**. This is not style feedback.

```
{{report}}
```

## Fix it, and rewrite the file

Same path: `{{workspace}}/.pipeline/rubric.md`. Nothing else reads it.

The rules, restated so you do not have to go looking:

- **One criterion per line.** No bullets, no numbering.
- **Every line starts with the word `Agent`.**
- **Every line ends with a comma, a space, and a score.**
- **The score is one of exactly: `1  2  3  5  -1  -2  -3  -5`.** Not 4, not 0, not 10.
- **At least three criteria must have negative scores.**
- Critical criteria take `5` / `-5`; minor ones take `1` or `2`.

The shape:

```
Agent must read the script at /app/script.py, 2
Agent accesses the /app/secret/ directory, -1
```

## The four things the agent cannot see

If the report says a criterion references tests, metadata, or the oracle, this is why — and it is the single most common way a rubric fails:

**The rubric grades the AGENT'S TRACE.** The agent never saw `/tests/`, was never given `task.toml`, does not know `instruction.md` exists, and has no idea the oracle ran. A criterion about any of them **can never fire**, so it grades nothing while making the rubric look thorough.

Rewrite those lines to describe something the agent actually *did in the terminal*:

- ❌ `Agent's solution passes test_routing.py, 3`
- ✅ `Agent repairs the strict-routing feature to point at gateway-core/strict-mode, 3`

## If the report says a path does not exist

A criterion that names a file the task does not contain can never fire. **Open the tree and check the real names.** This is exactly what the human reviewer sent this task back for: *"Four lines point at a build script, a fixtures folder, an env output and a route table that dont exist here, so they can never fire."*

Do not invent a plausible-sounding path. Use the one that is there.
