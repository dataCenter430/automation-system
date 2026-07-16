/**
 * THIS SYSTEM MUST NEVER BE BILLED PER TOKEN.
 *
 * Every Claude call goes through the Agent SDK -> the Claude Code CLI -> the ~/.claude
 * subscription, which is a flat fee. The guarantee does not break by someone adding an API key to
 * the code — it breaks by an environment variable set somewhere else entirely, which the CLI picks
 * up and quietly bills.
 *
 * These tests are the guarantee. Not a comment saying we intend it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/paths.ts";
import { BILLING_VARS, billingVarsPresent, subscriptionEnv, } from "../../../apps/worker/src/claude/no-billing.ts";
test("subscriptionEnv STRIPS every variable that could route a call to metered billing", () => {
    const before = { ...process.env };
    try {
        // Simulate the hostile case: a shell that has been "helpfully" configured by another project.
        process.env.ANTHROPIC_API_KEY = "sk-ant-would-be-billed";
        process.env.ANTHROPIC_AUTH_TOKEN = "also-billed";
        process.env.ANTHROPIC_BASE_URL = "https://not-the-subscription";
        process.env.CLAUDE_CODE_USE_BEDROCK = "1";
        process.env.CLAUDE_CODE_USE_VERTEX = "1";
        process.env.PATH = "/usr/bin"; // an ordinary variable, which MUST survive
        const env = subscriptionEnv();
        for (const k of BILLING_VARS) {
            assert.equal(env[k], undefined, `${k} must be DELETED, not passed to the Claude child`);
            assert.ok(!(k in env), `${k} must not even be PRESENT — the CLI checks some of these for presence`);
        }
        // ...and the environment must still be usable.
        assert.equal(env.PATH, "/usr/bin", "we launder the env, we do not empty it");
    }
    finally {
        for (const k of Object.keys(process.env))
            if (!(k in before))
                delete process.env[k];
        Object.assign(process.env, before);
    }
});
test("extras are passed through — that is the whole reason env is set at all", () => {
    // CLAUDE_CODE_STREAM_CLOSE_TIMEOUT must reach the child or a blocking ask_human tool call tears
    // the transport down after 60s. Laundering must not break the thing the env was added for.
    const env = subscriptionEnv({ CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "1920000" });
    assert.equal(env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT, "1920000");
});
test("billingVarsPresent reports what the shell is trying to do, and ignores empty strings", () => {
    assert.deepEqual(billingVarsPresent({}), []);
    assert.deepEqual(billingVarsPresent({ ANTHROPIC_API_KEY: "" }), [], "empty is not set");
    assert.deepEqual(billingVarsPresent({ ANTHROPIC_API_KEY: "   " }), [], "whitespace is not set");
    assert.deepEqual(billingVarsPresent({ ANTHROPIC_API_KEY: "sk-ant-x" }), ["ANTHROPIC_API_KEY"]);
});
/**
 * Comments are not code.
 *
 * The first version of the test below scanned raw source and flagged five files — every one of
 * them a COMMENT explaining why we strip ANTHROPIC_API_KEY. A rule that forbids you from writing
 * down why the rule exists is a rule nobody can maintain, and it would push the explanation out of
 * the code and into somebody's memory.
 *
 * So: strip comments, scan what actually executes.
 */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "") // block comments, incl. JSDoc
        .replace(/^\s*\/\/.*$/gm, "") // whole-line // comments
        .replace(/\/\/[^\n"'`]*$/gm, ""); // trailing // comments (crude, but this is a test)
}
test("NO EXECUTABLE CODE MAY READ AN ANTHROPIC API KEY", () => {
    // The static half of the guarantee. The moment something READS ANTHROPIC_API_KEY, or POSTs to
    // api.anthropic.com, this system starts costing money per token. That is not a thing to catch in
    // review — it is a thing to catch in CI.
    //
    // no-billing.ts is exempt: it names the variables in order to DELETE them.
    const roots = ["apps/worker/src", "apps/web/app", "packages/shared/src", "scripts"];
    const offenders = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir)) {
            const p = join(dir, e);
            if (statSync(p).isDirectory()) {
                if (e === "node_modules" || e.startsWith("."))
                    continue;
                walk(p);
                continue;
            }
            if (!/\.(ts|tsx)$/.test(e))
                continue;
            if (p.includes("no-billing"))
                continue; // it names them to strip them
            const code = codeOnly(readFileSync(p, "utf8"));
            // Reading the key, or setting it on an object we hand to something. Supabase's `apikey:`
            // header is a different thing entirely and stays allowed — hence the ANTHROPIC_ anchor.
            if (/\bANTHROPIC_API_KEY\b|\bANTHROPIC_AUTH_TOKEN\b/.test(code)) {
                offenders.push(`${p} — reads/sets an Anthropic API key`);
            }
            if (/api\.anthropic\.com/.test(code)) {
                offenders.push(`${p} — calls the metered API directly`);
            }
            // The Anthropic SDK itself. This repo talks to Claude through the AGENT SDK
            // (@anthropic-ai/claude-agent-sdk), which spawns the CLI and uses the subscription. The
            // plain SDK (@anthropic-ai/sdk) is an API client and needs a key.
            if (/from ["']@anthropic-ai\/sdk["']/.test(code)) {
                offenders.push(`${p} — imports the metered API SDK (@anthropic-ai/sdk)`);
            }
        }
    };
    for (const r of roots)
        walk(join(REPO_ROOT, r));
    assert.deepEqual(offenders, [], `Executable code is reaching for metered Anthropic billing. This system runs on the ~/.claude ` +
        `SUBSCRIPTION (a flat fee) and must never be billed per token:\n  ${offenders.join("\n  ")}`);
});
test("every Claude spawn site launders its environment", () => {
    // The dynamic half. There are exactly three places that call the SDK's query(), and if a fourth
    // is ever added without subscriptionEnv(), it inherits process.env — including an API key — and
    // silently bills it. The SDK's own docs: `env` "Defaults to `process.env`".
    const spawnSites = [
        "apps/worker/src/claude/session.ts",
        "apps/worker/src/stages/classify.ts",
        "scripts/build-summary.ts",
    ];
    for (const rel of spawnSites) {
        const src = readFileSync(join(REPO_ROOT, rel), "utf8");
        assert.match(src, /query\(\{/, `${rel} should still be a spawn site`);
        assert.match(src, /env:\s*subscriptionEnv\(/, `${rel} calls the Agent SDK but does NOT launder its environment. Without ` +
            `env: subscriptionEnv(), the child inherits ANTHROPIC_API_KEY from the shell and every ` +
            `call is billed, metered, per token.`);
    }
});
