Snorkel's own static checks rejected the task you built. This is feedback attempt {{attempt}} of {{maxAttempts}}.

This is not our local gate — this is the platform's CI, run against the exact zip we uploaded. It is the opinion that actually counts, and it caught something our local checks did not.

Here is its output, verbatim:

```
{{feedback}}
```

Fix it in `{{workspace}}`.

Rules for this fix:

- **Only fix what the checks are complaining about.** Do not change what the task asks for, do not redesign the tests, do not make it easier. The task itself was already verified working locally — the oracle scored 1 and the null run scored 0. Keep it that way.
- These failures are usually structural: an unpinned base image, a file in the wrong place, a missing key in `task.toml`, a size limit, something COPY'd into the image that shouldn't be. Read the message literally.
- If the complaint is about `instruction.md` (too many requirements, reveals the solution, doesn't sound human), rewrite the prompt — but do not change what the task actually requires.

After you fix it, the task goes back through the **local Docker gate first**, before it is re-uploaded. So if your fix breaks the oracle or lets the null run pass, you will hear about that instead, and we will have burned a round trip for nothing.

Run the oracle and the null run yourself before you say you are done.
