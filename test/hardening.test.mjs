import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import { EventEmitter } from "node:events"
import { _internal } from "../index.mjs"

// Block global fetch during unit tests to prove no unexpected global network calls occur
globalThis.fetch = async (url) => {
  throw new Error(`TEST BLOCKED GLOBAL FETCH: ${url}`)
}

const resetState = () => {
  _internal.cooldowns.clear()
  _internal.recentRiskEvents.length = 0
  _internal.tokens.clear()
  _internal.tokenInFlight.clear()
  for (const p of [_internal.COOLDOWNS_PATH, _internal.RULE_ALERTS_PATH, _internal.SYNC_TRIGGER_PATH]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch {}
  }
}

try {
  // 1. Go compound duration parsing & retry delay extraction
  assert.equal(_internal.parseDurationMs("2h15m"), 8_100_000)
  assert.equal(_internal.parseDurationMs("1m30s"), 90_000)
  assert.equal(_internal.parseDurationMs("1h 2m 3.5s"), 3_723_500)
  assert.equal(_internal.parseDurationMs("0.25s"), 10_000)
  assert.equal(_internal.parseDurationMs("500ms"), 10_000)
  assert.equal(_internal.parseDurationMs("45"), 45_000)
  assert.equal(_internal.parseDurationMs("48h"), 86_400_000)
  assert.equal(_internal.parseDurationMs("0s"), null)
  assert.equal(_internal.parseDurationMs(""), null)
  assert.equal(_internal.parseDurationMs("invalid"), null)
  assert.equal(_internal.parseDurationMs("1h foo"), null)

  const compoundQuotaBody = JSON.stringify({
    error: {
      code: 429,
      message: "Resource has been exhausted (e.g. check quota).",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED", metadata: { quotaResetDelay: "2h15m" } }],
    },
  })
  assert.equal(_internal.parseRetryDelayMs(new Headers(), compoundQuotaBody), 8_100_000)
  assert.equal(
    _internal.parseRetryDelayMs(new Headers(), 'prefix {"metadata":{"quotaResetDelay":"1m30s"}}'),
    90_000,
  )

  // 2. QUOTA_EXHAUSTED & INSUFFICIENT_G1_CREDITS_BALANCE exclusion + 15m persisted fallback
  resetState()
  const quotaNoDelayBody = JSON.stringify({
    error: {
      code: 429,
      message: "Resource has been exhausted (e.g. check quota).",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }],
    },
  })
  const creditsNoDelayBody = JSON.stringify({
    error: {
      code: 429,
      message: "Insufficient Google One AI credits balance.",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "INSUFFICIENT_G1_CREDITS_BALANCE" }],
    },
  })
  assert.equal(_internal.isQuotaExhausted429(quotaNoDelayBody), true)
  assert.equal(_internal.isQuotaExhausted429(creditsNoDelayBody), true)
  assert.equal(_internal.isSuspectRuleBlock(429, new Headers(), quotaNoDelayBody, 200), false)
  assert.equal(_internal.isSuspectRuleBlock(429, new Headers(), creditsNoDelayBody, 200), false)

  const acctQ = { rt: "rt-quota-exhausted", who: "quota@example.com" }
  _internal.recordUpstreamFailure(acctQ, "gemini-4-hydrogen", 429, new Headers(), quotaNoDelayBody, { elapsedMs: 200 })
  assert.equal(_internal.cooldowns.has(_internal.GLOBAL_BREAKER_KEY), false, "QUOTA_EXHAUSTED must not trip global:breaker")
  const qCd = _internal.cooldowns.get(`model:${acctQ.rt}\0gemini-4-hydrogen`)
  assert.ok(qCd, "QUOTA_EXHAUSTED must set model cooldown")
  assert.ok(qCd.until - Date.now() >= 14 * 60 * 1000, "QUOTA_EXHAUSTED without delay must fallback to ~15m")
  assert.equal(qCd.persisted, true, "15m quota cooldown must persist to cooldowns.json")
  assert.equal(fs.existsSync(_internal.COOLDOWNS_PATH), true, "cooldowns.json should be written")

  // Verify persisted 429 cooldown reloads on startup
  const savedUntil = qCd.until
  _internal.cooldowns.clear()
  _internal.loadPersistentCooldowns()
  const reloadedCd = _internal.cooldowns.get(`model:${acctQ.rt}\0gemini-4-hydrogen`)
  assert.ok(reloadedCd && Math.abs(reloadedCd.until - savedUntil) < 1000, "429 > 5m cooldown should survive restart")
  resetState()

  // 3. whole() finishReason & bare JSON error checks
  await assert.rejects(
    () => _internal.whole(new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n')),
    (e) => e.status === 502 && /before it was complete/i.test(e.message),
  )
  await assert.rejects(
    () => _internal.whole(new Response("")),
    (e) => e.status === 502,
  )
  await assert.rejects(
    () => _internal.whole(new Response('{"error":{"code":400,"message":"bad tool call","status":"INVALID_ARGUMENT"}}\n')),
    (e) => e.status === 400 && /bad tool call/i.test(e.message),
  )
  await assert.rejects(
    () => _internal.whole(new Response('{\n  "error": {\n    "code": 429,\n    "message": "rate limit"\n  }\n}\n')),
    (e) => e.status === 429 && /rate limit/i.test(e.message),
  )
  // Chunk 1 has finishReason, chunk 2 only has usageMetadata
  const wholeOk = await _internal.whole(
    new Response(
      [
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Done"}]},"finishReason":"STOP"}]}}',
        'data: {"response":{"usageMetadata":{"totalTokenCount":42}}}',
      ].join("\n"),
    ),
  )
  assert.equal(wholeOk.candidates[0].finishReason, "STOP")
  assert.equal(wholeOk.candidates[0].content.parts[0].text, "Done")
  assert.equal(wholeOk.usageMetadata.totalTokenCount, 42)

  // 4. listed() / catalogOf() / sentID() / shape() / entry() / model()
  const mockModelsRes = {
    models: {
      "gemini-4-hydrogen-low": {
        displayName: "Gemini 4 Hydrogen (Low)",
        maxTokens: 1000000,
        maxOutputTokens: 65536,
        supportsImages: true,
        supportsVideo: true,
        supportsPdf: true,
        thinkingLevel: 25,
      },
      "gemini-4-hydrogen-high": {
        displayName: "Gemini 4 Hydrogen (High)",
        maxTokens: 1000000,
        maxOutputTokens: 65536,
        supportsImages: true,
        supportsVideo: true,
        supportsPdf: true,
        thinkingLevel: 75,
      },
      "gemini-4-hydrogen-xhigh": {
        displayName: "Gemini 4 Hydrogen (XHigh)",
        maxTokens: 1000000,
        maxOutputTokens: 65536,
        supportsImages: true,
        supportsVideo: true,
        supportsPdf: true,
        thinkingLevel: 100,
      },
      "gemini-4-argon-high": {
        displayName: "Gemini 4 Argon (High)",
        maxTokens: 1000000,
        maxOutputTokens: -100, // invalid should become 0
        supportsImages: true,
        supportsVideo: false,
        supportsPdf: true,
      },
    },
    deprecatedModelIds: {
      "gemini-3-pro-old": { newModelId: "gemini-4-argon" },
      "gemini-3-pro-low": "gemini-4-hydrogen-low",
    },
  }
  const infos = _internal.listed(mockModelsRes)
  const xhighInfo = infos.find((x) => x.id === "gemini-4-hydrogen-xhigh")
  assert.equal(xhighInfo.thinkingLevel, "xhigh")
  assert.equal(xhighInfo.videoInput, true)
  assert.equal(xhighInfo.pdfInput, true)
  const argonInfo = infos.find((x) => x.id === "gemini-4-argon-high")
  assert.equal(argonInfo.output, 0, "invalid negative maxOutputTokens must sanitize to 0")

  const cat = _internal.catalogOf(infos)
  const collapsed = _internal.collapse(cat)
  const hydroCollapsed = collapsed.find((m) => m.id === "gemini-4-hydrogen")
  assert.deepEqual(hydroCollapsed.efforts, ["low", "high", "xhigh"])
  const hydroModel = _internal.model(hydroCollapsed)
  assert.equal(hydroModel.capabilities.input.video, true)
  assert.equal(hydroModel.capabilities.input.pdf, true)
  assert.ok(hydroModel.variants.xhigh)

  const depMap = _internal.deprecatedModels(mockModelsRes)
  assert.equal(depMap["gemini-3-pro-old"], "gemini-4-argon")
  // Deprecated redirect onto single-variant family (gemini-4-argon-high)
  const [redirId, redirAt] = _internal.sentID(cat, "gemini-3-pro-old", "xhigh", depMap)
  assert.equal(redirId, "gemini-4-argon-high")
  assert.equal(redirAt, "high")

  // Deprecated redirect + nearestEffort smooth downgrade on multi-variant family (xhigh -> high)
  const multiCat = [...cat, { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", context: 1000000, output: 0, images: true, videos: false, pdfs: true }]
  const [multiRedirId, multiRedirAt] = _internal.sentID(multiCat, "gemini-3-pro-old", "xhigh", depMap)
  assert.equal(multiRedirId, "gemini-4-argon-high")
  assert.equal(multiRedirAt, "high")

  // Deprecated variant without explicit effort preserves old variant's effort
  const [redirLowId, redirLowAt] = _internal.sentID(cat, "gemini-3-pro-low", "", depMap)
  assert.equal(redirLowId, "gemini-4-hydrogen-low")
  assert.equal(redirLowAt, "low")

  // shape() handles numeric thinkingLevel=100 and validates Claude maxOutputTokens
  const shapedNum = _internal.shape(
    {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 100 } },
    },
    "gemini-4-hydrogen-xhigh",
    "xhigh",
    "xhigh",
  )
  assert.equal(shapedNum.generationConfig.thinkingConfig.thinkingLevel, "xhigh")

  const shapedClaudeBadOut = _internal.shape(
    {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: -1 },
    },
    "claude-sonnet-4-6",
    "",
    "",
  )
  assert.equal(shapedClaudeBadOut.generationConfig, undefined, "invalid negative maxOutputTokens on Claude must be removed")

  const shapedClaudeGoodOut = _internal.shape(
    {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 8192 },
    },
    "claude-sonnet-4-6",
    "",
    "",
  )
  assert.equal(shapedClaudeGoodOut.generationConfig.maxOutputTokens, 8192)

  // 5. plainSchema() format, default, and strict enum omission
  const sch = _internal.plainSchema({
    type: "object",
    properties: {
      created_at: { type: "string", format: "date-time", default: "2026-01-01T00:00:00Z" },
      bad_enum_empty: { type: "string", enum: ["a", ""] },
      bad_enum_non_str: { type: "string", enum: ["a", 123] },
      good_enum: { type: "string", enum: ["alpha", "beta"] },
    },
  })
  assert.equal(sch.properties.created_at.format, "date-time")
  assert.equal(sch.properties.created_at.default, "2026-01-01T00:00:00Z")
  assert.equal("enum" in sch.properties.bad_enum_empty, false, "enum containing empty string must be omitted whole")
  assert.equal("enum" in sch.properties.bad_enum_non_str, false, "enum containing non-string must be omitted whole")
  assert.deepEqual(sch.properties.good_enum.enum, ["alpha", "beta"])

  // 6. Per-account connection pool isolation (HTTP test server)
  const seenPortsA = new Set()
  const seenPortsB = new Set()
  const srv = http.createServer((req, res) => {
    const who = req.headers["x-acct"]
    if (who === "A") seenPortsA.add(req.socket.remotePort)
    if (who === "B") seenPortsB.add(req.socket.remotePort)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, port: req.socket.remotePort }))
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const srvPort = srv.address().port
  try {
    const agentA = _internal.accountPoolManager.getAgent("saltA", "https:")
    const agentB = _internal.accountPoolManager.getAgent("saltB", "https:")
    assert.notEqual(agentA, agentB, "distinct accounts must get distinct https.Agent instances")
    assert.equal(_internal.accountPoolManager.getAgent("saltA", "https:"), agentA, "same account must reuse agent")

    await _internal.accountFetch("saltA", `http://127.0.0.1:${srvPort}/1`, { headers: { "x-acct": "A" } }).then((r) => r.text())
    await _internal.accountFetch("saltA", `http://127.0.0.1:${srvPort}/2`, { headers: { "x-acct": "A" } }).then((r) => r.text())
    await _internal.accountFetch("saltB", `http://127.0.0.1:${srvPort}/3`, { headers: { "x-acct": "B" } }).then((r) => r.text())
    await _internal.accountFetch("saltB", `http://127.0.0.1:${srvPort}/4`, { headers: { "x-acct": "B" } }).then((r) => r.text())
    assert.equal(seenPortsA.size, 1, "Account A sequential calls should keep-alive reuse 1 socket")
    assert.equal(seenPortsB.size, 1, "Account B sequential calls should keep-alive reuse 1 socket")
    const [portA] = [...seenPortsA]
    const [portB] = [...seenPortsB]
    assert.notEqual(portA, portB, "Account A and Account B must never share a TCP socket")

    _internal.accountPoolManager.destroyAccount("ephemeral-signin-1")
  } finally {
    _internal.accountPoolManager.destroyAll()
    srv.close()
  }

  // 7. OAuth singleflight & invalid_grant 24h isolation (mock https.request)
  resetState()
  const origHttpsRequest = https.request
  let oauthHitCount = 0
  let mockMode = "success"
  https.request = (opts, cb) => {
    const host = opts?.hostname || ""
    assert.equal(host, "oauth2.googleapis.com", `Unexpected https host in unit test: ${host}`)
    oauthHitCount++
    const req = new EventEmitter()
    req.write = () => {}
    req.destroy = () => {}
    req.end = () => {
      setTimeout(() => {
        const res = new EventEmitter()
        res.headers = { "content-type": "application/json" }
        res.complete = true
        res.pause = () => {}
        res.resume = () => {}
        res.destroy = () => {}
        if (mockMode === "success") {
          res.statusCode = 200
          res.statusMessage = "OK"
          cb(res)
          res.emit("data", Buffer.from(JSON.stringify({ access_token: "fresh-tok-1", expires_in: 3600 })))
          res.emit("end")
        } else {
          res.statusCode = 400
          res.statusMessage = "Bad Request"
          cb(res)
          res.emit("data", Buffer.from(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." })))
          res.emit("end")
        }
      }, 20)
    }
    return req
  }

  try {
    const sLive = { rt: "rt-singleflight-1", who: "sf@example.com", access: "", expires: 0 }
    const results = await Promise.all(Array.from({ length: 10 }, () => _internal.token(sLive)))
    assert.equal(oauthHitCount, 1, `Expected 1 OAuth refresh call under 10x concurrency, got ${oauthHitCount}`)
    assert.ok(results.every((tok) => tok === "fresh-tok-1"))

    // Now test invalid_grant isolation
    oauthHitCount = 0
    mockMode = "invalid_grant"
    const sDead = { rt: "rt-dead-1", who: "dead@example.com", access: "", expires: 0 }
    await assert.rejects(() => _internal.token(sDead), /signed out/i)
    assert.equal(oauthHitCount, 1)
    assert.equal(_internal.cooldowns.has(_internal.GLOBAL_BREAKER_KEY), false, "single account invalid_grant must NOT trip global:breaker")
    const deadCd = _internal.cooldowns.get(`acct:${sDead.rt}`)
    assert.ok(deadCd && deadCd.status === 401 && deadCd.oauthDead === true && deadCd.persisted === true)

    // Second & third call must fail fast locally with 0 OAuth network hits
    await assert.rejects(() => _internal.token(sDead), /signed out/i)
    await assert.rejects(() => _internal.token(sDead), /signed out/i)
    assert.equal(oauthHitCount, 1, "dead refresh_token must not keep hammering oauth2.googleapis.com")
  } finally {
    https.request = origHttpsRequest
    resetState()
  }

  // 8. loadCodeAssist carries ClientMetadata (ideType, ideVersion, ideName) and v2.35.2 User-Agent
  {
    const origReq = https.request
    const capturedCalls = []
    _internal.ver.v = "2.35.2"
    _internal.ver.at = Date.now()
    https.request = (opts, cb) => {
      assert.equal(opts?.hostname, "cloudcode-pa.googleapis.com")
      const chunks = []
      const req = new EventEmitter()
      req.setTimeout = () => {}
      req.write = (chunk) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      }
      req.destroy = () => {}
      req.end = (chunk) => {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        capturedCalls.push({
          path: opts?.path,
          headers: opts?.headers || {},
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        })
        setTimeout(() => {
          const res = new EventEmitter()
          res.statusCode = 200
          res.statusMessage = "OK"
          res.headers = { "content-type": "application/json" }
          res.complete = true
          res.pause = () => {}
          res.resume = () => {}
          res.destroy = () => {}
          cb(res)
          res.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                cloudaicompanionProject: "proj-v2352",
                currentTier: { id: "g1-pro-tier", name: "Google AI Pro" },
                paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
              }),
            ),
          )
          res.emit("end")
        }, 5)
      }
      return req
    }
    try {
      const sMeta = {
        rt: "rt-meta-v2352",
        who: "meta-v2352@example.com",
        access: "tok-meta-v2352",
        expires: Date.now() + 3600_000,
      }
      _internal.tokens.set(sMeta.rt, { access: sMeta.access, expires: sMeta.expires })
      const proj = await _internal.project(sMeta, true)
      assert.equal(proj.id, "proj-v2352")
      assert.equal(capturedCalls.length, 1)
      assert.deepEqual(capturedCalls[0].body.metadata, {
        ideType: "ANTIGRAVITY",
        ideVersion: "2.35.2",
        ideName: "antigravity",
      })
      const uaHdr = capturedCalls[0].headers["User-Agent"] || capturedCalls[0].headers["user-agent"] || ""
      assert.ok(uaHdr.includes("antigravity/hub/2.35.2"), uaHdr)
      assert.ok(uaHdr.includes("cl=1029311855"), uaHdr)
    } finally {
      https.request = origReq
      _internal.projects.delete("rt-meta-v2352")
      resetState()
    }
  }

  console.log("AG_HARDENING_TESTS_OK")
} finally {
  resetState()
}
