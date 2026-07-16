Before you build anything, state the design. This is a gate, and it costs seconds — the point is that it costs seconds *instead of* an eighteen-minute build that gets rejected.

## The one question

> **What must the agent produce, and what decides whether it is right?**

That sentence — not `task.toml`, not the tags, not the title — is what the category classifier reads and what Snorkel accepts or rejects. Get it right here and the build is downhill. Get it wrong here and no amount of building will save it.

## Your category

**{{category}}**

{{categorySpec}}

## The trap, stated plainly, because it has already cost four builds

A task was rejected four times in a row. Between rejections it was rebuilt from scratch — into a Terraform spec recovery, then a threshold calibrator, then a champion/challenger selector. Three unrelated tasks. Every one was graded the same way:

> *the agent emits an artifact; the tests compare it to a reference*

**That is data-processing. It is blocked.** It does not stop being data-processing because the artifact is called `promotion.json`, or because the domain is machine learning, or because computing it is genuinely hard. The classifier reads what the tests **measure**, and what they measured never changed.

The nouns moved three times. The **grading axis** never moved once — so the verdict never moved either.

## So: choose the axis first

`gradingAxis` is a closed vocabulary. Pick exactly one:

| axis | the assertion measures | typical of |
|---|---|---|
| `property-threshold` | a measured property clears a stated bar — `recall >= 0.95`, `AP >= baseline`, `error < tol` | machine-learning, scientific-computing |
| `comparative-baseline` | the thing produced beats a named alternative on a metric | machine-learning, games |
| `invariant-violation` | an invariant holds under attack or stress — a forged signature is refused, energy is conserved | security, scientific-computing |
| `observable-end-state` | the system's observable state is correct — the service survives a restart, the limit is enforced | system-administration, build-and-dependency-management |
| `equality-vs-reference` | the agent's output equals a reference output | **data-processing — BLOCKED. Never choose this.** |

{{rejectedDesigns}}

## Anti-cheating does not force your hand

Playbook §7.3 tells you how to **derive** an expected value without hardcoding it. It does **not** tell you to assert equality. Both of these re-derive; only one is in a category Snorkel accepts:

```python
# equality axis — BLOCKED, whatever the file is called
expected = oracle.decide(load("/app/scores"))
assert json.load(open("/app/out/promotion.json")) == expected

# property axis — re-derived from held-out data the agent has never seen,
# so it still cannot be copied from the assertions. And it grades a MODEL PROPERTY.
heldout  = heldout.generate(seed=7)
deployed = run_agent_artifact(heldout)
assert average_precision(deployed, heldout) >= DEPLOYMENT_BASELINE
```

## Write it

Write `.pipeline/design.json`, exactly this shape:

```json
{
  "deliverable": "What the agent must PRODUCE. One paragraph, concrete. Write it as the agent will read it.",
  "gradedOn": "What DECIDES whether it is right. Name the property and the bar it must clear.",
  "gradingAxis": "property-threshold",
  "testNames": ["test_...", "test_...", "test_..."],
  "handedToAgent": "What is in environment/ — what the agent starts with."
}
```

Then stop. Write nothing else. The design is classified before you are allowed to build, and if it is blocked you will be told why and asked to restate it — which is cheap, and is the whole point.

**Do not put a test in `testNames` that you do not intend to write, and do not write a test later that is not in `testNames`.** The built tree is checked against this list. A design that clears the gate and a build that grades something else is the one way left to smuggle a blocked task through, and it is checked for.
