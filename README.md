# Snorkel Automation Workflow

Builds and submits Snorkel **Terminus 2nd Edition** tasks. You paste the task text into a
local dashboard; a local worker drives a logged-in Claude Code session to build the task
tree (`environment/`, `solution/`, `tests/`, `instruction.md`, `task.toml`), proves it in
Docker, zips it, writes the three submission explanations, fills Snorkel's form in your own
Chrome, and runs Snorkel's "Check feedback" until it comes back green. Then it stops and
waits for you.

Two clicks are yours and only yours: **Start Build** (nothing spends a Claude session or a
Docker build until you press it) and **Approve & Submit** (the only irreversible action in
the system). Everything in between is automatic, crash-resumable, and logged.

---

## Architecture

```
                      you
                       |
                paste / click
                       |
   +-------------------v--------------------------------------------+
   |  apps/web   Next.js dashboard   http://localhost:3100          |
   |                                                                 |
   |   POST /api/parse         preview the 6 parsed fields + the     |
   |                           resolved task.toml enums - NO write   |
   |   POST /api/tasks         insert the row at DRAFT (inert)       |
   |   POST /api/tasks/[id]    start | approve | retry | cancel      |
   +-------------------------------+---------------------------------+
                                   |
                                   v
                     +-------------------------------+
                     |  Supabase (Postgres)          |
                     |    terminus                   |  <- pipeline_state is the
                     |    terminus_implementation    |     ONLY shared truth between
                     |    pipeline_events            |     the dashboard and the worker
                     +-------------------------------+
                                   ^
                     poll every 5s | claim QUEUED rows only
                                   |
   +-------------------------------+---------------------------------+
   |  apps/worker   local Node process (node --experimental-strip-types)
   |                                                                 |
   |  pipeline.ts - ONE state transition per call, then return.      |
   |  A task parked in CHECKING_FEEDBACK yields the worker to        |
   |  another task instead of blocking it for 20 minutes.            |
   |                                                                 |
   |   Claude Code SDK        Docker              Playwright         |
   |   (auth: ~/.claude,      (verify gate:       (CDP attach only)  |
   |    NO API key)           oracle + null run)         |           |
   +----------------------------------------------------|-----------+
                                                        |
                                          attach to a Chrome you launched
                                                        |
                                                        v
                              +--------------------------------------+
                              |  your Chrome (dedicated profile,     |
                              |  --remote-debugging-port=9222)       |
                              |     experts.snorkel-ai.com           |
                              +--------------------------------------+

  on disk:
    workspace/<slug>/          the task tree Claude is building (+ .pipeline/state.json)
    runs/<slug>/<stage>/       docker logs, pytest output, screenshots, DOM dumps
    prompts/summary.txt        the playbook, distilled from ${SNORKEL_ROOT}/documentation
    ${SNORKEL_ROOT}/Working/   <slug>.zip - exactly what gets uploaded
```

---

## The pipeline, state by state

`packages/shared/src/status.ts` is the source of truth. A state means "this work is not yet
done"; a transition is committed only **after** its side effect is durable, which is what
makes the whole thing resumable — anything found in a `*_RUNNING` state on boot was
interrupted, so the worker just re-enters it.

| # | State | What it means | What moves it on |
|---|-------|---------------|------------------|
| 0 | `DRAFT` | Parsed and saved, **inert**. The worker will never touch this row. | You press **Start Build**. |
| 5 | `QUEUED` | Released by a human. `claimNextTask()` takes exactly one, atomically. | The worker claims it. |
| 10 | `BUILD_RUNNING` | A Claude Code session is building the task tree in `workspace/<slug>`. The session id is persisted before the second prompt, so a crash **resumes** the session instead of paying for it twice. | Manifest complete. |
| 20 | `BUILT` | All required files exist on disk. | Straight into verify. |
| 30 | `VERIFY_RUNNING` | The Docker gate: lint (~200ms) -> `docker build` -> **oracle run** -> **null run**. | Gate verdict. |
| 35 | `VERIFY_FAILED` | Gate said no. Failure report saved verbatim. | Attempts left -> `FIX_RUNNING`; otherwise `FAILED`. (3 attempts) |
| 45 | `FIX_RUNNING` | The failure report is fed back into **the same Claude session** (`prompts/03-fix.md`). | Back to the gate — Claude does not get to declare itself fixed. |
| 40 | `VERIFIED` | oracle reward = 1, null reward = 0, lint clean. | Zip. |
| 50 | `ZIPPED` | `${SNORKEL_ROOT}/Working/<slug>.zip` written: contents at the **root** of the archive, LF line endings, `0755` on the scripts. | Explain. |
| 55 | `EXPLAINED` | The three form explanations (difficulty / solution / verification) generated by resuming the build session, filtered for LLM-tell prose, and stored in `terminus_implementation`. | Upload. |
| 60 | `UPLOADING` | Playwright opens a **new** submission, attaches the zip, fills the three explanations, and ticks the Prompt Check attestation — but only after `instruction-audit.ts` has actually verified the three things that box claims. Snorkel's own disabled/enabled state on "Check feedback" is the readiness oracle. | Form accepted. |
| 65 | `CHECKING_FEEDBACK` | "Check feedback" clicked; polled **every 30s** for up to 20 min. Output is read from the Monaco *model*, not the rendered lines (Monaco virtualizes — scraping `.view-line` silently truncates). | Explicit pass or explicit fail. Neither -> `NEEDS_HUMAN`. |
| 67 | `FEEDBACK_FAILED` | Snorkel's static checks rejected the build. | Attempts left -> `REMOTE_FIX_RUNNING`; otherwise `FAILED`. (3 attempts) |
| 69 | `REMOTE_FIX_RUNNING` | Snorkel's CI output is fed back into **the same Claude session** (`prompts/05-feedback-fix.md`). | Back to `VERIFY_RUNNING` — the task is re-proved **locally** before it is re-uploaded, because a fix that satisfies Snorkel's CI can quietly break the oracle. |
| 70 | `AWAITING_APPROVAL` | Snorkel's checks are green and the rubric checkbox is ticked. **Parks here indefinitely and safely.** | You press **Approve & Submit**. |
| 80 | `SUBMITTING` | Reconciles against the "Tasks to be revised" list *before* clicking: after a crash we do not know whether the click landed, and a duplicate submission cannot be undone. | Click confirmed. |
| 90 | `SUBMITTED` | Terminal. `terminus.task_status` moves to 1 (AI review). | — |
| -1 | `FAILED` | Retryable from the dashboard. The retry keeps `claude_session_id`, so the build is **resumed**, not paid for twice. Read the Retry note below before you rely on it. | **Retry**. |
| -2 | `NEEDS_HUMAN` | Something ambiguous: inconclusive feedback, a broken selector, an unclear submit outcome. The system refuses to guess here. | You. |

> `pipeline_state` is **not** `terminus.task_status`. The latter is Snorkel's own lifecycle
> (0 Working on / 1 AI review / 2 Human review / 3 Accepted). Don't conflate them.

---

## The two human gates

**1. Start Build** — `DRAFT (0) -> QUEUED (5)`

A task you add is inert. The worker's claim query only ever looks for `QUEUED`, so a `DRAFT`
row can sit there forever and nothing will spend a Claude session, a Docker build, or a
minute of your subscription quota on it. This exists because the expensive, irreversible
part of a mistake is *starting*: a mis-parsed blob that runs for 45 minutes has cost you 45
minutes of quota before anyone notices it built the wrong task. The preview step in the
dashboard is there so you catch that in two seconds instead.

**2. Approve & Submit** — `AWAITING_APPROVAL (70) -> SUBMITTING (80)`

The only irreversible action in the system. By the time this button appears, the task has
passed our Docker gate *and* Snorkel's own static checks — but a submission cannot be
withdrawn, and a bad one costs reputation, not just time. So the machine does everything up
to the edge of that click and then stops. The submit stage still reconciles against the
revise list before clicking, in case a crash left us unsure whether a previous click landed.

---

## Setup on a new machine

The target machine needs **Docker Desktop**, **Chrome**, and **Node >= 22.6** (or >= 20.19 —
see below). Everything else is checked for you.

```powershell
git clone <repo>
cd Snorkel-Automation-Workflow
npm install

powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

> **The Node version is not a rounding error.** Nothing here is ever compiled: the worker,
> the CLIs and the scripts all run `.ts` files directly under `--experimental-strip-types`.
> That flag shipped in **22.6.0** and was backported only as far as **20.19.0**. On 20.0–20.18,
> and on the whole of 21.x, `node` doesn't ignore the flag — it refuses to boot
> (`node: bad option: --experimental-strip-types`), so *every* npm script in this repo dies on
> its first line. "Node 20 LTS" from an older installer is exactly that machine, which is why
> `setup.ps1` gates on major **and** minor. Install Node 22 LTS and this never comes up.

`setup.ps1` checks, in order, and prints the exact fix for anything that fails:

1. Node >= 22.6, or >= 20.19 (the versions that can actually run `--experimental-strip-types`)
2. `node_modules` exists (offers to run `npm install`)
3. Playwright's chromium download (`npx playwright install chromium`)
4. Docker daemon reachable (`docker info`)
5. Claude Code is logged in for **this OS user** (`~/.claude`)
6. `.env` exists (copies `.env.example` for you) and the two values the code actually reads
   are filled in
7. `SNORKEL_ROOT` resolves to a folder containing `documentation/`
8. `prompts/summary.txt` exists and isn't truncated

Then, in order:

1. **Database** — paste `scripts/migrate.sql` into the Supabase SQL editor and run it. It is
   additive (`add column if not exists`), so it is safe to re-run.
2. **`.env`** — fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (the `sb_secret_...` one —
   the publishable key cannot write). Those two are the only values read at runtime: the
   dashboard reaches Supabase exclusively through its own server-side API routes, so the
   `NEXT_PUBLIC_*` and `SUPABASE_ACCESS_TOKEN` entries in `.env.example` are reference-only
   today.
   Set `SNORKEL_ROOT` **only** if `documentation/`, `Working/` and `Accepted/` do not live in
   this repo's parent folder; that's the default and nothing in the repo hard-codes a path.
3. **Playbook** — `npm run summary:build` distills `${SNORKEL_ROOT}/documentation` into
   `prompts/summary.txt`. Every build prompt is grounded in it. Without it, builds are
   ungrounded and get rejected.
4. **Chrome** — `powershell -File scripts\clone-chrome-profile.ps1` once, then
   `powershell -File scripts\launch-chrome.ps1`. See the next section for why.
5. **Prove the gate before you trust it** — point the verifier at a task you already know is
   good: `npm run verify:task -- "..\Accepted\<known-good>.zip"`. If the gate cannot grade an
   already-accepted task, the gate is broken, not the task — and you want to learn that
   before a Claude session has ever run.
6. **Run it** — `npm run worker` in one terminal (as the OS user that is signed in to Claude),
   `npm run dev -w @saw/web` in another.

---

## The Chrome / CDP situation

You cannot attach Playwright to a Chrome that is already running normally.

The debug port only exists if Chrome was **started** with `--remote-debugging-port`, and
since Chrome 136 the browser **refuses that flag when it points at the default
user-data-dir** — a deliberate security fix, because otherwise any local process could read
the cookies of your everyday browsing profile. There is no flag, policy, or version pin that
brings that back, and we would not want it back.

So a dedicated profile directory is unavoidable, and that leaves exactly one problem: a fresh
profile has no Snorkel login. `scripts/clone-chrome-profile.ps1` solves that by **copying your
existing Chrome profile** (cookies, session, the works) into the automation profile
directory, so the automation browser opens already signed in to Snorkel and nobody has to log
in again — or keep a second set of credentials around.

`scripts/launch-chrome.ps1` is then the **only** supported way to start that browser. It
refuses to start a second instance if CDP is already listening (Playwright would happily
attach to the wrong browser). Leave the window open while the worker runs; the worker attaches
and detaches around each browser stage and never closes your browser.

We attach to a real, signed-in browser rather than launching a headless one because every
action must go through Snorkel's real UI as a real logged-in user. The worker never calls
Snorkel's API — `cdp.ts` can even log every XHR the page makes, so a stray call would show up
in the run log rather than hide.

---

## Daily use

```powershell
powershell -File scripts\launch-chrome.ps1     # 1. leave this Chrome open
npm run worker                                 # 2. its own terminal; preflight runs first
npm run dev -w @saw/web                        # 3. dashboard on http://localhost:3100
```

4. **Paste** the task text and the task uuid into *Add task*, press **Preview**. Check the six
   parsed fields and the resolved `task.toml` enums. Press **Add to queue** — it lands as a
   `DRAFT` and *nothing happens*.
5. Press **Start Build**. Now it costs money.
6. **Watch.** The queue polls every 3 seconds; "Log" on any row shows its event stream —
   every Claude turn, its cost, every state transition, every Docker verdict.
7. When the row turns **READY TO SUBMIT**, the zip is in `${SNORKEL_ROOT}/Working/`, the form
   is filled, and Snorkel's own checks are green. Look at it. Then press **Approve & Submit**.

The worker can be killed at any point (Ctrl-C, or a power cut). On restart it sweeps every row
stuck in a `*_RUNNING` state and re-enters it; the Claude session is resumed from its id, not
rebuilt from scratch.

---

## Command reference

Root scripts (`package.json`):

| Command | What it does |
|---|---|
| `npm run worker` | Preflight, then the poll loop. The main process. Only ever claims `QUEUED` rows. |
| `npm run preflight` | The runtime checks alone (Claude login, Docker, Supabase, playbook, CDP) with fixes. Run this when something feels wrong. |
| `npm run verify:task -- <dir\|zip>` | Run the Docker gate against a task tree or a `.zip`, standalone. Prints lint findings, oracle reward, null reward, and the verbatim fix prompt it would hand Claude. |
| `npm run summary:build` | Rebuild `prompts/summary.txt` from `${SNORKEL_ROOT}/documentation`. |
| `npm run selectors:record` | Audit every selector in `config/selectors.snorkel.json` against the page currently open in the automation Chrome. |
| `npm run selectors:record -- --pick` | Click an element in Chrome; get ranked, paste-ready candidates for the config. |
| `npm test` | Unit tests (`packages/shared/test`), via `node --test`. |
| `npx tsc --noEmit` | **The typecheck.** Use this one. |

> ⚠️ **Do not run `npm run typecheck`.** It is `tsc -b --noEmit false`, which overrides the
> `noEmit: true` this repo depends on. It fails anyway (`TS5096: 'allowImportingTsExtensions'
> can only be used when 'noEmit' … is set`) — but *not before emitting ~33 `.js` files next to
> the `.ts` sources*, in a repo whose entire premise is running `.ts` directly. Nothing imports
> them, so they rot silently. If you have run it, delete them:
> `Get-ChildItem -Recurse -Include *.js -Path apps,packages,scripts | Remove-Item` (and
> `tsconfig.tsbuildinfo`). `npm run build` (`tsc -b`) is safe — it honours `noEmit`.

Dashboard (`apps/web`, workspace `@saw/web`):

| Command | What it does |
|---|---|
| `npm run dev -w @saw/web` | Next.js dev server on **port 3100**. |
| `npm run build -w @saw/web` / `npm run start -w @saw/web` | Production build / serve on 3100. |

PowerShell:

| Script | What it does |
|---|---|
| `scripts\setup.ps1` | The bootstrap check for a new machine. Everything above, with fixes. |
| `scripts\clone-chrome-profile.ps1` | One-time: clone your signed-in Chrome profile into the automation profile. |
| `scripts\launch-chrome.ps1` | Start the automation Chrome with CDP on 9222. The only supported way. |
| `scripts\migrate.sql` | Additive schema migration; paste into the Supabase SQL editor. |

Configuration lives in `config/pipeline.json` (timeouts, retry counts, Docker limits, the gate
thresholds) and `config/selectors.snorkel.json` (**every** Snorkel DOM selector — no selector
string may appear in a `.ts` file). Paths in `pipeline.json` use `${REPO_ROOT}` and
`${SNORKEL_ROOT}` tokens; nothing is ever hard-coded.

---

## Troubleshooting

**"Docker daemon is not reachable" / builds fail instantly**
Docker Desktop is not running, or is still starting. Start it, wait for it to say *Running*,
then `npm run preflight`. This is the single most common cause of a confusing failure here —
which is why both preflight and the verify gate check it up front instead of letting you find
out six minutes into a build.

**`/solution/solve.sh: /bin/bash^M: bad interpreter: No such file or directory`**
CRLF line endings. Claude writes these files on a Windows host; the container is Linux. It
looks like a Docker or mount fault and is neither. `util/lf.ts` normalizes `.sh`, `.py`,
`.toml`, `.md`, `Dockerfile`, `Makefile` and `.dockerignore` to LF before **both** verify and
zip, and the linter rejects any that slip through. (`.gitattributes` also pins `eol=lf`, but
only for `*.sh`, `*.py`, `Dockerfile` and `.dockerignore` — it is a backstop for files
committed to *this* repo, not for the task trees Claude generates, which are never committed.
`util/lf.ts` is what actually protects a build.) If you see this, something wrote a file
*after* normalization — re-run the gate (`npm run verify:task -- workspace\<slug>`) and it
will be fixed on the way in.

**"Nothing is listening on the CDP port" / the upload stage cannot attach**
Chrome was started normally, or was closed. You cannot attach to a normally-launched Chrome —
see the CDP section. Close every window belonging to the automation profile and run
`powershell -File scripts\launch-chrome.ps1` again. If it says CDP is already up but the
worker still cannot attach, you have two Chromes and Playwright is attaching to the other one.

**A Snorkel selector broke (`SelectorNotFound`, or the task lands in `NEEDS_HUMAN` at upload)**
Snorkel shipped a redesign. This is a **config edit, not a code change** — that is the whole
point of `config/selectors.snorkel.json`. With the automation Chrome on the affected page:

```powershell
npm run selectors:record                # which configured selectors still resolve here?
npm run selectors:record -- --pick      # click the element; paste the candidates it prints
```

Paste the new candidates into the element's `candidates` array in
`config/selectors.snorkel.json` (they are tried in order, first match wins — put the
`data-testid` first; it survives a restyle, a CSS path does not). Restart the worker. No
TypeScript is touched.

**Claude auth fails, or every build dies on auth**
The worker is running as a different OS user than the one that ran `claude login`. The Agent
SDK spawns the Claude Code CLI, which reads `~/.claude` — there is **no API key** anywhere in
this system, by design; it uses your Claude Code subscription. Check `whoami`, and check that
`%USERPROFILE%\.claude` exists for *that* user. If you run the worker as a scheduled task or a
service, it must be configured to run as the signed-in user, not as `SYSTEM`.

**A task is stuck in `NEEDS_HUMAN`**
By design — the system refuses to guess in exactly three places: "Check feedback" gave neither
a clear pass nor a clear fail, a selector did not resolve, or a submit outcome was ambiguous.
Open the row's Log, look at the screenshots and DOM dumps in `runs/<slug>/<stage>/`, fix the
cause, and press **Retry**.

**Retry ran, burned a Docker gate, and went straight back to `FAILED` without fixing anything**
Known gap, and worth understanding before you click Retry a second time expecting a different
answer. The attempt counters live in `workspace/<slug>/.pipeline/state.json`, and that file
deliberately **wins over the database** (`state.ts`: *"On a conflict, this file wins for
resume"*). Retry resets `attempt` on the DB row only — so a task that already burned its 3
verify attempts comes back with its local counter still at 3, gets exactly one more gate run,
and re-fails without the fixer ever being called.

So: if the cause was **transient** (Docker was down, a flaky test), plain **Retry** is right.
If the cause was in the *task tree* and you want Claude's fix loop back, delete the local state
so the counters bootstrap from the reset row:

```powershell
Remove-Item -Recurse -Force workspace\<slug>\.pipeline
```

The workspace itself — and `claude_session_id` on the row — survive, so the build is still
resumed rather than rebuilt. (Retry also always re-enters at `QUEUED` regardless of where the
task died, so it re-runs the local Docker gate even for an upload-stage failure. That costs
minutes, not a Claude session.)

---

## What is still unconfirmed

Two selectors in `config/selectors.snorkel.json` are marked `"$unconfirmed": true`. They are
educated guesses that have not been seen resolve against the real page:

- **`submission.generateRubricCheckbox`** — the "generate rubric automatically" checkbox,
  ticked once Check feedback comes back green.
- **`submission.submitButton`** — the real Submit button. This is the irreversible one.

**Pin them before the first real submission.** Open a submission page in the automation
Chrome, then:

```powershell
npm run selectors:record            # shows which resolve, and flags anything matched via an $unconfirmed candidate
npm run selectors:record -- --pick  # click the checkbox, then the Submit button
```

Paste the printed candidates in, and delete the `"$unconfirmed": true` flag from each element
once you have actually watched it resolve.

Also not yet pinned: the pass/fail regexes in `apps/worker/src/stages/feedback.ts` are seeded
from Snorkel's field descriptions, not from an observed run. Until they are confirmed against
one good zip and one deliberately broken zip, an unrecognized output is treated as
**inconclusive** and parks the task at `NEEDS_HUMAN` rather than being read as a pass — a
false pass would tick the rubric box and hand you a broken task as if it were ready.
