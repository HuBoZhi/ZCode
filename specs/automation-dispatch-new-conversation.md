# 定时任务派发新建对话（fork 行为变更）

## 背景与规则

本 fork 将定时任务（cron automation）的执行语义从「绑定会话内续跑」改为「每次执行新建对话」：

- **每次派发（schedule 触发与 manual 立即运行）都在 automation 所属 workspace（`workspacePath` + `workspaceIdentity`）下新建一个对话**（`zcodeTaskService.createTask`），prompt 发送到新对话。
- 新对话通过 `createTask({ automationId })` 落 `tasks-index.cron_automation_id`，在侧栏归入该定时任务分组；执行期间由 `activeAutomationId` 派发上下文提供工具面隔离与防递归（在 automation run 会话里创建新定时任务被 CLI 端口拒绝）。
- 任务保存的 `modelSelection` / `mode` / thoughtLevel 在 `createTask` 时应用；不再存在「回写既有会话配置」路径。
- `targetTaskId` 字段保留但**只用于创建侧**：
  1. 创建时把「创建该任务的对话」标记为归属会话（`automationTaskIndexRepo.syncTaskMeta` 的 `cronAutomationId`），供侧栏归组展示；
  2. ~~`automation/checkTaskBinding` 防止在归属会话里重复创建定时任务~~（fork 二次变更：该互斥守卫连同协议方法已删除，见下）。
- **同一会话可创建多个定时任务**：绑定不再构成执行互斥（每次派发都是新对话），原「一个会话只能建一个任务」的 `automation/checkTaskBinding` 守卫、协议方法与 `AutomationService/Repo.hasTaskBinding` 已整体移除；防递归仅保留「automation 执行 turn 内拒绝 CronCreate/CronUpdate/CronDelete」（`activeAutomationId` 执行轮守卫）。同一会话创建第二个任务时，归属标记按最后创建的任务覆盖（仅影响侧栏分组展示）。
- 派发链路（scheduler → main → host）不再传递 `targetTaskId`；wire schema 同步移除该字段（三组件同版本构建发布，无跨版本兼容问题）。
- 每次 run 派发成功后统一上报 `reportHostSessionCreate`（`source: "automation_scheduled"`）——现在每一次执行都产生新会话。

## 状态所有者与事件顺序

```text
scheduler claimDue/upsertRunClaimed
  -> cron-dispatch-request（automationId/runId/prompt/modelSelection/mode/workspace*）
  -> main 转发 HostMessageTypes.CronRun
  -> host dispatchCronRun
     -> resolveAutomationTargetServices（本地/远程 Host 唯一裁决）
     -> cronAutomationRepo.getRun + fixRunModelSelection（首次派发固定选择）
     -> zcodeTaskService.createTask({ workspace, model, mode, thoughtLevel, automationId })  # 每次 run 新建对话
     -> trackCronRunOutcome(taskId, runId)（terminal outcome 订阅 + manual claim heartbeat）
     -> sendPrompt(traceId = runId)
     -> reportHostSessionCreate（每次派发都报告）
  -> run 终态 settle（schedule 直接结算；manual 额外释放 claim）
```

## 不变的部分

- 闲时任务（off-peak）的绑定首跑/续跑语义不受影响。
- `setAutomationSessionConfig` 服务 API 保留（有独立消费方与测试）。
- `automationRepo` 的 `target_task_id` 存储与 `hasTaskBinding` 查询保留。
- run 台账、manual claim、misfire/退避、`runCount` 口径全部不变。

## 验收场景

1. 会话内创建定时任务（带 `targetTaskId`）→ 到点派发 → 在任务 workspace 出现**新对话**执行 prompt，创建对话本身不被写入。
2. 同一任务多次触发 → 每次各得一个新对话，互不影响；侧栏均归入该任务分组。
3. manual 立即运行 → 同样新建对话执行，manual claim 终态释放。
4. 同一会话内再次请求创建定时任务 → 允许（绑定互斥守卫已删除）；automation 执行轮内请求创建/修改/删除定时任务 → 仍被 `activeAutomationId` 执行轮守卫拒绝。
5. 派发异常 → run 标记 failed，无残留订阅/心跳（原有兜底不变）。
