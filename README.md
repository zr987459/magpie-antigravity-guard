# Magpie Antigravity Guard (`@magpie-community/opencode-antigravity-auth`)

一款专为 **Magpie**（桌面版 Windows / macOS / Linux 与 Docker 版通用）打造的 **Antigravity 增强防风控插件**。

在完整保留官方 Antigravity（Gemini / Claude / GPT-OSS）全部能力与账号登录态的基础上，内置**系统提示词隔离、最新防 429/403 脱敏词库、三级熔断刹车、以及跨平台云端规则自动热同步**。

---

## 核心功能亮点

1. **系统提示词隔离（`<external_system_instructions>`）**
   - 自动剥离顶层 `systemInstruction`，避免触发 Google 服务端身份锁与硬性拦截。
   - 将外部系统提示词（包含 OpenAI Chat / Responses API 的 `system`、`developer` 角色及 `instructions`）全量脱敏后封装进首轮 `user` 消息的 `<external_system_instructions>` 标签内。
2. **全客户端防 429/403 规则覆盖（内置 + 动态热更新）**
   - **Codex 全系**：完整覆盖 `GPT-5` / `GPT-6` 提示词及 `Codex CLI`、`developer` 角色与 `<system-reminder>` 中间插入指令（支持零宽字符穿透匹配）。
   - **Claude Code / Agent SDK**：移除 `x-anthropic-billing-header` 并中性化 SDK 身份声明、安全声明与 `<pasted_content>` 段落。
   - **OpenCode / Pi / Hermes / DeepSeek Harness**：全量内置最新转义与重写规则。
   - **社区 PR #3967 最新 WAF 拦截词**：内置 `read_file` / `edit_file` / `write_file` / `SKILL.md` / `Google Model Operational Directives` 等最新拦截特征脱敏规则。
3. **三级防封号熔断刹车**
   - **单号 403 / TOS 429**：立即本地持久化冷却 24 小时，期间不再向 Google 发送请求。
   - **单号+模型 429 / 503**：按上游 `Retry-After` / `retryDelay` 自动本地冷却。
   - **全局连环风控刹车**：60 秒内有 ≥2 个不同账号触发风控时自动全局熔断 10 分钟；遇到疑似新规则裸 429 时立即暂停 60 秒并触发云端词库拉取，配合 Magpie 路由组无缝切走备用通道。
4. **Plan Guard（降级/免费号防送死门禁）**
   - 自动识别 `loadCodeAssist` 与 `logins.json` 中的套餐状态：正常放行 `Google AI Pro` / `Google AI Ultra` 以及无法明确判断的 `unknown` 账号（宁放不误杀）；一旦确认为 `Antigravity Starter Quota` / `free-tier`（无 `paidTier`）等降级免费号，立即阻止向 Google 发起上游推理请求，并对其施加 6 小时单号隔离冷却（`reason: "plan_downgraded"`，返回 `429 + Retry-After` 触发 Magpie 自动切换至其他 Pro 账号或 `ai-studio`，绝不触发全局连环刹车），同时在 `rule-alerts.jsonl` 去重记录一次告警。
   - 支持通过 `AG_PLAN_GUARD_ENABLED`、`AG_ALLOW_FREE_EMAILS`（逗号分隔白名单）、`AG_PLAN_GUARD_COOLDOWN_MS` 或 `dynamic-rules.json` 的 `planGuard` 字段热配置；当账号续费恢复 Pro/Ultra 后，支持通过低频探测（10 分钟节流）、冷却到期自动重探或重登无感自愈解除隔离。
5. **4 维防脉冲与并发硬闸 + 48h 阶梯养号保护（v2026-11-26）**
   - **4 维联合闸门**（仅统计 `generateContent` / `streamGenerateContent` 实际推理请求，超限一律返回 `429 + Retry-After` 纯内存平滑让位，绝不写 `cooldowns.json`、绝不写 `rule-alerts.jsonl`、绝不触发 `global:breaker`）：
     - **单号并发硬闸 (`maxInflight`)**：超限直接返回 `429 + Retry-After: 5` 将并发子代理打散给其他号或备用通道；流式 SSE 结束/报错/取消/中断或超过租约 TTL 自动释放，绝不泄漏。
     - **1 分钟防脉冲 + 5 分钟 / 60 分钟滑窗**：彻底消灭短时高频脉冲特征。
   - **48 小时阶梯养号期 (`AG_WARMUP_HOURS=48`)**：
     - 持久化在 `account-warmup.json`（脱敏 hash、`0600` 权限）；基于 `logins.json` `seen` 时间自动豁免运行超过 48 小时的成熟老号，而新登录账号或从 `free/starter` 刚升级为 `pro/ultra` 的账号自动进入 48 小时爬坡保护：
       - `d1`（0–24h）：`1c / 4/1m / 12/5m / 45/1h`，软冷却 `45s–180s`
       - `d2`（24–48h）：`1c / 6/1m / 22/5m / 90/1h`，软冷却 `30s–150s`
       - `pro-mature`（>48h）：`2c / 15/1m / 30/5m / 120/1h`，软冷却 `15s–300s`
       - `ultra-mature`（>48h）：`2c / 10/1m / 40/5m / 180/1h`，软冷却 `30s–180s`
     - 联动 Magpie 网页 UI 单号并发上限（`providers.json` 中 `accountConcurrency`）：若为正整数且严格小于当前档位 `maxInflight`，取 `Math.min(tierMaxInflight, uiConcurrency)`，绝不突破 48h 养号期 `1c` 红线。
6. **网页 UI 优先 · 单号独立代理物理隔离（Per-Account Proxy Isolation）**
   - 原生打通 Magpie 网页 UI 代理配置（`providers.json` 的 `accountProxies[email]` / `proxy` 与 `settings.json` 全局代理，10 秒 `mtime` 热加载），支持 Gmail / Googlemail 去点号归一化兜底匹配与 `"direct"` 强制直连；未配置时再兼容回落至插件目录下 `account-proxies.json`。
   - 支持 `http://`、`https://`、`socks5://`、`socks5h://` 及账密认证，将 OAuth 刷新（`oauth2.googleapis.com`）与 Code Assist（`cloudcode-pa.googleapis.com` / `daily-cloudcode-pa.googleapis.com`）全链路绑定至该账号专属代理连接池，非法 URL 或冷启动配置损坏一律 `502` Fail-Closed 严禁回落直连；切换代理 URL 时自动销毁旧连接池并重建，日志严格脱敏（仅输出 `proxy=http://host:port` 或 `proxy=direct`）。
7. **开箱即用 · 云端词库自动热同步**
   - 无需安装额外外部脚本或 systemd 定时任务！
   - 插件启动后每 **30 分钟** 在后台非阻塞异步检查一次最新词库（5 秒超时，静默容错绝不影响正常对话），遇到疑似新风控 429 时也会立即后台拉取更新并热生效。
   - 全部状态文件均基于当前插件目录动态解析，100% 兼容 **Windows / macOS / Linux 桌面版与 Docker 版**（只读目录下也可纯内存热生效）。

---

## 一键安装（1 行命令）

> **说明**：本插件保持标准包名 `@magpie-community/opencode-antigravity-auth`。如果你之前已经装过官方 Antigravity 插件，执行下方命令会自动原地无缝替换，**已登录的 Google 账号、路由组与选项开关（如「使用 AI 额度」）全部无损保留，无需重新登录！**

### 方式一：命令行安装（推荐）

**Windows / macOS / Linux 桌面版或本机 CLI：**
```bash
magpie plugin add github:zr987459/magpie-antigravity-guard
```

**Docker 版：**
```bash
docker exec magpie magpie plugin add github:zr987459/magpie-antigravity-guard
```

### 方式二：Magpie Web 界面安装

1. 打开 Magpie 后台 → **Plugins（插件）**。
2. 在安装框输入：`github:zr987459/magpie-antigravity-guard` 点击安装。
3. 重启或等待插件宿主自动重载即可生效。

---

## 推荐路由组配置（Codex / Claude Code / OpenCode / Pi）

建议在 Magpie 的 **Routing Groups（路由组）** 中为关键模型配置「多通道容灾兜底」——当 Antigravity 遇到极端风控熔断或配额耗尽时，网关会自动毫秒级切换到备用通道，任务零中断：

| 客户端 / 场景 | 推荐网关路由组配置思路 |
| --- | --- |
| **Codex (GPT-5 / GPT-6)** | 主通道：`antigravity/gemini-4-argon` 或 `claude-opus-4-6`（按需）<br>备用通道：`ai-studio` / 官方 OpenAI / 其他兼容通道 |
| **Claude Code / Agent SDK** | 主通道：`antigravity/claude-sonnet-4-6` / `claude-opus-4-6`<br>备用通道：Anthropic 直连 / 其他反代渠道 |
| **OpenCode / Pi** | 主力推理：`antigravity/gemini-4-argon` → `ai-studio/gemini-4-argon`<br>轻量/子代理：`antigravity/gemini-4-hydrogen` → `ai-studio/gemini-4-hydrogen` |

### 日常更新插件

```bash
magpie plugin update
```
*(词库本身每 30 分钟会自动后台热同步，通常无需频繁手动更新插件本体。)*

---

## 可选环境变量配置（Plan Guard / 软限流）

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AG_PLAN_GUARD_ENABLED` | `true` | 是否开启降级/免费号隔离门禁（设为 `false` / `0` 关闭） |
| `AG_ALLOW_FREE_EMAILS` | 空 | 逗号分隔免费号白名单邮箱，命中账号直接放行 |
| `AG_PLAN_GUARD_COOLDOWN_MS` | `21600000` (6h) | 降级号单号冷却时长（毫秒） |
| `AG_RATE_GUARD_ENABLED` | `true` | 是否开启单号 4 维并发与滑窗软限流 |
| `AG_WARMUP_HOURS` | `48` | 新号/新升级账号阶梯养号保护时长（小时） |
| `AG_MAX_INFLIGHT` | `2` | 成熟 Pro 账号单号最大并发数 |
| `AG_MAX_REQ_PER_1M` | `15` | 成熟 Pro 账号 1 分钟脉冲上限 |
| `AG_MAX_REQ_PER_5M` | `30` | 成熟 Pro 账号 5 分钟推理请求软上限 |
| `AG_MAX_REQ_PER_HOUR` | `120` | 成熟 Pro 账号 60 分钟推理请求软上限 |
| `AG_RATE_COOLDOWN_MIN_MS` | `15000` | Pro 软限流最小冷却（毫秒） |
| `AG_RATE_COOLDOWN_MAX_MS` | `300000` | Pro 软限流最大冷却（毫秒） |
| `AG_ULTRA_MAX_INFLIGHT` | `2` | 成熟 Ultra 账号单号最大并发数 |
| `AG_ULTRA_MAX_REQ_PER_1M` | `10` | 成熟 Ultra 账号 1 分钟脉冲上限 |
| `AG_ULTRA_MAX_REQ_PER_5M` | `40` | 成熟 Ultra 账号 5 分钟推理请求软上限 |
| `AG_ULTRA_MAX_REQ_PER_HOUR` | `180` | 成熟 Ultra 账号 60 分钟推理请求软上限 |
| `AG_ULTRA_RATE_COOLDOWN_MIN_MS` | `30000` | Ultra 账号软限流最小冷却（毫秒） |
| `AG_ULTRA_RATE_COOLDOWN_MAX_MS` | `180000` | Ultra 账号软限流最大冷却（毫秒） |
| `MAGPIE_AG_PROVIDERS_PATH` | `<config>/providers.json` | Magpie 网页 UI 供应商配置路径（单号代理/并发 10s 热加载） |
| `MAGPIE_AG_SETTINGS_PATH` | `<config>/settings.json` | Magpie 全局设置文件路径（全局代理 10s 热加载） |
| `MAGPIE_AG_PROXIES_PATH` | `<plugin>/account-proxies.json` | 兼容兜底单号代理配置文件路径（10s 热加载） |
| `MAGPIE_AG_WARMUP_PATH` | `<plugin>/account-warmup.json` | 养号状态持久化文件路径 |

*(也支持在 `dynamic-rules.json` 的 `planGuard` 对象中热配置 `{ "enabled": true, "allowFreeEmails": [], "cooldownMs": 0 }`。)*

### 单号独立代理绑定（网页 UI 优先，兼容 `account-proxies.json`）

推荐直接在 Magpie 网页 UI 中为 `antigravity` 各账号设置「直连」/「自定义」/「供应商代理」（写入 `providers.json` 的 `accountProxies` 与 `proxy`），插件每 10 秒自动热加载生效；如需本地文件兜底，也可在插件目录下编辑 `account-proxies.json`（权限 `0600`，10 秒内自动热生效，无需重启）：

```json
{
  "default": null,
  "accounts": {
    "user@example.com": "http://user:pass@proxy-host:port"
  }
}
```

---

## 离线测试验证

```bash
node test/offline.test.mjs
node test/hardening.test.mjs
node test/plan-and-rate-guard.test.mjs
# 或在容器内使用 magpie-bun：
magpie-bun test/offline.test.mjs
magpie-bun test/hardening.test.mjs
magpie-bun test/plan-and-rate-guard.test.mjs
```
