# 重置卡临期自动核销（fork 行为变更）

## 第二触发源：额度耗尽自动核销并续跑（v2 追加）

任务运行中因额度耗尽（GLM 业务码归因 `quota_exhausted`：1304/1308/1310/1313–1321）而停止时，
立即核销对应类型的重置卡并自动重发最后一条真实用户输入，让任务继续：

- **5 小时额度耗尽**（entitlement `TOKENS_LIMIT` unit=3 number=5 剩余 0%）且有 FIVE_HOUR 卡
  → 自动核销。开关 `codingPlanQuotaResetAutoUseOnFiveHourExhausted`（默认开）——用户可决定
  「5 小时没了但周额度还在时」是否也立即烧 5 小时卡。
- **周额度耗尽**（`TOKENS_LIMIT` unit=6 剩余 0%）且有 WEEK 卡 → 自动核销。
  开关 `codingPlanQuotaResetAutoUseOnWeekExhausted`（默认开）。
- 两档同时耗尽时按 FIVE_HOUR 优先逐张处理；核销 + 重发后若再遇额度错误（新 errorKey），
  按同一规则再评估（同一 errorKey 只自动恢复一次，防止无限烧卡循环）。
- **自动续跑**：核销成功后取会话 rows 中最后一条 `origin === "realUser"` 的 `userInput` 行
  文本（按 `epilogueStart` 裁掉引擎附加尾注），经 SessionPane 正常发送通道重发，admission
  语义（排队/立即发送/权限）与用户手动发送完全一致。
- **边界**：仅个人 Coding Plan（内置 providerId 可解析 family）；Team Plan 的 accountAccess
  接线后续迭代。`lastError` 归因不明确（无业务码）时不动，交给用户。
- 复用第一触发源的全部基础设施：claim key 按 `(sourceKey, resetType, expiresAt)` 互斥、
  模块级 attempts 防重、设置触发前实时校验、失败 toast。

## 第一触发源：临期自动核销（v1）

## 背景与规则

BigModel / Z.ai Coding Plan 的重置机会（「重置卡」：五小时额度重置与周额度重置）在服务端
`expire_at` 过期后直接作废，无补偿、顺延或转换。本 fork 增加客户端临期自动核销：

- **触发**：某类（FIVE_HOUR / WEEK）仍有可核销机会（`hasUsableCodingPlanQuotaResetOpportunity`），
  且最早机会 `opportunityExpiresAt - now <= 30 分钟`（`CODING_PLAN_QUOTA_RESET_AUTO_USE_LEAD_MS`）时，
  自动走现有手动核销路径 `/use`（复用 `useCodingPlanQuotaResetUi` 的 `reset()`，含幂等键、
  processing 状态、status 对账与防双核销），避免作废。
- **默认开启**；设置项 `codingPlanQuotaResetAutoUseEnabled`（AppSettings，默认 `true`）可关闭。
  触发前实时读取设置校验，关闭立即生效（至多放行已在途的一次）。
- **多窗口唯一执行**：以 `(sourceKey, resetType, expiresAt)` 为粒度申请跨窗口 broadcast claim
  （key：`coding-plan-reset-autouse:{sourceKey}:{resetType}:{expiresAt}`）。winner 窗口执行核销；
  `busy` / `committed` 跳过。核销成功 `commitClaim`（同卡全应用生命周期内不再被任何窗口重试），
  失败 `releaseClaim` 允许后续重试。**broadcastService 不可用时不执行自动核销**（宁作废不双核销）。
- **失败重试**：同一卡每窗口最多 3 次自动尝试（模块级 per service+scope+type+expiresAt 计数），
  尝试间至少 5 秒冷却；重试由下一次轮询对账（entry 回 available）驱动。失败 toast 复用现有
  `codingPlan.quotaReset.failed`（每次失败一次，透明告知），达上限后静默放弃（日志），用户仍可手动核销。
- **成功反馈**：信息 toast（新文案 `codingPlan.quotaReset.autoUsed`）；核销状态走现有手动轨迹
  （`startedAt` 非空 → completed），不触发自动完成撒花。
- **不变**：手动核销全链路、轮询 Coordinator、AutoPlay 完成动画、机会徽标与倒计时提醒均不变。
  程序未运行期间卡过期仍会作废（服务端判定，客户端无法补救）。

## 状态所有者与事件顺序

```text
status 轮询对账 → entry: available { opportunityCount>0, opportunityExpiresAt }
  → hook 内 1s ticker 评估（与倒计时 ticker 同一 now 驱动）
     → expiresAt - now <= 30min ?
        否 → 等待下一 tick（ticker 仅在有可用机会时运行）
        是 → 模块级防重检查（in-flight / attempts<3 / 冷却 5s）
           → settingService.get() 校验开关
           → broadcastService.acquireClaim(autouse:{source}:{type}:{expiresAt})
              busy/committed/unavailable → 跳过（unavailable 视作稍后重试）
              acquired(winner) → reset(type)（现有 /use + 对账 + 幂等键）
                 成功 → commitClaim + toast(autoUsed) → entry completed（余下卡继续评估）
                 失败 → releaseClaim + attempts++（reset 内部已 toast 失败）
```

所有者：触发判定与防重计数归 renderer hook 模块级状态；核销状态与幂等归现有 store entry 状态机
（不变）；跨窗口唯一性归 Main BroadcastHub claim；开关归 AppSettings 持久化（settingService）。

## 验收场景

### v2（额度耗尽续跑）

8. 5 小时额度耗尽错误 + 有 5 小时卡 + 开关开 → 自动 `/use` FIVE_HOUR + 重发最后一条真实用户输入。
9. 周额度耗尽 + 有周卡 + 开关开 → 自动核销 WEEK；对应开关关闭 → 不动。
10. 5 小时耗尽但对应开关关（用户不想在周额度还有时烧 5h 卡）→ 不核销，仅提示。
11. 同一 errorKey 只自动恢复一次；重发后再次额度耗尽（新 errorKey）→ 重新评估。
12. `lastError` 非额度类（如套餐过期 1309、无权限 1311）→ 不核销。
13. 无对应类型的卡 → 不动作（现有 banner/手动路径兜底）。
14. 重发文本不含引擎附加尾注（`epilogueStart` 裁剪）。

### v1（临期自动核销）

1. 卡剩余 25 分钟 + 开关开启 → 自动 `/use` 一次，entry 走 processing → completed，成功 toast。
2. 卡剩余 45 分钟 → 不触发；倒计时进入 30 分钟窗口后（ticker 驱动）触发。
3. 开关关闭 → 不触发；触发前一刻关闭 → 放弃本次。
4. 双窗口同时进入窗口期 → 仅 claim winner 执行 `/use`；另一窗口不重复调用。
5. 核销成功后窗口内还有第二张临期卡 → 继续自动核销下一张（claim key 按 expiresAt 区分）。
6. `/use` 连续失败 3 次 → 不再自动尝试（日志 + 既有失败 toast），手动核销仍可用。
7. broadcastService 不可用 → 完全不自动核销。
