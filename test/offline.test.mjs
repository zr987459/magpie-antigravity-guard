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
assert.ok(piOut.includes("within pi"), piOut)

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

console.log(
  `OFFLINE_SUITE_OK platform=${os.platform()} dir=${_internal.PLUGIN_DIR} dynamicRules=${_internal.dynamicState.rules.length}`,
)
