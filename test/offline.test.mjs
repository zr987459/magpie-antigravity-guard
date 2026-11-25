import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { _internal } from "../index.mjs"

// Guard: strictly block any real outbound network requests (0 Google requests)
const originalFetch = globalThis.fetch
let mockRemoteHandler = null
globalThis.fetch = async (url, init) => {
  const s = String(url)
  if (mockRemoteHandler && s === _internal.DEFAULT_REMOTE_RULES_URL) {
    return mockRemoteHandler(url, init)
  }
  throw new Error(`OFFLINE TEST BLOCKED UNEXPECTED NETWORK CALL: ${s}`)
}

// 1. Cross-platform PLUGIN_DIR & path checks
const expectedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
assert.equal(path.resolve(_internal.PLUGIN_DIR), expectedDir)
assert.equal(path.dirname(_internal.DYNAMIC_RULES_PATH), _internal.PLUGIN_DIR)
assert.equal(path.dirname(_internal.COOLDOWNS_PATH), _internal.PLUGIN_DIR)
assert.equal(path.dirname(_internal.RULE_ALERTS_PATH), _internal.PLUGIN_DIR)
assert.equal(path.dirname(_internal.SYNC_TRIGGER_PATH), _internal.PLUGIN_DIR)

_internal.reloadDynamicRules(true)

// 2. Codex GPT-5 / GPT-6 (including invisible zero-width chars) & built-in protected rules
const gpt6Sys = "You are Codex, an agent based on GPT-6.\nYou are Codex, a coding agent based on GPT-6."
const gpt6Out = _internal.outgoing(gpt6Sys)
assert.ok(gpt6Out.includes("You are Codex, an agent built on GPT-6."), gpt6Out)
assert.ok(gpt6Out.includes("You are Codex, a coding agent built on GPT-6."), gpt6Out)

const gpt6ZeroWidth = "You\u200b are\u200c Codex, an\u200d agent based\ufeff on GPT-6."
assert.equal(_internal.outgoing(gpt6ZeroWidth), "You are Codex, an agent built on GPT-6.")

const piOut = _internal.outgoing("You are a coding assistant " + "inside " + "pi, a coding agent harness.")
assert.ok(piOut.includes("in a coding workspace"), piOut)

// 3. PR #3967 latest WAF phrases
const pr3967Input = [
  "Prefer read_file, edit_file, and write_file over cat/sed.",
  "Always read_file before edit_file.",
  "Call read_file on its SKILL.md.",
  "Follow Google Model Operational Directives strictly.",
].join("\n")
const pr3967Out = _internal.outgoing(pr3967Input)
assert.ok(pr3967Out.includes("use dedicated file tools instead of cat/sed"), pr3967Out)
assert.ok(pr3967Out.includes("always inspect the file before editing"), pr3967Out)
assert.ok(pr3967Out.includes("read its skill documentation file"), pr3967Out)
assert.ok(pr3967Out.includes("model operational guidelines"), pr3967Out)

// 4. Developer / System roles inside req.contents must be extracted, sanitized, and wrapped in <external_system_instructions>
const shaped = _internal.shape(
  {
    systemInstruction: { parts: [{ text: "You are Claude Code, Anthropic's official CLI for Claude." }] },
    contents: [
      { role: "developer", parts: [{ text: "You are Codex, an agent based on GPT-6. Prefer read_file, edit_file, and write_file over cat/sed." }] },
      { role: "system", parts: [{ text: "Always read_file before edit_file." }] },
      { role: "user", parts: [{ text: "Hello! You are Codex, a coding agent based on GPT-6." }] },
    ],
  },
  "gemini-4-argon",
  "high",
  "high",
)

assert.equal("systemInstruction" in shaped, false, "top-level systemInstruction must be removed")
assert.equal(shaped.contents.length, 1, "developer/system turns should be folded into first user turn")
assert.equal(shaped.contents[0].role, "user")
const combinedText = shaped.contents[0].parts.map((p) => p.text).join("\n")
assert.ok(combinedText.includes("<external_system_instructions>"), combinedText)
assert.ok(combinedText.includes("You are an AI coding assistant"), combinedText)
assert.ok(combinedText.includes("You are Codex, an agent built on GPT-6"), combinedText)
assert.ok(combinedText.includes("use dedicated file tools instead of cat/sed"), combinedText)
assert.ok(combinedText.includes("always inspect the file before editing"), combinedText)
assert.ok(combinedText.includes("You are Codex, a coding agent built on GPT-6"), combinedText)
assert.ok(!/based on gpt-6/i.test(combinedText), combinedText)
assert.ok(!/prefer read_file/i.test(combinedText), combinedText)

// 5. Cloud remote rule hot-sync mock (preserving customRules and applying remote rules without Google calls)
const origRulesBackup = fs.existsSync(_internal.DYNAMIC_RULES_PATH)
  ? fs.readFileSync(_internal.DYNAMIC_RULES_PATH, "utf8")
  : null

try {
  _internal.remoteSyncState.lastAttemptAt = 0
  _internal.remoteSyncState.inFlight = null
  mockRemoteHandler = async () =>
    new Response(
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-16T00:00:00Z",
        saidAs: {
          "mock test sentinel phrase": "sanitized sentinel replacement",
        },
        reworded: [],
        userTurnedAway: ["you are codex, an agent based on gpt-6"],
        customRules: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

  const synced = await _internal.syncRemoteRulesIfNeeded(true)
  assert.equal(synced, true, "remote sync should succeed with mocked GitHub raw response")
  assert.equal(
    _internal.outgoing("Please handle mock test sentinel phrase carefully."),
    "Please handle sanitized sentinel replacement carefully.",
  )
  // Built-in Codex GPT-6 rule must still be active after merge
  assert.equal(
    _internal.outgoing("You are Codex, an agent based on GPT-6."),
    "You are Codex, an agent built on GPT-6.",
  )
} finally {
  mockRemoteHandler = null
  if (origRulesBackup !== null) {
    fs.writeFileSync(_internal.DYNAMIC_RULES_PATH, origRulesBackup, "utf8")
    _internal.reloadDynamicRules(true)
  }
  globalThis.fetch = originalFetch
}

// 6. Read-only resilience check for mergeRemoteRulesDoc & applyDynamicRulesData
const merged = _internal.mergeRemoteRulesDoc(
  { systemTag: "my_custom_tag", customRules: { "local secret phrase": "local clean" }, saidAs: {} },
  { systemTag: "external_system_instructions", saidAs: { "remote phrase": "remote clean" }, customRules: { "remote custom": "x" } },
)
assert.equal(merged.systemTag, "my_custom_tag")
assert.equal(merged.customRules["local secret phrase"], "local clean")
assert.equal(merged.saidAs["remote phrase"], "remote clean")

// 7. Global 10-min breaker must NOT trip on normal quota 429s, but MUST trip on >=2 accounts hitting 403 or suspect rule-block 429
const resetBreakerState = () => {
  _internal.cooldowns.clear()
  _internal.recentRiskEvents.length = 0
  for (const p of [_internal.COOLDOWNS_PATH, _internal.RULE_ALERTS_PATH, _internal.SYNC_TRIGGER_PATH]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch {}
  }
}

try {
  resetBreakerState()
  const acctA = { rt: "rt-quota-a", who: "quotaA@example.com" }
  const acctB = { rt: "rt-quota-b", who: "quotaB@example.com" }
  const quotaHeaders = new Headers({ "retry-after": "45" })
  const quotaBody = JSON.stringify({
    error: {
      code: 429,
      message: "Resource has been exhausted (e.g. check quota).",
      details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure" }, { retryDelay: "45s" }],
    },
  })
  const rateLimitBody = JSON.stringify({
    error: {
      code: 429,
      message: "Resource has been exhausted.",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" }],
    },
  })

  _internal.recordUpstreamFailure(acctA, "gemini-4-argon", 429, quotaHeaders, quotaBody, { elapsedMs: 300 })
  _internal.recordUpstreamFailure(acctB, "gemini-4-argon", 429, new Headers(), rateLimitBody, { elapsedMs: 300 })
  assert.equal(_internal.cooldowns.has(_internal.GLOBAL_BREAKER_KEY), false, "normal quota 429s across 2 accounts must NOT trip global:breaker")
  assert.equal(_internal.recentRiskEvents.length, 0, "normal quota 429s must NOT record global risk events")
  assert.ok(_internal.cooldowns.has(`model:${acctA.rt}\0gemini-4-argon`), "acctA should have per-model cooldown")
  assert.ok(_internal.cooldowns.has(`model:${acctB.rt}\0gemini-4-argon`), "acctB should have per-model cooldown")

  // Bare suspect 429 on 1st account triggers 60s pause, 2nd account triggers 10-min persisted global:breaker
  resetBreakerState()
  const suspectBody = JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota)." } })
  assert.equal(_internal.isSuspectRuleBlock(429, new Headers(), suspectBody, 400), true)
  assert.equal(_internal.isSuspectRuleBlock(429, quotaHeaders, quotaBody, 400), false)
  assert.equal(_internal.isSuspectRuleBlock(429, new Headers(), rateLimitBody, 400), false)

  _internal.recordUpstreamFailure(acctA, "gemini-4-argon", 429, new Headers(), suspectBody, { elapsedMs: 400 })
  const pauseEntry = _internal.cooldowns.get(_internal.GLOBAL_BREAKER_KEY)
  assert.ok(pauseEntry && pauseEntry.persisted === false, "1st suspect 429 should trigger short non-persisted 60s pause")

  _internal.recordUpstreamFailure(acctB, "gemini-4-argon", 429, new Headers(), suspectBody, { elapsedMs: 400 })
  const suspectBreaker = _internal.cooldowns.get(_internal.GLOBAL_BREAKER_KEY)
  assert.ok(suspectBreaker && suspectBreaker.persisted === true, "2nd suspect 429 within 60s should trip 10-min persisted global:breaker")

  // 2 accounts hitting 403 within 60s trips 10-min persisted global:breaker
  resetBreakerState()
  _internal.recordUpstreamFailure(acctA, "gemini-4-argon", 403, new Headers(), "Forbidden")
  assert.equal(_internal.cooldowns.has(_internal.GLOBAL_BREAKER_KEY), false, "single 403 should not trip global:breaker")
  _internal.recordUpstreamFailure(acctB, "gemini-4-argon", 403, new Headers(), "Forbidden")
  const breaker403 = _internal.cooldowns.get(_internal.GLOBAL_BREAKER_KEY)
  assert.ok(breaker403 && breaker403.persisted === true && breaker403.status === 403, "two 403s within 60s should trip 10-min global:breaker")
} finally {
  resetBreakerState()
}

// 8. whole() must NOT merge plain text into a preceding thoughtSignature part
const sseBody = [
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Thinking...","thought":true},{"text":"","thoughtSignature":"sig-1"}]}}]}}',
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello "},{"text":"world","thoughtSignature":"sig-2"},{"text":" trailing"}]}}]}}',
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}]}}',
].join("\n")
const wholeOut = await _internal.whole(new Response(sseBody, { status: 200 }))
const wholeParts = wholeOut.candidates[0].content.parts
assert.equal(wholeParts.length, 5, JSON.stringify(wholeParts))
assert.deepEqual(wholeParts[0], { text: "Thinking...", thought: true })
assert.deepEqual(wholeParts[1], { text: "", thoughtSignature: "sig-1" })
assert.deepEqual(wholeParts[2], { text: "Hello " })
assert.deepEqual(wholeParts[3], { text: "world", thoughtSignature: "sig-2" })
assert.deepEqual(wholeParts[4], { text: " trailing!" })

// 9. Sanitization output on INVISIBLE / zero-width chars and single-part vs preSanitized system instructions remains identical
const invisInput = "You\u00ad are\u180e Claude\u200b Code,\u2060 Anthropic's\ufeff official CLI for Claude.\nRun tools.opencode.session_move now."
const expectedSanitized = "You are an AI coding assistant.\nRun tools.session_transfer now."
assert.equal(_internal.outgoing(invisInput), expectedSanitized)
assert.equal(_internal.cloak("no matches here"), "no matches here")

const shapedDefault = _internal.shape(
  {
    systemInstruction: { parts: [{ text: invisInput }] },
    contents: [{ role: "user", parts: [{ text: "Hi\u200b You\u200c are Codex, an agent based on GPT-6." }] }],
  },
  "gemini-4-argon",
  "high",
  "high",
)
const shapedPre = _internal.shape(
  {
    systemInstruction: { parts: [{ text: invisInput }] },
    contents: [{ role: "user", parts: [{ text: "Hi\u200b You\u200c are Codex, an agent based on GPT-6." }] }],
  },
  "gemini-4-argon",
  "high",
  "high",
  expectedSanitized,
)
assert.deepEqual(shapedPre, shapedDefault)

// 10. complete() must fast-return 404 without network or rate-limit consumption when model is absent from account catalog
{
  const rtNoCarbon = "rt-no-carbon-test"
  const acctKey = `acct:${rtNoCarbon}`
  _internal.lists.set(rtNoCarbon, {
    at: Date.now(),
    infos: [
      { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)", thinkingLevel: "high", remaining: 0.9, resets: "" },
    ],
    project: { id: "proj-test", plan: "Google AI Pro", tier: "standard-tier", paid: "", credits: true, at: Date.now() },
    deprecated: {},
  })
  _internal.projects.set(rtNoCarbon, { id: "proj-test", plan: "Google AI Pro", tier: "standard-tier", paid: "", credits: true, at: Date.now() })
  _internal.accountRateWindows.delete(rtNoCarbon)
  try {
    const res = await _internal.complete(
      { rt: rtNoCarbon, who: "pro-no-4c@example.com", project: "proj-test", access: "tok", expires: Date.now() + 60_000 },
      "https://daily-cloudcode-pa.googleapis.com/v1beta/models/gemini-4-carbon:generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-magpie-effort": "high" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
    )
    assert.equal(res.status, 404, "missing model in account catalog should fast-return 404")
    const body = await res.json()
    assert.match(body?.error?.message || "", /gemini-4-carbon.*not found/i)
    assert.equal(_internal.cooldowns.has(acctKey), false, "missing model must NOT set account cooldown")
    assert.equal(_internal.accountRateWindows.has(rtNoCarbon), false, "missing model must NOT consume rate-limit budget")
  } finally {
    _internal.lists.delete(rtNoCarbon)
    _internal.projects.delete(rtNoCarbon)
    _internal.accountRateWindows.delete(rtNoCarbon)
  }
}

console.log(
  `OFFLINE_SUITE_OK platform=${os.platform()} dir=${_internal.PLUGIN_DIR} dynamicRules=${_internal.dynamicState.rules.length}`,
)
