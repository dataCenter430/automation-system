The task you built did not pass the verification gate. This is attempt {{attempt}} of {{maxAttempts}}.

Here is exactly what happened, verbatim:

```
{{failureReport}}
```

Fix it in `{{workspace}}`.

Rules for this fix:

- **Fix the cause, not the symptom.** If a test failed, work out whether the test is wrong or the solution is wrong before changing either. Do not weaken a test to make it pass — a test that passes because you loosened it is how a task gets rejected for being trivially solvable.
- **Do not make the task easier.** The premise and the difficulty stay as they are. You are fixing a defect in the build, not renegotiating the task.
- If the failure is the **null run scoring 1** (tests pass with no solution), that is a test-design problem, and it is the serious one. Your assertions are checking something that is already true in the environment. Rewrite them so every assertion depends on work the agent must actually perform.

When you have fixed it, **run it yourself before saying so**: build the image, run `/solution/solve.sh`, run `/tests/test.sh`, read `/logs/verifier/reward.txt` and confirm it says `1`. Then run the tests in a fresh container with no solution and confirm it says `0`.

The gate will run again the moment you finish, and if it fails you will see this message again. Checking it yourself first is strictly cheaper.


When the fix is done and you have re-run the oracle and the null run yourself, write
`.pipeline/BUILD_DONE` again (overwrite it) with a one-line note on what you changed. The
automation watches that file, not this chat.
