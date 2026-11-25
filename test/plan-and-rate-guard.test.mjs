import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-guard-test-"))
const WARMUP_FILE = path.join(tmpDir, "account-warmup.json")
const PROXIES_FILE = path.join(tmpDir, "account-proxies.json")
const LOGINS_FILE = path.join(tmpDir, "logins.json")
const COOLDOWNS_FILE = path.join(tmpDir, "cooldowns.json")
const ALERTS_FILE = path.join(tmpDir, "rule-alerts.jsonl")
const RULES_FILE = path.join(tmpDir, "dynamic-rules.json")

fs.copyFileSync(new URL("../dynamic-rules.json", import.meta.url), RULES_FILE)

process.env.MAGPIE_AG_WARMUP_PATH = WARMUP_FILE
process.env.MAGPIE_AG_PROXIES_PATH = PROXIES_FILE
process.env.MAGPIE_AG_LOGINS_PATH = LOGINS_FILE
process.env.MAGPIE_AG_COOLDOWNS_PATH = COOLDOWNS_FILE
process.env.MAGPIE_AG_RULE_ALERTS_PATH = ALERTS_FILE
process.env.MAGPIE_AG_DYNAMIC_RULES_PATH = RULES_FILE

// Block global fetch during tests
globalThis.fetch = async (url) => {
  throw new Error(`TEST BLOCKED GLOBAL FETCH: ${url}`)
}

const { _internal } = await import("../index.mjs")

function resetAllState() {
  _internal.cooldowns.clear()
  _internal.recentRiskEvents.length = 0
  _internal.tokens.clear()
  _internal.tokenInFlight.clear()
  _internal.projects.clear()
  _internal.lists.clear()
  _internal.accountRateWindows.clear()
  _internal.accountInflightLeases.clear()
  _internal.planDowngradeAlerts.clear()
  _internal.accountEmailsByKey.clear()
  _internal.accountWarmupState.loaded = false
  _internal.accountWarmupState.mtimeMs = -1
  _internal.accountWarmupState.accounts = {}
  _internal.accountWarmupState.loggedTiers.clear()
  _internal.accountProxiesState.loaded = false
  _internal.accountProxiesState.checkedAt = 0
  _internal.accountProxiesState.mtimeMs = -1
  _internal.accountProxiesState.defaultProxy = null
  _internal.accountProxiesState.accounts = new Map()
  _internal.accountProxiesState.loggedSelections.clear()
  _internal.loginsPlanCache.checkedAt = 0
  _internal.loginsPlanCache.mtimeMs = -1
  _internal.loginsPlanCache.byEmail = new Map()
  _internal.accountPoolManager.destroyAll()
  for (const p of [WARMUP_FILE, PROXIES_FILE, LOGINS_FILE, COOLDOWNS_FILE, ALERTS_FILE]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch {}
  }
}

function makeFakeModelCatalog(s, planInfo = { id: "proj-1", plan: "Google AI Pro", tier: "g1-pro-tier", paid: "g1-pro-tier", credits: false }) {
  _internal.tokens.set(s.rt, { access: "tok-" + s.rt, expires: Date.now() + 3600_000 })
  _internal.projects.set(s.rt, { ...planInfo, at: Date.now() })
  _internal.lists.set(s.rt, {
    at: Date.now(),
    project: { ...planInfo, at: Date.now() },
    infos: [{ id: "gemini-3-flash", name: "Gemini 3 Flash", context: 1000000, output: 8192, remaining: 1 }],
    deprecated: {},
  })
}

const VALID_BODY = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] })

try {
  // =========================================================================
  // 1. Plan Guard (free downgrade isolation & recovery)
  // =========================================================================
  resetAllState()
  assert.equal(_internal.classifyAccountPlan({ tier: "free-tier", plan: "Antigravity Starter Quota" }).status, "free")
  assert.equal(_internal.classifyAccountPlan({ paid: "g1-ultra-tier", tier: "g1-ultra-tier", plan: "Google AI Ultra" }).status, "paid")
  assert.equal(_internal.classifyAccountPlan({}).status, "unknown")

  const freeAcct = { rt: "rt-free-1", who: "free@example.com" }
  const guardFree = _internal.evaluatePlanGuard(freeAcct, { plan: "Antigravity Starter Quota", tier: "free-tier", paid: "" })
  assert.equal(guardFree.blocked, true)
  assert.equal(_internal.cooldowns.has(_internal.GLOBAL_BREAKER_KEY), false, "plan_downgraded must NOT trip global:breaker")
  assert.equal(_internal.cooldowns.get(`acct:${freeAcct.rt}`)?.reason, "plan_downgraded")

  // Recovery when upgraded to paid -> clears cooldown & marks upgradedAt for warmup!
  const guardUpgraded = _internal.evaluatePlanGuard(freeAcct, { plan: "Google AI Ultra", tier: "g1-ultra-tier", paid: "g1-ultra-tier" })
  assert.equal(guardUpgraded.blocked, false)
  assert.equal(_internal.cooldowns.has(`acct:${freeAcct.rt}`), false)

  // =========================================================================
  // 2. 48-Hour Warmup Ramp-up Guard + Old Account Exemption
  // =========================================================================
  resetAllState()
  const now = Date.UTC(2026, 10, 25, 21, 0, 0)
  const loginsSeed = [
    { agent: "plugin:antigravity", user: "old-pro-1@example.com", plan: "Google AI Pro", seen: new Date(now - 12 * 24 * 3600_000).toISOString() },
    { agent: "plugin:antigravity", user: "old-pro-2@example.com", plan: "Google AI Pro", seen: new Date(now - 12 * 24 * 3600_000).toISOString() },
    { agent: "plugin:antigravity", user: "old-pro-3@example.com", plan: "Google AI Pro", seen: new Date(now - 8 * 24 * 3600_000).toISOString() },
    { agent: "plugin:antigravity", user: "new-ultra-1@example.com", plan: "Google AI Ultra", seen: new Date(now - 10 * 60_000).toISOString() },
  ]
  fs.writeFileSync(LOGINS_FILE, JSON.stringify(loginsSeed, null, 2), "utf8")

  _internal.seedWarmupFromLogins(now, true)
  assert.equal(fs.existsSync(WARMUP_FILE), true, "account-warmup.json must be created")
  const stWarm = fs.statSync(WARMUP_FILE)
  assert.equal(stWarm.mode & 0o777, 0o600, "account-warmup.json permissions must be 0600")
  const warmupText = fs.readFileSync(WARMUP_FILE, "utf8")
  assert.equal(warmupText.includes("old-pro-1@example.com"), false, "account-warmup.json must not store raw email")

  // Old Pro accounts -> immediately pro-mature (2c / 8 / 30 / 120)
  const oldProAcct = { rt: "rt-old-pro-2", who: "old-pro-1@example.com" }
  const oldTier = _internal.resolveAccountRateTier(oldProAcct, now, { plan: "Google AI Pro", tier: "g1-pro-tier", paid: "g1-pro-tier" })
  assert.equal(oldTier.tier, "pro-mature")
  assert.equal(oldTier.maxInflight, 2)
  assert.equal(oldTier.maxPer1m, 8)
  assert.equal(oldTier.maxPer5m, 30)
  assert.equal(oldTier.maxPerHour, 120)

  // Brand-new Ultra account -> 0~24h ultra-warmup-d1 (1c / 4 / 12 / 45)
  const newUltraAcct = { rt: "rt-new-ultra-1", who: "new-ultra-1@example.com" }
  const ultraProj = { plan: "Google AI Ultra", tier: "g1-ultra-tier", paid: "g1-ultra-tier" }
  const d1Tier = _internal.resolveAccountRateTier(newUltraAcct, now, ultraProj)
  assert.equal(d1Tier.tier, "ultra-warmup-d1")
  assert.equal(d1Tier.maxInflight, 1)
  assert.equal(d1Tier.maxPer1m, 4)
  assert.equal(d1Tier.maxPer5m, 12)
  assert.equal(d1Tier.maxPerHour, 45)
  assert.equal(d1Tier.minCooldownMs, 45_000)
  assert.equal(d1Tier.maxCooldownMs, 180_000)

  // Raw refresh token must never appear in account-warmup.json
  assert.equal(fs.readFileSync(WARMUP_FILE, "utf8").includes("rt-new-ultra-1"), false)

  // 24~48h -> ultra-warmup-d2 (1c / 6 / 22 / 90)
  const d2Tier = _internal.resolveAccountRateTier(newUltraAcct, now + 25 * 3600_000, ultraProj)
  assert.equal(d2Tier.tier, "ultra-warmup-d2")
  assert.equal(d2Tier.maxInflight, 1)
  assert.equal(d2Tier.maxPer1m, 6)
  assert.equal(d2Tier.maxPer5m, 22)
  assert.equal(d2Tier.maxPerHour, 90)
  assert.equal(d2Tier.minCooldownMs, 30_000)
  assert.equal(d2Tier.maxCooldownMs, 150_000)

  // > 48h -> ultra-mature (2c / 10 / 40 / 180, soft cooldown 30s~180s)
  const matureUltraTier = _internal.resolveAccountRateTier(newUltraAcct, now + 49 * 3600_000, ultraProj)
  assert.equal(matureUltraTier.tier, "ultra-mature")
  assert.equal(matureUltraTier.maxInflight, 2)
  assert.equal(matureUltraTier.maxPer1m, 10)
  assert.equal(matureUltraTier.maxPer5m, 40)
  assert.equal(matureUltraTier.maxPerHour, 180)
  assert.equal(matureUltraTier.minCooldownMs, 30_000)
  assert.equal(matureUltraTier.maxCooldownMs, 180_000)

  // Free -> Ultra upgrade triggers fresh 48h warmup!
  const upAcct = { rt: "rt-upgraded-ultra", who: "upgraded@example.com" }
  const t0 = now - 10 * 24 * 3600_000 // seen 10 days ago as free
  _internal.resolveAccountRateTier(upAcct, t0, { plan: "Antigravity Starter Quota", tier: "free-tier", paid: "" })
  const tUpgrade = now
  const upTier = _internal.resolveAccountRateTier(upAcct, tUpgrade, ultraProj)
  assert.equal(upTier.tier, "ultra-warmup-d1", "free->ultra upgrade must restart 48h warmup at d1")
  assert.equal(upTier.maxInflight, 1)
  assert.equal(upTier.maxPer1m, 4)

  // =========================================================================
  // 3. 4-Dimensional Burst & Window Guard (1m, 5m, 1h, no cooldowns.json/alerts/breaker)
  // =========================================================================
  resetAllState()
  const baseT = Date.UTC(2026, 10, 25, 22, 0, 0)
  const testUltra = { rt: "rt-rate-ultra", who: "rate-ultra@example.com" }
  // Make it mature (> 48h)
  _internal.resolveAccountRateTier(testUltra, baseT - 72 * 3600_000, ultraProj)

  // 3a) 1m burst limit = 10 for mature ultra
  for (let i = 0; i < 10; i++) {
    const r = _internal.checkAndConsumeAccountRateLimit(testUltra, baseT + i * 100, ultraProj)
    assert.equal(r.limited, false, `req ${i} should pass 1m limit`)
  }
  const hit1m = _internal.checkAndConsumeAccountRateLimit(testUltra, baseT + 1500, ultraProj)
  assert.equal(hit1m.limited, true)
  assert.equal(hit1m.tier, "ultra-mature")
  assert.ok(hit1m.retryAfterSec >= 30 && hit1m.retryAfterSec <= 180, `retryAfter=${hit1m.retryAfterSec}`)
  assert.equal(_internal.cooldowns.has(_internal.GLOBAL_BREAKER_KEY), false)
  assert.equal(fs.existsSync(COOLDOWNS_FILE), false, "soft rate limit must NEVER write cooldowns.json")
  assert.equal(fs.existsSync(ALERTS_FILE), false, "soft rate limit must NEVER write rule-alerts.jsonl")

  // Verify savePersistentCooldowns() also never persists soft_rate_limit even if invoked for another account
  _internal.recordUpstreamFailure({ rt: "rt-other-403", who: "other@example.com" }, "", 403, new Headers(), "TOS_VIOLATION")
  const persistedDoc = JSON.parse(fs.readFileSync(COOLDOWNS_FILE, "utf8"))
  assert.equal(`acct:${testUltra.rt}` in persistedDoc, false, "soft_rate_limit must never leak into cooldowns.json")

  // 3b) 5m window limit = 40 for mature ultra (spread 4 reqs/min over 4 mins = 16, then 10+10+... up to 40)
  resetAllState()
  _internal.resolveAccountRateTier(testUltra, baseT - 72 * 3600_000, ultraProj)
  for (let m = 0; m < 4; m++) {
    for (let j = 0; j < 10; j++) {
      const r = _internal.checkAndConsumeAccountRateLimit(testUltra, baseT + m * 61_000 + j * 100, ultraProj)
      assert.equal(r.limited, false, `5m spread m=${m} j=${j} should pass`)
    }
  }
  // 41st request within 5m window (after 61s since last batch so 1m is clear, but 5m=40/40!)
  const hit5m = _internal.checkAndConsumeAccountRateLimit(testUltra, baseT + 4 * 61_000, ultraProj)
  assert.equal(hit5m.limited, true)
  assert.ok(hit5m.message.includes("5m=40/40"), hit5m.message)

  // 3c) 1h window limit = 180 for mature ultra (spread 30 per 6m across 6 windows = 180)
  resetAllState()
  _internal.resolveAccountRateTier(testUltra, baseT - 72 * 3600_000, ultraProj)
  for (let block = 0; block < 6; block++) {
    for (let sub = 0; sub < 3; sub++) {
      for (let j = 0; j < 10; j++) {
        const ts = baseT + block * 360_000 + sub * 61_000 + j * 50
        const r = _internal.checkAndConsumeAccountRateLimit(testUltra, ts, ultraProj)
        assert.equal(r.limited, false, `1h spread block=${block} sub=${sub} j=${j}`)
      }
    }
  }
  const hit1h = _internal.checkAndConsumeAccountRateLimit(testUltra, baseT + 6 * 360_000, ultraProj)
  assert.equal(hit1h.limited, true)
  assert.ok(hit1h.message.includes("1h=180/180"), hit1h.message)

  // =========================================================================
  // 4. Per-Account Inflight Concurrency Cap & Strict Stream/Error/Cancel/Abort/TTL Release
  // =========================================================================
  resetAllState()
  const origHttpsReq = https.request
  let upstreamMode = "stream-hold"
  let activeUpstreamControllers = []

  https.request = (opts, cb) => {
    const req = new EventEmitter()
    req.write = () => {}
    req.setTimeout = () => {}
    req.destroy = () => {
      if (req._res && !req._res._ended) {
        req._res._ended = true
        req._res.emit("close")
      }
    }
    req.end = () => {
      const res = new EventEmitter()
      req._res = res
      res.headers = { "content-type": "text/event-stream" }
      res.complete = false
      res.pause = () => {}
      res.resume = () => {}
      res.destroy = () => {
        if (!res._ended) {
          res._ended = true
          res.emit("close")
        }
      }
      if (upstreamMode === "error-500") {
        setTimeout(() => {
          res.statusCode = 500
          res.statusMessage = "Internal Server Error"
          res.headers = { "content-type": "application/json" }
          cb(res)
          res.emit("data", Buffer.from(JSON.stringify({ error: { code: 500, message: "boom" } })))
          res.complete = true
          res.emit("end")
        }, 5)
      } else if (upstreamMode === "nonstream-ok") {
        setTimeout(() => {
          res.statusCode = 200
          res.statusMessage = "OK"
          cb(res)
          res.emit("data", Buffer.from('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n'))
          res.complete = true
          res.emit("end")
        }, 10)
      } else if (upstreamMode === "stream-mid-error") {
        setTimeout(() => {
          res.statusCode = 200
          res.statusMessage = "OK"
          cb(res)
          res.emit("data", Buffer.from('data: {"response":{"candidates":[{"content":{"parts":[{"text":"part1"}]}}]}}\n\n'))
          setTimeout(() => {
            res.emit("error", new Error("midstream reset"))
          }, 15)
        }, 5)
      } else {
        // stream-hold: wait until test controller pushes finish or errors
        setTimeout(() => {
          res.statusCode = 200
          res.statusMessage = "OK"
          cb(res)
          res.emit("data", Buffer.from('data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n'))
          activeUpstreamControllers.push({
            finish: () => {
              if (res._ended) return
              res._ended = true
              res.emit("data", Buffer.from('data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}}\n\n'))
              res.complete = true
              res.emit("end")
            },
          })
        }, 5)
      }
    }
    return req
  }

  try {
    // Warmup d1 Ultra account: maxInflight = 1
    const sD1 = { rt: "rt-inflight-d1", who: "inflight-d1@example.com" }
    makeFakeModelCatalog(sD1, ultraProj)
    _internal.resolveAccountRateTier(sD1, Date.now(), ultraProj) // enters d1 (maxInflight=1)

    // 4a) Stream hold -> 2nd concurrent request rejected with 429 + Retry-After: 5, 1st finishes -> 3rd succeeds
    upstreamMode = "stream-hold"
    const res1 = await _internal.complete(sD1, "https://daily/v1beta/models/gemini-3-flash:streamGenerateContent", { method: "POST", body: VALID_BODY })
    assert.equal(res1.status, 200)
    assert.equal(_internal.getAccountInflightCount(sD1), 1)

    const res2 = await _internal.complete(sD1, "https://daily/v1beta/models/gemini-3-flash:streamGenerateContent", { method: "POST", body: VALID_BODY })
    assert.equal(res2.status, 429)
    assert.equal(res2.headers.get("Retry-After"), "5")
    assert.equal(_internal.cooldowns.has(`acct:${sD1.rt}`), false, "inflight cap must NOT write acct cooldown")
    // Verify 1m rate counter stayed at 1 (rejected inflight request did not waste quota!)
    assert.equal(_internal.accountRateWindows.get(_internal.accountSalt(sD1))?.length, 1)

    // Consume stream 1 to completion
    const rd1 = res1.body.getReader()
    const firstChunk = await rd1.read()
    assert.equal(firstChunk.done, false)
    activeUpstreamControllers.shift().finish()
    while (!(await rd1.read()).done) {}
    // Allow microtasks to flush stream finalize
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(_internal.getAccountInflightCount(sD1), 0, "inflight must drop to 0 after stream end")

    // 4b) Stream consumer .cancel() releases inflight immediately
    const resCancel = await _internal.complete(sD1, "https://daily/v1beta/models/gemini-3-flash:streamGenerateContent", { method: "POST", body: VALID_BODY })
    assert.equal(resCancel.status, 200)
    assert.equal(_internal.getAccountInflightCount(sD1), 1)
    await resCancel.body.cancel("client stopped")
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(_internal.getAccountInflightCount(sD1), 0, "inflight must drop to 0 after stream cancel()")
    activeUpstreamControllers.length = 0

    // 4c) AbortSignal abort before reading stream releases inflight immediately
    const ac = new AbortController()
    const resAbort = await _internal.complete(sD1, "https://daily/v1beta/models/gemini-3-flash:streamGenerateContent", {
      method: "POST",
      body: VALID_BODY,
      signal: ac.signal,
    })
    assert.equal(resAbort.status, 200)
    assert.equal(_internal.getAccountInflightCount(sD1), 1)
    ac.abort(new Error("user cancelled"))
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(_internal.getAccountInflightCount(sD1), 0, "inflight must drop to 0 after AbortSignal abort")
    try { await resAbort.body.cancel() } catch {}
    activeUpstreamControllers.length = 0

    // 4d) Mid-stream error releases inflight cleanly
    upstreamMode = "stream-mid-error"
    const resMidErr = await _internal.complete(sD1, "https://daily/v1beta/models/gemini-3-flash:streamGenerateContent", { method: "POST", body: VALID_BODY })
    assert.equal(resMidErr.status, 200)
    const rdErr = resMidErr.body.getReader()
    try {
      while (!(await rdErr.read()).done) {}
    } catch {}
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(_internal.getAccountInflightCount(sD1), 0, "inflight must drop to 0 after mid-stream error")

    // 4e) Non-stream generateContent 200 & 500 release inflight cleanly
    // Reset rate window so 4-req d1 limit doesn't interfere with inflight test
    _internal.accountRateWindows.clear()
    upstreamMode = "nonstream-ok"
    const resNonStream = await _internal.complete(sD1, "https://daily/v1beta/models/gemini-3-flash:generateContent", { method: "POST", body: VALID_BODY })
    assert.equal(resNonStream.status, 200)
    assert.equal(_internal.getAccountInflightCount(sD1), 0, "inflight must drop to 0 after non-stream 200")

    upstreamMode = "error-500"
    const resErr500 = await _internal.complete(sD1, "https://daily/v1beta/models/gemini-3-flash:generateContent", { method: "POST", body: VALID_BODY })
    assert.equal(resErr500.status, 500)
    assert.equal(_internal.getAccountInflightCount(sD1), 0, "inflight must drop to 0 after upstream 500")

    // 4f) Orphaned inflight lease TTL self-healing
    process.env.AG_INFLIGHT_LEASE_TTL_MS = "50"
    const orphanStart = Date.now()
    const orphanLease = _internal.acquireAccountInflight(sD1, orphanStart)
    assert.equal(orphanLease.acquired, true)
    assert.equal(_internal.getAccountInflightCount(sD1, orphanStart + 10), 1)
    assert.equal(_internal.getAccountInflightCount(sD1, orphanStart + 60), 0, "orphaned lease must auto-expire after TTL")
    delete process.env.AG_INFLIGHT_LEASE_TTL_MS
  } finally {
    https.request = origHttpsReq
  }

  // =========================================================================
  // 5. Per-Account Proxy Isolation (HTTP CONNECT, HTTP Forward, SOCKS5, Hot Reload, Fail-Closed, Redaction)
  // =========================================================================
  resetAllState()

  // Generate ephemeral self-signed cert for local HTTPS target server
  const keyPath = path.join(tmpDir, "srv-key.pem")
  const certPath = path.join(tmpDir, "srv-cert.pem")
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 1 -nodes -subj /CN=localhost 2>/dev/null`)
  const srvCa = fs.readFileSync(certPath)

  const httpsTarget = https.createServer(
    { key: fs.readFileSync(keyPath), cert: srvCa },
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, proto: "https", url: req.url, host: req.headers.host }))
    },
  )
  await new Promise((r) => httpsTarget.listen(0, "127.0.0.1", r))
  const httpsTargetPort = httpsTarget.address().port

  const httpTarget = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, proto: "http", url: req.url }))
  })
  await new Promise((r) => httpTarget.listen(0, "127.0.0.1", r))
  const httpTargetPort = httpTarget.address().port

  function startMockHttpProxy(expectedUser, expectedPass) {
    const stats = { connectCalls: 0, forwardCalls: 0, authHeaders: [] }
    const expectedAuth = expectedUser ? "Basic " + Buffer.from(`${expectedUser}:${expectedPass}`).toString("base64") : ""
    const server = http.createServer((req, res) => {
      const auth = req.headers["proxy-authorization"] || ""
      stats.authHeaders.push(auth)
      if (expectedAuth && auth !== expectedAuth) {
        res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="test"' })
        res.end("Proxy Auth Required")
        return
      }
      stats.forwardCalls++
      const u = new URL(req.url)
      const fwd = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (upRes) => {
        res.writeHead(upRes.statusCode || 200, upRes.headers)
        upRes.pipe(res)
      })
      fwd.on("error", (e) => { res.writeHead(502); res.end(e.message) })
      req.pipe(fwd)
    })
    server.on("connect", (req, clientSocket, head) => {
      const auth = req.headers["proxy-authorization"] || ""
      stats.authHeaders.push(auth)
      if (expectedAuth && auth !== expectedAuth) {
        clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
        clientSocket.destroy()
        return
      }
      stats.connectCalls++
      const idx = req.url.lastIndexOf(":")
      const host = req.url.slice(0, idx)
      const port = Number(req.url.slice(idx + 1))
      const upstream = net.connect(port, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head?.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on("error", () => clientSocket.destroy())
      clientSocket.on("error", () => upstream.destroy())
    })
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, stats }))
    })
  }

  function startMockSocks5Proxy(expectedUser, expectedPass) {
    const stats = { connections: 0 }
    const server = net.createServer((clientSock) => {
      let stage = "greeting"
      let buf = Buffer.alloc(0)
      let upstream = null
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (stage === "greeting") {
          if (buf.length < 2) return
          const nMethods = buf[1]
          if (buf.length < 2 + nMethods) return
          buf = buf.slice(2 + nMethods)
          if (expectedUser) {
            stage = "auth"
            clientSock.write(Buffer.from([0x05, 0x02]))
          } else {
            stage = "connect"
            clientSock.write(Buffer.from([0x05, 0x00]))
          }
        }
        if (stage === "auth") {
          if (buf.length < 2) return
          const uLen = buf[1]
          if (buf.length < 3 + uLen) return
          const pLen = buf[2 + uLen]
          if (buf.length < 3 + uLen + pLen) return
          const user = buf.slice(2, 2 + uLen).toString("utf8")
          const pass = buf.slice(3 + uLen, 3 + uLen + pLen).toString("utf8")
          buf = buf.slice(3 + uLen + pLen)
          if (user !== expectedUser || pass !== expectedPass) {
            clientSock.write(Buffer.from([0x01, 0x01]))
            clientSock.destroy()
            return
          }
          stage = "connect"
          clientSock.write(Buffer.from([0x01, 0x00]))
        }
        if (stage === "connect") {
          if (buf.length < 5) return
          const atyp = buf[3]
          let host = ""
          let portOffset = 0
          if (atyp === 0x01) {
            if (buf.length < 10) return
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
            portOffset = 8
          } else if (atyp === 0x03) {
            const len = buf[4]
            if (buf.length < 5 + len + 2) return
            host = buf.slice(5, 5 + len).toString("utf8")
            portOffset = 5 + len
          } else {
            clientSock.destroy()
            return
          }
          const port = buf.readUInt16BE(portOffset)
          const extra = buf.slice(portOffset + 2)
          buf = Buffer.alloc(0)
          stage = "relay"
          clientSock.removeListener("data", onData)
          stats.connections++
          upstream = net.connect(port, host, () => {
            clientSock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            if (extra.length) upstream.write(extra)
            upstream.pipe(clientSock)
            clientSock.pipe(upstream)
          })
          upstream.on("error", () => clientSock.destroy())
          clientSock.on("error", () => upstream.destroy())
        }
      }
      clientSock.on("data", onData)
      clientSock.on("error", () => upstream?.destroy())
    })
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, stats }))
    })
  }

  const proxyA = await startMockHttpProxy("alice", "s3cr3tA")
  const proxyB = await startMockHttpProxy("bob", "s3cr3tB")
  const proxySocks = await startMockSocks5Proxy("socku", "sockp")

  try {
    // Capture console logs to verify credentials NEVER appear in logs
    const logged = []
    const origInfo = console.info
    const origWarn = console.warn
    console.info = (...a) => logged.push(a.join(" "))
    console.warn = (...a) => logged.push(a.join(" "))

    try {
      assert.equal(_internal.maskProxyUrl("http://alice:s3cr3tA@127.0.0.1:8888"), "http://127.0.0.1:8888")
      assert.equal(_internal.maskProxyUrl("socks5h://socku:sockp@proxy.local:1080"), "socks5h://proxy.local:1080")
      assert.equal(_internal.maskProxyUrl(null), "direct")

      fs.writeFileSync(
        PROXIES_FILE,
        JSON.stringify(
          {
            default: `http://bob:s3cr3tB@127.0.0.1:${proxyB.port}`,
            accounts: {
              "proxy-a@example.com": `http://alice:s3cr3tA@127.0.0.1:${proxyA.port}`,
              "proxy-socks@example.com": `socks5h://socku:sockp@127.0.0.1:${proxySocks.port}`,
              "proxy-direct@example.com": null,
              "proxy-broken@example.com": "ftp://unsupported:1234",
            },
          },
          null,
          2,
        ),
        { encoding: "utf8", mode: 0o600 },
      )
      _internal.reloadAccountProxies(true)

      const sA = { rt: "rt-proxy-a", who: "proxy-a@example.com" }
      const sDefault = { rt: "rt-proxy-default", who: "proxy-default@example.com" }
      const sSocks = { rt: "rt-proxy-socks", who: "proxy-socks@example.com" }
      const sDirect = { rt: "rt-proxy-direct", who: "proxy-direct@example.com" }
      const sBroken = { rt: "rt-proxy-broken", who: "proxy-broken@example.com" }
      for (const s of [sA, sDefault, sSocks, sDirect, sBroken]) _internal.rememberAccountIdentity(s)

      // Account A -> Proxy A (HTTPS CONNECT + HTTP forward)
      const resA1 = await _internal.accountFetch(_internal.accountSalt(sA), `https://localhost:${httpsTargetPort}/v1/a`, { ca: srvCa })
      assert.equal(resA1.status, 200)
      assert.equal((await resA1.json()).proto, "https")
      assert.equal(proxyA.stats.connectCalls, 1)
      assert.equal(proxyB.stats.connectCalls, 0)

      const resAHttp = await _internal.accountFetch(_internal.accountSalt(sA), `http://127.0.0.1:${httpTargetPort}/plain`)
      assert.equal(resAHttp.status, 200)
      assert.equal((await resAHttp.json()).proto, "http")
      assert.equal(proxyA.stats.forwardCalls, 1)

      // Unlisted account -> default Proxy B
      const resDef = await _internal.accountFetch(_internal.accountSalt(sDefault), `https://localhost:${httpsTargetPort}/v1/def`, { ca: srvCa })
      assert.equal(resDef.status, 200)
      assert.equal(proxyB.stats.connectCalls, 1)

      // SOCKS5 account -> SOCKS5 Proxy (HTTPS + HTTP)
      const resSocksHttps = await _internal.accountFetch(_internal.accountSalt(sSocks), `https://localhost:${httpsTargetPort}/v1/socks`, { ca: srvCa })
      assert.equal(resSocksHttps.status, 200)
      const resSocksHttp = await _internal.accountFetch(_internal.accountSalt(sSocks), `http://127.0.0.1:${httpTargetPort}/socks-plain`)
      assert.equal(resSocksHttp.status, 200)
      assert.equal(proxySocks.stats.connections, 2)

      // Explicit null overrides default -> direct (hits neither proxyA nor proxyB)
      const resDirect = await _internal.accountFetch(_internal.accountSalt(sDirect), `https://localhost:${httpsTargetPort}/v1/direct`, { ca: srvCa })
      assert.equal(resDirect.status, 200)
      assert.equal(proxyA.stats.connectCalls, 1)
      assert.equal(proxyB.stats.connectCalls, 1)

      // Fail-closed: broken proxy config NEVER falls back to direct!
      await assert.rejects(
        () => _internal.accountFetch(_internal.accountSalt(sBroken), `https://localhost:${httpsTargetPort}/v1/fail`, { ca: srvCa }),
        /invalid proxy configuration/i,
      )

      // Hot-reload proxy switch for Account A: Proxy A -> Proxy B (destroys old pool & connects via Proxy B!)
      fs.writeFileSync(
        PROXIES_FILE,
        JSON.stringify(
          {
            default: null,
            accounts: {
              "proxy-a@example.com": `http://bob:s3cr3tB@127.0.0.1:${proxyB.port}`,
            },
          },
          null,
          2,
        ),
        "utf8",
      )
      _internal.reloadAccountProxies(true)
      const resASwitched = await _internal.accountFetch(_internal.accountSalt(sA), `https://localhost:${httpsTargetPort}/v1/switched`, { ca: srvCa })
      assert.equal(resASwitched.status, 200)
      assert.equal(proxyA.stats.connectCalls, 1, "old proxy A must not receive traffic after hot-reload")
      assert.equal(proxyB.stats.connectCalls, 2, "new proxy B must receive traffic after hot-reload")

      // Cold-start malformed account-proxies.json -> strict Fail-Closed (502), then auto-recovers when fixed
      const sCold = { rt: "rt-proxy-cold", who: "proxy-cold@example.com" }
      _internal.rememberAccountIdentity(sCold)
      const resetColdProxyState = () => {
        _internal.accountProxiesState.loaded = false
        _internal.accountProxiesState.mtimeMs = -1
        _internal.accountProxiesState.checkedAt = 0
        _internal.accountProxiesState.defaultProxy = null
        _internal.accountProxiesState.accounts = new Map()
        _internal.accountProxiesState.lastParseError = ""
      }

      // Case A: syntax error on cold start
      resetColdProxyState()
      fs.writeFileSync(PROXIES_FILE, "{ invalid json !!!", "utf8")
      await assert.rejects(
        () => _internal.accountFetch(_internal.accountSalt(sCold), `https://localhost:${httpsTargetPort}/v1/cold-syntax`, { ca: srvCa }),
        (err) => err?.status === 502 && /invalid proxy configuration/i.test(err?.message ?? ""),
      )

      // Case B: non-object root on cold start
      resetColdProxyState()
      fs.writeFileSync(PROXIES_FILE, JSON.stringify(["not-an-object"]), "utf8")
      await assert.rejects(
        () => _internal.accountFetch(_internal.accountSalt(sCold), `https://localhost:${httpsTargetPort}/v1/cold-array`, { ca: srvCa }),
        (err) => err?.status === 502 && /invalid proxy configuration/i.test(err?.message ?? ""),
      )

      // Case C: owner fixes file -> auto-recovers within reload interval (simulate 10s elapsed via checkedAt = 0)
      fs.writeFileSync(
        PROXIES_FILE,
        JSON.stringify({ default: `http://bob:s3cr3tB@127.0.0.1:${proxyB.port}`, accounts: {} }, null, 2),
        "utf8",
      )
      _internal.accountProxiesState.checkedAt = 0
      const resRecovered = await _internal.accountFetch(_internal.accountSalt(sCold), `https://localhost:${httpsTargetPort}/v1/cold-recovered`, { ca: srvCa })
      assert.equal(resRecovered.status, 200)
      assert.equal(proxyB.stats.connectCalls, 3, "recovered proxy B must receive traffic after fixing account-proxies.json")

      // Verify zero credential leaks in console logs
      const allLogs = logged.join("\n")
      assert.equal(allLogs.includes("s3cr3tA"), false, "Proxy password A leaked in logs!")
      assert.equal(allLogs.includes("s3cr3tB"), false, "Proxy password B leaked in logs!")
      assert.equal(allLogs.includes("sockp"), false, "SOCKS5 password leaked in logs!")
      assert.equal(allLogs.includes("alice"), false, "Proxy username A leaked in logs!")
    } finally {
      console.info = origInfo
      console.warn = origWarn
    }
  } finally {
    _internal.accountPoolManager.destroyAll()
    proxyA.server.close()
    proxyB.server.close()
    proxySocks.server.close()
    httpsTarget.close()
    httpTarget.close()
  }

  console.log("PLAN_AND_RATE_GUARD_TESTS_OK")
} finally {
  resetAllState()
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
