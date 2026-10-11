import { useCallback, useEffect, useRef } from "react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type AppSettings,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type {
  ConversationRow,
  SessionErrorInfo,
} from "@zcode/shared/zcode-protocol-v4";
import { toast } from "@/components/ui/toast.js";
import {
  useCodingPlanQuotaResetUi,
  executeCodingPlanQuotaResetAutoUse,
} from "@/hooks/useCodingPlanQuotaResetUi.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { resolveKnownProviderCodeFailureReason } from "@/lib/chatErrorAttributionEvidence.js";
import {
  findCodingPlanQuotaLimit,
  getQuotaRemainingPercentage,
} from "@/lib/codingPlanQuotaPresentation.js";

/**
 * 额度耗尽自动核销并续跑（spec：specs/coding-plan-quota-reset-auto-use.md v2）。
 *
 * 任务因额度耗尽（provider 业务码归因 quota_exhausted）停止时：
 * 1. 按耗尽档位（5 小时优先于周）自动核销对应重置卡（复用唯一执行通道，claim/attempts
 *    与临期触发源互斥共享）；
 * 2. 核销成功后取最后一条真实用户输入（裁掉引擎附加尾注）经正常发送通道重发，admission
 *    语义与用户手动发送完全一致。
 * 同一 errorKey 只自动恢复一次；非额度错误、无对应卡、开关关闭均不动，交给现有提示与手动路径。
 */

// 第一版只覆盖内置个人 Coding Plan：BUILTIN id 静态映射 family，accountAccess 由此构造；
// Team Plan 的 accountAccess 接线（organizationId/projectId）后续迭代。
function toPersonalCodingPlanFamilyId(
  providerId: string | null,
): "bigmodel" | "zai" | null {
  if (providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan) {
    return "bigmodel";
  }
  if (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan) {
    return "zai";
  }
  return null;
}

/** 结构化业务码归因到 quota_exhausted 才触发；无结构码的弱文案不烧卡。 */
function isQuotaExhaustedError(error: SessionErrorInfo | null): boolean {
  if (!error) {
    return false;
  }
  const providerErrorCode = error.attribution?.providerErrorCode;
  const code = providerErrorCode?.trim() || error.code?.trim();
  return resolveKnownProviderCodeFailureReason(code) === "quota_exhausted";
}

function buildQuotaExhaustedErrorKey(
  sessionId: string | null,
  error: SessionErrorInfo,
): string {
  return [
    sessionId ?? "",
    error.at,
    error.code,
    error.attribution?.providerErrorCode ?? "",
  ].join("::");
}

/** entitlement quota.limits 中两档 token 额度的剩余比例；null = 无该档数据。 */
function resolveTokenLimitRemainingPercentages(
  snapshot: UsageEntitlementSnapshot | null,
): { fiveHour: number | null; week: number | null } {
  const limits = snapshot?.quota?.limits;
  return {
    fiveHour: getQuotaRemainingPercentage(
      findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5),
    ),
    week: getQuotaRemainingPercentage(
      findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6),
    ),
  };
}

/** 剩余恰为 0% 才视为耗尽；数据缺失（null）不触发，避免误烧卡。 */
function isLimitExhausted(remainingPercent: number | null): boolean {
  return remainingPercent === 0;
}

/** 最后一条真实用户输入的待重发文本；裁掉引擎附加尾注，裁剪后为空则不可重发。 */
export function resolveQuotaExhaustedResendText(
  rowsWindow: ConversationRow[],
): string | null {
  for (let index = rowsWindow.length - 1; index >= 0; index -= 1) {
    const row = rowsWindow[index];
    if (row?.kind !== "userInput" || row.origin !== "realUser") {
      continue;
    }
    const text =
      row.epilogueStart === undefined || row.epilogueStart === null
        ? row.text
        : row.text.slice(0, row.epilogueStart);
    return text.trim() ? text : null;
  }
  return null;
}

function isAutoUseAllowedForResetType(
  settings: AppSettings,
  resetType: "FIVE_HOUR" | "WEEK",
): boolean {
  // 总开关是全部自动核销的主控；类型开关只约束额度耗尽触发源。
  if (settings.codingPlanQuotaResetAutoUseEnabled === false) {
    return false;
  }
  return resetType === "FIVE_HOUR"
    ? settings.codingPlanQuotaResetAutoUseOnFiveHourExhausted !== false
    : settings.codingPlanQuotaResetAutoUseOnWeekExhausted !== false;
}

export function useQuotaExhaustedAutoRecover(params: {
  sessionId: string | null;
  lastError: SessionErrorInfo | null;
  providerId: string | null;
  rowsWindow: ConversationRow[];
  sendText: (text: string) => Promise<unknown>;
}): void {
  const { sessionId, lastError, providerId, rowsWindow, sendText } = params;
  const { intl } = useZCodeIntl();
  const services = useOptionalBaseWorkspaceServices();
  const usageStatsService = services?.usageStatsService;
  const settingService = services?.settingService;
  const broadcastService = services?.broadcastService;

  const familyId = toPersonalCodingPlanFamilyId(providerId);
  const quotaExhausted = familyId !== null && isQuotaExhaustedError(lastError);
  // 与 Composer 工具栏同一构造：个人 Coding Plan 的 accountAccess 由 provider family 静态决定。
  const accountAccess =
    quotaExhausted && familyId
      ? {
          type: "zhipu-account" as const,
          family: familyId,
          planKind: "individual-coding-plan" as const,
        }
      : null;

  const entitlement = useUsageEntitlementWithService(usageStatsService, {
    enabled: quotaExhausted,
    preferredProviderId: accountAccess ? (providerId ?? undefined) : undefined,
    accountAccess: accountAccess ?? undefined,
    includeSubscription: true,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
  });

  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey: accountAccess ? providerId : null,
    preferredProviderId: accountAccess ? providerId : null,
    accountAccess,
    enabled: quotaExhausted,
    onEntitlementRefresh: entitlement.refresh,
  });

  // 同一 errorKey 只自动恢复一次：重发后若再次额度耗尽会产生新 errorKey，按同一规则再评估，
  // 数据缺失/无卡/失败自然收敛；组件重挂载不重置该轨迹，防止切换 tab 后重复烧卡。
  const recoveredErrorKeysRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // rows 与 sendText 由调用方每次 render 重建（数组切片/箭头函数）；重发时刻才读取，
  // 不进依赖，避免 effect 随 render 风暴反复评估。
  const rowsWindowRef = useRef(rowsWindow);
  rowsWindowRef.current = rowsWindow;
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;

  const runRecovery = useCallback(
    async (resetType: "FIVE_HOUR" | "WEEK") => {
      if (
        !usageStatsService ||
        !broadcastService ||
        !providerId ||
        !accountAccess
      ) {
        return;
      }
      const controller = resetType === "WEEK" ? resetUi.week : resetUi;
      const entry = controller.entry;
      const expiresAt = entry?.opportunityExpiresAt ?? null;
      if (expiresAt === null) {
        return;
      }
      const currentSessionId = sessionIdRef.current;
      let redeemed = false;
      try {
        redeemed = await executeCodingPlanQuotaResetAutoUse({
          service: usageStatsService,
          scope: {
            preferredProviderId: providerId,
            accountAccess,
          },
          sourceKey: providerId,
          broadcastService,
          settingService,
          resetType,
          expiresAt,
          reset: (type) =>
            type === "WEEK" ? resetUi.week.reset() : resetUi.reset(),
          isAllowed: (settings) =>
            isAutoUseAllowedForResetType(settings, resetType),
          onSuccess: () => {
            toast(
              intl.formatMessage({
                id: "codingPlan.quotaReset.autoUsedAndResumed",
              }),
              { variant: "info" },
            );
          },
        });
      } catch {
        // 失败 toast/日志已在执行通道与 reset() 内部处理；同 errorKey 不再重试。
        return;
      }
      // 未执行（开关拦截/claim 被其他执行者占用/防重冷却）一律不重发：只有本窗口
      // 真正完成核销并 commit 后，重发才有意义。
      if (!redeemed) {
        return;
      }
      // 只有本窗口 winner 且核销成功才落到这里；session 已切换时放弃重发，避免把文本
      // 发进另一个会话。
      if (sessionIdRef.current !== currentSessionId) {
        logger.warn(
          "[quota-exhausted-recover] session switched before resend",
          {
            from: currentSessionId,
            to: sessionIdRef.current,
          },
        );
        return;
      }
      const resendText = resolveQuotaExhaustedResendText(rowsWindowRef.current);
      if (resendText === null) {
        logger.info("[quota-exhausted-recover] no real user input to resend", {
          sessionId: currentSessionId,
        });
        return;
      }
      try {
        await sendTextRef.current(resendText);
        logger.info("[quota-exhausted-recover] resent after quota reset", {
          sessionId: currentSessionId,
          resetType,
        });
      } catch (error) {
        // 重发失败走正常发送错误路径（SessionPane 已有横幅），不再自动重试。
        logger.warn("[quota-exhausted-recover] resend failed", {
          sessionId: currentSessionId,
          resetType,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      accountAccess,
      broadcastService,
      intl,
      providerId,
      resetUi,
      settingService,
      usageStatsService,
    ],
  );

  useEffect(() => {
    if (!quotaExhausted || !lastError) {
      return;
    }
    const errorKey = buildQuotaExhaustedErrorKey(sessionId, lastError);
    if (recoveredErrorKeysRef.current.has(errorKey)) {
      return;
    }
    const remaining = resolveTokenLimitRemainingPercentages(
      entitlement.snapshot,
    );
    // 5 小时档优先：它的窗口更短，通常也是第一道限流；周档在同一次评估里只在
    // 5 小时档未耗尽/无卡时兜底，两档同时耗尽时靠重发后的新错误再评估第二张。
    const candidates: Array<"FIVE_HOUR" | "WEEK"> = [];
    const fiveHourEntryUsable = resetUi.opportunityVisible;
    const weekEntryUsable = resetUi.week.opportunityVisible;
    if (isLimitExhausted(remaining.fiveHour) && fiveHourEntryUsable) {
      candidates.push("FIVE_HOUR");
    }
    if (isLimitExhausted(remaining.week) && weekEntryUsable) {
      candidates.push("WEEK");
    }
    if (candidates.length === 0) {
      return;
    }
    // 标记先于执行：执行期间 effect 重跑不得重复触发同一错误；失败由新错误重新评估。
    recoveredErrorKeysRef.current.add(errorKey);
    const firstCandidate = candidates[0];
    if (firstCandidate) {
      void runRecovery(firstCandidate);
    }
  }, [
    entitlement.snapshot,
    lastError,
    quotaExhausted,
    resetUi.opportunityVisible,
    resetUi.week.opportunityVisible,
    runRecovery,
    sessionId,
  ]);
}
