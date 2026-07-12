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

## Before you tell me it is done

Run it yourself. Build the image, run the oracle, run the tests, and *look at the reward file*. Then run the tests again without the solution and confirm it scores 0.

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
