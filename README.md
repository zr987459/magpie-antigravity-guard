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
5. **Per-Account Rate/Hourly Soft Guard（单号滑窗软限流保护）**
   - 仅统计各账号真实推理请求（`generateContent` / `streamGenerateContent`；`countTokens`、`models`、`usage` 不计入），默认双滑窗阈值按账号套餐自动分档：Pro 账号 `200` 次/60 分钟（`AG_MAX_REQ_PER_HOUR`）与 `45` 次/5 分钟（`AG_MAX_REQ_PER_5M`）；**Google AI Ultra (`g1-ultra-tier`) 账号自动提档至 `600` 次/60 分钟（`AG_ULTRA_MAX_REQ_PER_HOUR`）与 `150` 次/5 分钟（`AG_ULTRA_MAX_REQ_PER_5M`）**，且软冷却上限更温和（60s）。
   - 触发阈值时仅在内存实施 15 秒–5 分钟软退避（`429 + Retry-After`，`reason: "soft_rate_limit"`，不写 `cooldowns.json`、不写 `rule-alerts.jsonl`、不触发全局熔断），让 Magpie 平滑把流量切分至其余健康 Pro 账号。
6. **开箱即用 · 云端词库自动热同步**
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
| `AG_RATE_GUARD_ENABLED` | `true` | 是否开启单号滑窗软限流 |
| `AG_MAX_REQ_PER_HOUR` | `200` | 单号 60 分钟推理请求软上限 |
| `AG_MAX_REQ_PER_5M` | `45` | 单号 5 分钟突发推理请求软上限 |
| `AG_RATE_COOLDOWN_MIN_MS` | `15000` | 软限流最小冷却（毫秒） |
| `AG_RATE_COOLDOWN_MAX_MS` | `300000` | 软限流最大冷却（毫秒） |
| `AG_ULTRA_MAX_REQ_PER_HOUR` | `600` | Ultra 账号 60 分钟推理请求软上限 |
| `AG_ULTRA_MAX_REQ_PER_5M` | `150` | Ultra 账号 5 分钟突发推理请求软上限 |
| `AG_ULTRA_RATE_COOLDOWN_MIN_MS` | `15000` | Ultra 账号软限流最小冷却（毫秒） |
| `AG_ULTRA_RATE_COOLDOWN_MAX_MS` | `60000` | Ultra 账号软限流最大冷却（毫秒） |

*(也支持在 `dynamic-rules.json` 的 `planGuard` 对象中热配置 `{ "enabled": true, "allowFreeEmails": [], "cooldownMs": 0 }`。)*

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
