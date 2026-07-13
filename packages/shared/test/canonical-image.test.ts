/**
 * The base-image attestation.
 *
 * Snorkel's form asks "Does this task use an approved canonical base image?" — a question we
 * ANSWER, in our own name, on a form that routes CI. So the tests are about the two ways to get
 * that wrong: saying Yes when it is not canonical, and saying anything at all when we cannot tell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalBaseImage,
  canonicalImages,
  fromLines,
  runtimeImage,
} from "../../../apps/worker/src/stages/canonical-image.ts";

const GO_CANONICAL =
  "public.ecr.aws/docker/library/golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540c06173ea77ac";
// The SAME image, two characters apart. This digest is what the OTHER Snorkel doc says, and our
// own playbook used to ship it. It is not on the list.
const GO_IMPOSTOR =
  "public.ecr.aws/docker/library/golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac";
const PY =
  "public.ecr.aws/docker/library/python:3.13-slim-bookworm@sha256:01f42367a0a94ad4bc17111776fd66e3500c1d87c15bbd6055b7371d39c124fb";

function task(dockerfile: string | null): string {
  const d = mkdtempSync(join(tmpdir(), "canon-"));
  if (dockerfile !== null) {
    mkdirSync(join(d, "environment"), { recursive: true });
    writeFileSync(join(d, "environment", "Dockerfile"), dockerfile);
  }
  return d;
}

test("the canonical list loads, and holds the ten images Snorkel published", () => {
  const list = canonicalImages();
  assert.equal(list.length, 10);
  assert.ok(list.includes(GO_CANONICAL));
  assert.ok(list.includes(PY));
  // Every entry must be fully qualified AND digest-pinned. A tag-only entry would make the
  // whole check meaningless, because tags move.
  for (const img of list) {
    assert.match(img, /^public\.ecr\.aws\/docker\/library\/\S+@sha256:[0-9a-f]{64}$/, img);
  }
});

test("a canonical image answers Yes", () => {
  const d = task(`FROM ${PY}\nRUN pip install pytest\n`);
  try {
    const v = canonicalBaseImage(d);
    assert.equal(v.canonical, true);
    assert.equal(v.image, PY);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("THE TWO-CHARACTER TRAP: the impostor Go digest answers NO, not Yes", () => {
  // This is the whole reason the check exists. Snorkel's two docs disagree about this digest by
  // two characters, and our playbook shipped BOTH — so Claude could pick either. A hardcoded
  // "always Yes" would have signed a false attestation on every Go task that drew the short straw.
  const d = task(`FROM ${GO_IMPOSTOR}\nWORKDIR /app\n`);
  try {
    const v = canonicalBaseImage(d);
    assert.equal(v.canonical, false, "the impostor digest is NOT on Snorkel's list");
    // ...and it must explain itself, because "not on the list" about a two-character difference
    // is the kind of message that gets dismissed as a glitch.
    assert.match(v.why!, /DIGEST does not/i);
    assert.match(v.why!, /two characters apart/i);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("an unpinned image answers No — pinned and canonical are different things", () => {
  // BUILD_CONTRACT requires pinning, but lint only WARNS about it, so an unpinned image can
  // reach here. Pinning is a property of the reference; canonical is a property of the set.
  const d = task("FROM python:3.13-slim\n");
  try {
    assert.equal(canonicalBaseImage(d).canonical, false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("MULTI-STAGE: the FINAL stage is the one that gets attested", () => {
  // Snorkel: "the final stage is what agents and verifiers run in and is checked by CI."
  // Building in a non-canonical image and RUNNING in a canonical one is legitimate. Checking
  // the first FROM would fail a task that is perfectly fine.
  const d = task(
    `FROM golang:1.24 AS builder\nRUN go build -o /app\n\nFROM ${PY}\nCOPY --from=builder /app /app\n`,
  );
  try {
    const v = canonicalBaseImage(d);
    assert.equal(v.canonical, true, "the runtime stage is canonical, so the answer is Yes");
    assert.equal(v.image, PY);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("...and the inverse: canonical builder, non-canonical runtime, answers No", () => {
  const d = task(`FROM ${PY} AS builder\nRUN echo hi\n\nFROM alpine:3.19\nCOPY --from=builder / /\n`);
  try {
    const v = canonicalBaseImage(d);
    assert.equal(v.canonical, false, "what the agent RUNS in is not canonical");
    assert.equal(v.image, "alpine:3.19");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a final stage that inherits a NAMED stage resolves back to the real image", () => {
  // `FROM builder` is not a base image, it is a reference. Reporting "builder" as the image
  // would be an answer about something that does not exist.
  const df = `FROM ${PY} AS base\nRUN pip install x\n\nFROM base\nCMD ["bash"]\n`;
  assert.equal(runtimeImage(df), PY);

  const d = task(df);
  try {
    assert.equal(canonicalBaseImage(d).canonical, true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("CANNOT DETERMINE is null — never a default to Yes", () => {
  // The unsafe direction. Every one of these must refuse to sign, because the caller turns null
  // into "park for a human". If any returned true, we would attest to something we never read.
  const noDockerfile = task(null);
  const noFrom = task("# a Dockerfile with no FROM at all\nRUN echo hi\n");
  try {
    for (const [d, what] of [[noDockerfile, "no Dockerfile"], [noFrom, "no FROM line"]] as const) {
      const v = canonicalBaseImage(d);
      assert.equal(v.canonical, null, what);
      assert.equal(v.image, null, what);
      assert.ok(v.why, "it must say why it could not tell");
    }
  } finally {
    rmSync(noDockerfile, { recursive: true, force: true });
    rmSync(noFrom, { recursive: true, force: true });
  }
});

test("the FROM parser survives the things real Dockerfiles do", () => {
  assert.deepEqual(fromLines(`FROM ${PY}\n`), [PY]);
  assert.deepEqual(fromLines(`from ${PY}\n`), [PY], "FROM is case-insensitive");
  assert.deepEqual(fromLines(`FROM --platform=linux/amd64 ${PY} AS build\n`), [PY]);
  assert.deepEqual(fromLines(`  FROM   ${PY}   AS   build  \n`), [PY], "ragged whitespace");
  assert.deepEqual(fromLines("RUN echo FROM nothing\n"), [], "FROM inside a RUN is not a stage");
  assert.deepEqual(fromLines(`FROM ${PY}\r\nFROM alpine\r\n`), [PY, "alpine"], "CRLF");
});
