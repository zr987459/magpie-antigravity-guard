import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-guard-test-"))
const loginsPath = path.join(tmpDir, "logins.json")
const cooldownsPath = path.join(tmpDir, "cooldowns.json")
const alertsPath = path.join(tmpDir, "rule-alerts.jsonl")
const triggerPath = path.join(tmpDir, "sync-trigger.flag")
const rulesPath = path.join(tmpDir, "dynamic-rules.json")

fs.writeFileSync(rulesPath, JSON.stringify({ version: 1, saidAs: {}, reworded: [], userTurnedAway: [], customRules: {} }), "utf8")
fs.writeFileSync(loginsPath, JSON.stringify([]), "utf8")

process.env.MAGPIE_AG_DYNAMIC_RULES_PATH = rulesPath
process.env.MAGPIE_AG_LOGINS_PATH = loginsPath
process.env.MAGPIE_AG_COOLDOWNS_PATH = cooldownsPath
process.env.MAGPIE_AG_RULE_ALERTS_PATH = alertsPath
process.env.MAGPIE_AG_SYNC_TRIGGER_PATH = triggerPath

const { _internal } = await import("../index.mjs")

// Block global fetch
globalThis.fetch = async (url) => {
  throw new Error(`TEST BLOCKED GLOBAL FETCH: ${url}`)
}

const origHttpsRequest = https.request
let mockHandlers = {}
let callLog = []

function installHttpsMock() {
  https.request = (opts, cb) => {
    const reqPath = String(opts?.path ?? "")
    const host = String(opts?.hostname ?? "")
    let bodyStr = ""
    const req = new EventEmitter()
    req.setTimeout = () => {}
    req.destroy = () => {}
    req.write = (chunk) => {
      bodyStr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "")
    }
    req.end = () => {
      const authHdr = String(opts?.headers?.Authorization ?? opts?.headers?.authorization ?? "")
      const token = authHdr.replace(/^Bearer\s+/i, "")
      callLog.push({ host, path: reqPath, token, body: bodyStr })
      setImmediate(() => {
        const res = new EventEmitter()
        res.headers = { "content-type": "application/json" }
        res.complete = true
        res.pause = () => {}
        res.resume = () => {}
        res.destroy = () => {}

        let reply = { status: 200, body: "{}" }
        if (typeof mockHandlers.handle === "function") {
          reply = mockHandlers.handle({ host, path: reqPath, token, body: bodyStr }) || reply
        }
        res.statusCode = reply.status ?? 200
        res.statusMessage = reply.statusMessage ?? "OK"
        if (reply.headers) res.headers = { ...res.headers, ...reply.headers }
        cb(res)
        if (reply.body) {
          res.emit("data", Buffer.from(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)))
        }
        res.emit("end")
      })
    }
    return req
  }
}

function resetAll() {
  _internal.cooldowns.clear()
  _internal.recentRiskEvents.length = 0
  _internal.tokens.clear()
  _internal.tokenInFlight.clear()
  _internal.projects.clear()
  _internal.lists.clear()
  _internal.accountRateWindows.clear()
  _internal.planDowngradeAlerts.clear()
  _internal.loginsPlanCache.checkedAt = 0
  _internal.loginsPlanCache.mtimeMs = -1
  _internal.loginsPlanCache.byEmail.clear()
  callLog = []
  for (const p of [cooldownsPath, alertsPath, triggerPath]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch {}
  }
  fs.writeFileSync(loginsPath, JSON.stringify([]), "utf8")
  fs.writeFileSync(rulesPath, JSON.stringify({ version: 1, saidAs: {}, reworded: [], userTurnedAway: [], customRules: {} }), "utf8")
  _internal.reloadDynamicRules(true)
  delete process.env.AG_PLAN_GUARD_ENABLED
  delete process.env.AG_ALLOW_FREE_EMAILS
  delete process.env.AG_PLAN_GUARD_COOLDOWN_MS
  delete process.env.AG_RATE_GUARD_ENABLED
  delete process.env.AG_MAX_REQ_PER_HOUR
  delete process.env.AG_MAX_REQ_PER_5M
  delete process.env.AG_ULTRA_MAX_REQ_PER_HOUR
  delete process.env.AG_ULTRA_MAX_REQ_PER_5M
  delete process.env.AG_ULTRA_RATE_COOLDOWN_MIN_MS
  delete process.env.AG_ULTRA_RATE_COOLDOWN_MAX_MS
  delete process.env.AG_RATE_COOLDOWN_MIN_MS
  delete process.env.AG_RATE_COOLDOWN_MAX_MS
}

try {
  installHttpsMock()

  // =========================================================================
  // 1. Plan classification truth table
  // =========================================================================
  assert.equal(_internal.classifyAccountPlan({ tier: "free-tier", paid: "g1-pro-tier", plan: "Google AI Pro" }).status, "paid")
  assert.equal(_internal.classifyAccountPlan({ tier: "free-tier", paid: "g1-ultra-tier", plan: "Google AI Ultra" }).status, "paid")
  assert.equal(_internal.classifyAccountPlan({ tier: "free-tier", paid: "", plan: "Google AI Pro" }).status, "paid")
  assert.equal(_internal.classifyAccountPlan({ tier: "standard-tier", paid: "", plan: "Antigravity Starter Quota" }).status, "free")
  assert.equal(_internal.classifyAccountPlan({ tier: "free-tier", paid: "", plan: "Antigravity" }).status, "free")
  assert.equal(_internal.classifyAccountPlan({ tier: "starter-tier", paid: "", plan: "" }).status, "free")
  assert.equal(_internal.classifyAccountPlan({ tier: "", paid: "", plan: "", loginsPlan: "" }).status, "unknown")
  assert.equal(_internal.classifyAccountPlan({ tier: "legacy-tier", paid: "", plan: "", loginsPlan: "" }).status, "unknown")
  assert.equal(_internal.classifyAccountPlan({ tier: "", paid: "", plan: "", loginsPlan: "Antigravity Starter Quota" }).status, "free")
  assert.equal(_internal.classifyAccountPlan({ tier: "", paid: "", plan: "", loginsPlan: "Google AI Pro" }).status, "paid")
  // Live loadCodeAssist overrides stale logins.json in both directions
  assert.equal(_internal.classifyAccountPlan({ tier: "free-tier", paid: "g1-pro-tier", plan: "Google AI Pro", loginsPlan: "Antigravity Starter Quota" }).status, "paid")
  assert.equal(_internal.classifyAccountPlan({ tier: "standard-tier", paid: "", plan: "Antigravity Starter Quota", loginsPlan: "Google AI Pro" }).status, "free")

  // =========================================================================
  // 2. Plan Guard end-to-end in complete(): Starter blocked, Pro/Ultra/Unknown allowed
  // =========================================================================
  resetAll()
  const sPro = { rt: "rt-pro", project: "proj-pro", access: "tok-pro", expires: Date.now() + 3600_000, who: "pro@example.com" }
  const sUltra = { rt: "rt-ultra", project: "proj-ultra", access: "tok-ultra", expires: Date.now() + 3600_000, who: "ultra@example.com" }
  const sUnknown = { rt: "rt-unk", project: "proj-unk", access: "tok-unk", expires: Date.now() + 3600_000, who: "unk@example.com" }
  const sFree = { rt: "rt-free", project: "proj-free", access: "tok-free", expires: Date.now() + 3600_000, who: "starter@example.com" }

  const planByToken = {
    "tok-pro": { currentTier: { id: "free-tier", name: "Antigravity" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } },
    "tok-ultra": { currentTier: { id: "free-tier", name: "Antigravity" }, paidTier: { id: "g1-ultra-tier", name: "Google AI Ultra" } },
    "tok-unk": { currentTier: { id: "legacy-tier" } }, // unknown tier -> allow
    "tok-free": { currentTier: { id: "standard-tier", name: "Antigravity Starter Quota" } },
  }

  mockHandlers.handle = ({ path: reqPath, token }) => {
    if (reqPath.includes("loadCodeAssist")) {
      return { status: 200, body: planByToken[token] ?? {} }
    }
    if (reqPath.includes("fetchAvailableModels")) {
      return { status: 200, body: { models: { "gemini-4-hydrogen-high": { displayName: "Gemini 4 Hydrogen (High)", maxTokens: 1000000 } } } }
    }
    if (reqPath.includes("streamGenerateContent")) {
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n',
      }
    }
    return { status: 200, body: {} }
  }

  const makeReqInit = () => ({
    method: "POST",
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
  })
  const url = "https://daily-cloudcode-pa.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent"

  // Pro, Ultra, Unknown all pass
  for (const acct of [sPro, sUltra, sUnknown]) {
    const r = await _internal.complete(acct, url, makeReqInit())
    assert.equal(r.status, 200, `Expected 200 for ${acct.who}`)
  }

  // Starter account is blocked BEFORE streamGenerateContent
  callLog = []
  const rFree1 = await _internal.complete(sFree, url, makeReqInit())
  assert.equal(rFree1.status, 429, "Starter account must be blocked with 429 for failover")
  assert.ok(Number(rFree1.headers.get("retry-after")) >= 3600, "Retry-After should reflect 6h cooldown")
  assert.equal(callLog.some((c) => c.token === "tok-free" && c.path.includes("streamGenerateContent")), false, "Must NEVER send inference to Google for Starter account")
  assert.equal(callLog.some((c) => c.token === "tok-free" && c.path.includes("fetchAvailableModels")), false, "Should abort before fetchAvailableModels too")
  assert.equal(_internal.cooldowns.has(_internal.GLOBAL_BREAKER_KEY), false, "Plan guard must NEVER trigger global:breaker")

  const freeCd = _internal.cooldowns.get(`acct:${sFree.rt}`)
  assert.ok(freeCd && freeCd.reason === "plan_downgraded" && freeCd.persisted === true)
  assert.equal(fs.existsSync(cooldownsPath), true)
  assert.equal(fs.readFileSync(alertsPath, "utf8").trim().split("\n").length, 1, "Should write 1 deduped alert")

  // Second request for Starter is blocked locally in fast-path (0 network calls!)
  callLog = []
  const rFree2 = await _internal.complete(sFree, url, makeReqInit())
  assert.equal(rFree2.status, 429)
  assert.equal(callLog.length, 0, "Cached plan_downgraded cooldown must make 0 network calls")
  assert.equal(fs.readFileSync(alertsPath, "utf8").trim().split("\n").length, 1, "Alert must be deduped within 6h")

  // Pro account still works fine while Starter is blocked
  const rPro2 = await _internal.complete(sPro, url, makeReqInit())
  assert.equal(rPro2.status, 200)

  // =========================================================================
  // 3. Self-healing: usage() throttling + upgrade to Pro + whitelist + expiry
  // =========================================================================
  // Throttled usage() within 10m makes 0 network calls
  callLog = []
  const uThrottled = await _internal.usage({ type: "oauth", refresh: `${sFree.rt}|${sFree.project}`, access: sFree.access, expires: sFree.expires, accountId: sFree.who })
  assert.equal(callLog.length, 0, "usage() during cooldown within 10m must not hammer loadCodeAssist")
  assert.ok(uThrottled.error && uThrottled.plan)

  // Once probe interval elapsed and Google upgrades account back to Pro, usage() auto-recovers
  const cdEntry = _internal.cooldowns.get(`acct:${sFree.rt}`)
  cdEntry.lastProbeAt = Date.now() - (_internal.PLAN_GUARD_PROBE_INTERVAL_MS + 1000)
  planByToken["tok-free"] = { currentTier: { id: "free-tier", name: "Antigravity" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }
  const uHealed = await _internal.usage({ type: "oauth", refresh: `${sFree.rt}|${sFree.project}`, access: sFree.access, expires: sFree.expires, accountId: sFree.who })
  assert.equal(uHealed.plan, "Google AI Pro")
  assert.equal(uHealed.error, undefined)
  assert.equal(_internal.cooldowns.has(`acct:${sFree.rt}`), false, "plan_downgraded cooldown must auto-clear after renewal")

  // Subsequent complete() succeeds immediately
  const rHealed = await _internal.complete(sFree, url, makeReqInit())
  assert.equal(rHealed.status, 200)

  // Downgrade again -> cooldown expires -> re-probe -> stays free -> re-arms!
  planByToken["tok-free"] = { currentTier: { id: "standard-tier", name: "Antigravity Starter Quota" } }
  _internal.projects.delete(sFree.rt)
  const rDowngradedAgain = await _internal.complete(sFree, url, makeReqInit())
  assert.equal(rDowngradedAgain.status, 429)
  assert.ok(_internal.cooldowns.get(`acct:${sFree.rt}`)?.reason === "plan_downgraded")

  // Simulate cooldown expiry while logins.json is still stale Starter
  fs.writeFileSync(loginsPath, JSON.stringify([{ agent: "plugin:antigravity", user: sFree.who, plan: "Antigravity Starter Quota" }]), "utf8")
  _internal.cooldowns.get(`acct:${sFree.rt}`).until = Date.now() - 1000
  planByToken["tok-free"] = { currentTier: { id: "free-tier", name: "Antigravity" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }
  const rExpiredNowPro = await _internal.complete(sFree, url, makeReqInit())
  assert.equal(rExpiredNowPro.status, 200, "Expired cooldown must re-probe live loadCodeAssist and recover even if logins.json is stale")

  // Test AG_ALLOW_FREE_EMAILS whitelist
  planByToken["tok-free"] = { currentTier: { id: "standard-tier", name: "Antigravity Starter Quota" } }
  _internal.projects.delete(sFree.rt)
  assert.equal((await _internal.complete(sFree, url, makeReqInit())).status, 429)
  process.env.AG_ALLOW_FREE_EMAILS = "starter@example.com"
  assert.equal((await _internal.complete(sFree, url, makeReqInit())).status, 200, "Whitelisted free email must bypass plan guard and clear cooldown")
  assert.equal(_internal.cooldowns.has(`acct:${sFree.rt}`), false)
  delete process.env.AG_ALLOW_FREE_EMAILS

  // Existing 403 TOS_VIOLATION must NOT be overwritten by plan_downgraded
  _internal.cooldowns.set(`acct:${sFree.rt}`, {
    until: Date.now() + 24 * 3600_000,
    status: 403,
    message: "TOS_VIOLATION",
    strikes: 1,
    persisted: true,
  })
  _internal.evaluatePlanGuard(sFree, { plan: "Antigravity Starter Quota", tier: "standard-tier", paid: "" })
  assert.equal(_internal.cooldowns.get(`acct:${sFree.rt}`).status, 403, "Must never overwrite 403 TOS_VIOLATION cooldown")

  // =========================================================================
  // 4. Per-Account Soft Rate Guard (5m burst & 1h cap)
  // =========================================================================
  resetAll()
  const sA = { rt: "rt-rate-a", project: "proj-a", access: "tok-pro", expires: Date.now() + 3600_000, who: "rateA@example.com" }
  const sB = { rt: "rt-rate-b", project: "proj-b", access: "tok-pro", expires: Date.now() + 3600_000, who: "rateB@example.com" }
  process.env.AG_MAX_REQ_PER_5M = "4"
  process.env.AG_MAX_REQ_PER_HOUR = "100"

  // Management requests (countTokens / usage) must NOT count toward inference rate window
  assert.equal((await _internal.complete(sA, "https://daily-cloudcode-pa.googleapis.com/v1beta/models/gemini-4-hydrogen:countTokens", makeReqInit())).status, 404)
  await _internal.usage({ type: "oauth", refresh: `${sA.rt}|${sA.project}`, access: sA.access, expires: sA.expires, accountId: sA.who })
  assert.equal(_internal.accountRateWindows.size, 0, "Non-inference calls must not increment rate window")

  // First 4 inference calls succeed
  for (let i = 0; i < 4; i++) {
    const res = await _internal.complete(sA, url, makeReqInit())
    assert.equal(res.status, 200, `Request #${i + 1} should pass`)
  }
  // 5th call triggers 5m soft burst guard -> 429 + Retry-After, 0 upstream streamGenerateContent call!
  callLog = []
  const rBurst = await _internal.complete(sA, url, makeReqInit())
  assert.equal(rBurst.status, 429)
  const retry5m = Number(rBurst.headers.get("retry-after"))
  assert.ok(retry5m >= 15 && retry5m <= 300, `Expected cooldown 15..300s, got ${retry5m}s`)
  assert.equal(callLog.some((c) => c.path.includes("streamGenerateContent")), false, "Rate-limited call must not hit upstream")
  assert.equal(_internal.cooldowns.has(_internal.GLOBAL_BREAKER_KEY), false, "Rate guard must NEVER trigger global:breaker")
  assert.equal(fs.existsSync(cooldownsPath), false, "Soft rate cooldown must be memory-only (persisted: false)")
  assert.equal(fs.existsSync(alertsPath), false, "Soft rate cooldown must not emit rule-alerts.jsonl")

  // Account B is completely unaffected!
  const rB = await _internal.complete(sB, url, makeReqInit())
  assert.equal(rB.status, 200, "Account B must remain completely unaffected when Account A yields")

  // usage() on Account A STILL works while Account A is soft-rate-limited
  const uA = await _internal.usage({ type: "oauth", refresh: `${sA.rt}|${sA.project}`, access: sA.access, expires: sA.expires, accountId: sA.who })
  assert.equal(uA.plan, "Google AI Pro")

  // Hourly cap check (with timestamps spread > 5m ago so 5m window is 0, 1h window hits limit)
  resetAll()
  process.env.AG_MAX_REQ_PER_5M = "45"
  process.env.AG_MAX_REQ_PER_HOUR = "6"
  const now = Date.now()
  const keyA = _internal.accountSalt(sA)
  // 6 requests from 20-40 minutes ago
  _internal.accountRateWindows.set(keyA, [
    now - 40 * 60_000,
    now - 35 * 60_000,
    now - 30 * 60_000,
    now - 25 * 60_000,
    now - 20 * 60_000,
    now - 15 * 60_000,
  ])
  callLog = []
  const rHour = await _internal.complete(sA, url, makeReqInit())
  assert.equal(rHour.status, 429)
  const retry1h = Number(rHour.headers.get("retry-after"))
  assert.equal(retry1h, 300, "1h soft cooldown should cap cleanly at 300s (5m)")
  assert.equal(_internal.cooldowns.has(_internal.GLOBAL_BREAKER_KEY), false)
  assert.equal(fs.existsSync(cooldownsPath), false)

  // Recovery when window slides past 1h
  _internal.cooldowns.get(`acct:${sA.rt}`).until = Date.now() - 1000
  _internal.accountRateWindows.set(keyA, [now - 61 * 60_000]) // expired out of 1h window
  const rRecovered = await _internal.complete(sA, url, makeReqInit())
  assert.equal(rRecovered.status, 200, "Account must recover automatically once window slides")

  // =========================================================================
  // 5. Ultra Tier Soft Rate Guard Scaling (Google AI Ultra / g1-ultra-tier)
  // =========================================================================
  resetAll()
  planByToken["tok-ultra"] = { currentTier: { id: "free-tier", name: "Antigravity" }, paidTier: { id: "g1-ultra-tier", name: "Google AI Ultra" } }
  const sUltraRate = { rt: "rt-rate-ultra", project: "proj-ultra", access: "tok-ultra", expires: Date.now() + 3600_000, who: "ultra@example.com" }

  assert.equal(_internal.isUltraAccount(sUltraRate, { plan: "Google AI Ultra", tier: "free-tier", paid: "g1-ultra-tier" }), true)
  assert.equal(_internal.isUltraAccount(sA, { plan: "Google AI Pro", tier: "free-tier", paid: "g1-pro-tier" }), false)

  const proLimits = _internal.rateGuardLimits(false)
  const ultraLimits = _internal.rateGuardLimits(true)
  assert.equal(proLimits.maxPerHour, 200)
  assert.equal(proLimits.maxPer5m, 45)
  assert.equal(ultraLimits.maxPerHour, 600)
  assert.equal(ultraLimits.maxPer5m, 150)
  assert.equal(ultraLimits.maxCooldownMs, 60_000)

  // Ultra account survives 50 burst requests (which would exceed Pro 45/5m cap) without triggering rate guard
  for (let i = 0; i < 50; i++) {
    const res = await _internal.complete(sUltraRate, url, makeReqInit())
    assert.equal(res.status, 200, `Ultra request #${i + 1} (> Pro 45/5m) should pass`)
  }
  assert.equal(_internal.cooldowns.has(`acct:${sUltraRate.rt}`), false)

  // Custom AG_ULTRA_MAX_REQ_PER_5M override + gentler 60s max cooldown
  process.env.AG_ULTRA_MAX_REQ_PER_5M = "52"
  process.env.AG_ULTRA_MAX_REQ_PER_HOUR = "600"
  for (let i = 0; i < 2; i++) {
    assert.equal((await _internal.complete(sUltraRate, url, makeReqInit())).status, 200)
  }
  const rUltraBurst = await _internal.complete(sUltraRate, url, makeReqInit())
  assert.equal(rUltraBurst.status, 429)
  const ultraRetry = Number(rUltraBurst.headers.get("retry-after"))
  assert.ok(ultraRetry >= 15 && ultraRetry <= 60, `Ultra soft cooldown should be 15..60s, got ${ultraRetry}s`)

  console.log("AG_PLAN_AND_RATE_GUARD_TESTS_OK")
} finally {
  https.request = origHttpsRequest
  resetAll()
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
