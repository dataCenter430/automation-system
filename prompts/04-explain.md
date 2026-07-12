The task is built and it passed verification. Now write the three explanations that go on the submission form.

You already have the whole task in context, so write from what you actually built — not from the premise you were given.

Three groups. **Exactly four sentences each.**

1. **Difficulty Explanation** — why this task is challenging for humans and for agents to solve.
2. **Solution Explanation** — your high-level approach and the key insights that formed the solution.
3. **Verification Explanation** — how your tests verify correctness.

## Voice

Write like a person typing into a form, not like an AI writing a report. Start sentences the way people actually start them: "I am sure…", "I think…", "I found that…", "The tricky part was…", "I made the tests…".

Plain, direct, a bit informal. Contractions are fine.

Hard bans, because these are the tells that get a submission flagged:
- no em-dashes
- no "delve", "moreover", "furthermore", "it's worth noting", "additionally", "leverage", "robust", "comprehensive", "seamless"
- no bullet points, no headings, no markdown
- no restating the task description back at me

Roughly 60–90 words per group. Concrete beats grand: name the actual thing (the buried tie-break rule, the 50k-token manual, the held-out cases) rather than describing it abstractly.

## Output format

Write the JSON to the file `.pipeline/EXPLANATIONS.json` in this workspace. The automation
reads that file, not this chat.

```json
{
  "difficulty": "...",
  "solution": "...",
  "verification": "..."
}
```

Then write `.pipeline/EXPLAIN_DONE` to signal you are finished.
