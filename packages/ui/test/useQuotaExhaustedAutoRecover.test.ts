// @vitest-environment jsdom
// 额度耗尽自动核销并续跑（spec：specs/coding-plan-quota-reset-auto-use.md v2）：
// quota_exhausted 错误 + 对应档位剩余 0% + 有对应卡 → 自动核销并重发最后一条真实用户输入。
// 5 小时卡额外要求周额度尚有余额：周额度归零时重置 5 小时窗口无法续跑，不烧卡。

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { IBroadcastService, ISettingService, IUsageStatsService } from "@zcode/services";
import type { CodingPlanResetStatusSnapshot } from "@zcode/shared";
import type { ConversationRow, SessionErrorInfo } from "@zcode/shared/zcode-protocol-v4";
import { StoreProvider } from "@/store/StoreProvider.js";

const mocks = vi.hoisted(() => ({
  services: null as Record<string, unknown> | null,
  entitlement: {
    snapshot: null as unknown,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(async () => undefined),
  },
  toast: vi.fn(),
  sendText: vi.fn(async () => undefined),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => mocks.services,
}));

vi.mock("@/hooks/useUsageEntitlement.js", () => ({
  useUsageEntitlementWithService: () => mocks.entitlement,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id, locale: "zh-CN" },
    locale: "zh-CN",
  }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: mocks.toast,
}));

import { useQuotaExhaustedAutoRecover } from "@/v4/useQuotaExhaustedAutoRecover.js";

const storeBroadcastService = {
  send: vi.fn(async () => undefined),
  onMessage: () => ({ dispose: () => {} }),
} as unknown as IBroadcastService;

const PROVIDER_ID = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(StoreProvider, { broadcastService: storeBroadcastService }, children);
}

function status(
  overrides: Partial<CodingPlanResetStatusSnapshot> = {},
): CodingPlanResetStatusSnapshot {
  return {
    availableFiveHourResets: [],
    availableWeekResets: [],
    latestFiveHourResetHistory: null,
    latestWeekResetHistory: null,
    hasUnreadHistory: false,
    ...overrides,
  };
}

function createUsageStatsService(overrides: Partial<IUsageStatsService> = {}): IUsageStatsService {
  return {
    getAppUsageSnapshot: vi.fn(),
    getCodingPlanUsageSnapshot: vi.fn(),
    getCodingPlanResetStatus: vi.fn(async () => status()),
    requestCodingPlanResetOpportunity: vi.fn(async () => ({
      granted: false,
      nextTryAt: null,
    })),
    useCodingPlanReset: vi.fn(async () => ({ used: true as const })),
    markCodingPlanResetHistoryRead: vi.fn(async () => undefined),
    getSnapshot: vi.fn(),
    getEntitlementSnapshot: vi.fn(),
    ...overrides,
  } as IUsageStatsService;
}

function createSettingService(settings: Record<string, unknown> = {}): ISettingService {
  return {
    get: vi.fn(async () => settings),
    update: vi.fn(async () => undefined),
  } as unknown as ISettingService;
}

function createClaimBroadcastService() {
  return {
    send: vi.fn(async () => undefined),
    onMessage: () => ({ dispose: () => {} }),
    acquireClaim: vi.fn(async () => ({
      status: "acquired" as const,
      lease: { key: "claim-key", token: "token" },
    })),
    commitClaim: vi.fn(async () => undefined),
    releaseClaim: vi.fn(async () => undefined),
    tryClaim: vi.fn(async () => true),
  };
}

function quotaError(attributionCode = "1308"): SessionErrorInfo {
  return {
    code: attributionCode,
    message: "[1308][余额不足][request-id]",
    recoverable: true,
    at: 1_700_000_000_000,
    source: "provider",
    attribution: { providerErrorCode: attributionCode },
  } as SessionErrorInfo;
}

function userInputRow(text: string, epilogueStart?: number): ConversationRow {
  return {
    kind: "userInput",
    origin: "realUser",
    text,
    ...(epilogueStart === undefined ? {} : { epilogueStart }),
  } as unknown as ConversationRow;
}

/**
 * 已用占比 100 → 剩余 0%（getQuotaRemainingPercentage 反转 percentage）。
 * weekUsedPercent 传 null 表示快照缺失周档 limit。
 */
function exhaustedEntitlementSnapshot(
  overrides: { fiveHourUsedPercent?: number; weekUsedPercent?: number | null } = {},
): { quota: { limits: unknown[] } } {
  // null 表示周档缺失，不能被默认值覆盖，否则缺失场景会误测成周额度耗尽。
  const weekUsedPercent = overrides.weekUsedPercent === undefined ? 100 : overrides.weekUsedPercent;
  return {
    quota: {
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: overrides.fiveHourUsedPercent ?? 100,
          usageDetails: [],
        },
        ...(weekUsedPercent === null
          ? []
          : [
              {
                type: "TOKENS_LIMIT",
                unit: 6,
                percentage: weekUsedPercent,
                usageDetails: [],
              },
            ]),
      ],
    },
  } as never;
}

function setup(params: {
  lastError: SessionErrorInfo | null;
  rows: ConversationRow[];
  settings?: Record<string, unknown>;
  statusOverrides?: Partial<CodingPlanResetStatusSnapshot>;
  entitlementSnapshot?: unknown;
  useCodingPlanReset?: IUsageStatsService["useCodingPlanReset"];
}) {
  const expiresAt = Date.now() + 60 * 60_000;
  let fiveHourUsedAt: number | null = null;
  const getCodingPlanResetStatus = vi.fn(async () =>
    fiveHourUsedAt === null
      ? status({
          availableFiveHourResets: [{ expireAt: expiresAt }],
          ...params.statusOverrides,
        })
      : status({
          latestFiveHourResetHistory: { usedAt: fiveHourUsedAt },
          hasUnreadHistory: true,
          ...params.statusOverrides,
        }),
  );
  const useCodingPlanReset =
    params.useCodingPlanReset ??
    (vi.fn(async () => {
      fiveHourUsedAt = Date.now();
      return { used: true as const };
    }) as IUsageStatsService["useCodingPlanReset"]);
  const claimBroadcast = createClaimBroadcastService();

  mocks.entitlement = {
    // 默认前提：5 小时档耗尽 + 周档尚有余额（spec v2：周额度无余额时不烧 5 小时卡）。
    snapshot: params.entitlementSnapshot ?? exhaustedEntitlementSnapshot({ weekUsedPercent: 30 }),
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
  };
  mocks.services = {
    usageStatsService: createUsageStatsService({
      getCodingPlanResetStatus,
      useCodingPlanReset,
    }),
    settingService: createSettingService(params.settings),
    broadcastService: claimBroadcast as unknown as IBroadcastService,
  };

  const hook = renderHook(
    () =>
      useQuotaExhaustedAutoRecover({
        sessionId: "session-1",
        lastError: params.lastError,
        providerId: PROVIDER_ID,
        rowsWindow: params.rows,
        sendText: mocks.sendText,
      }),
    { wrapper },
  );
  return { hook, useCodingPlanReset, claimBroadcast, getCodingPlanResetStatus };
}

describe("useQuotaExhaustedAutoRecover", () => {
  beforeEach(() => {
    mocks.toast.mockReset();
    mocks.sendText.mockClear();
  });

  afterEach(() => {
    cleanup();
    mocks.services = null;
  });

  it("5 小时额度耗尽 + 周额度尚有余额 + 有 5 小时卡 → 自动核销并重发最后一条真实用户输入", async () => {
    const { useCodingPlanReset } = setup({
      lastError: quotaError(),
      rows: [userInputRow("第一条指令"), userInputRow("继续跑长任务")],
    });

    await waitFor(() => expect(useCodingPlanReset).toHaveBeenCalledTimes(1));
    expect(useCodingPlanReset.mock.calls[0]?.[0]?.resetType).toBe("FIVE_HOUR");
    await waitFor(() => expect(mocks.sendText).toHaveBeenCalledWith("继续跑长任务"));
    expect(mocks.toast).toHaveBeenCalledWith("codingPlan.quotaReset.autoUsedAndResumed", {
      variant: "info",
    });
  });

  it("重发文本裁掉引擎附加尾注（epilogueStart）", async () => {
    const { useCodingPlanReset } = setup({
      lastError: quotaError(),
      rows: [userInputRow("跑构建任务附带的引擎尾注", 5)],
    });

    await waitFor(() => expect(useCodingPlanReset).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.sendText).toHaveBeenCalledWith("跑构建任务"));
  });

  it("仅周额度耗尽 + 有周卡 → 核销 WEEK", async () => {
    const expiresAt = Date.now() + 60 * 60_000;
    let weekUsedAt: number | null = null;
    const getCodingPlanResetStatus = vi.fn(async () =>
      weekUsedAt === null
        ? status({ availableWeekResets: [{ expireAt: expiresAt }] })
        : status({
            latestWeekResetHistory: { usedAt: weekUsedAt },
            hasUnreadHistory: true,
          }),
    );
    const useCodingPlanReset = vi.fn(async () => {
      weekUsedAt = Date.now();
      return { used: true as const };
    }) as IUsageStatsService["useCodingPlanReset"];
    const claimBroadcast = createClaimBroadcastService();
    mocks.entitlement = {
      snapshot: exhaustedEntitlementSnapshot({
        fiveHourUsedPercent: 40,
        weekUsedPercent: 100,
      }),
      loading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
        useCodingPlanReset,
      }),
      settingService: createSettingService(),
      broadcastService: claimBroadcast as unknown as IBroadcastService,
    };

    renderHook(
      () =>
        useQuotaExhaustedAutoRecover({
          sessionId: "session-2",
          lastError: quotaError(),
          providerId: PROVIDER_ID,
          rowsWindow: [userInputRow("周额度耗尽场景")],
          sendText: mocks.sendText,
        }),
      { wrapper },
    );

    await waitFor(() => expect(useCodingPlanReset).toHaveBeenCalledTimes(1));
    expect(useCodingPlanReset.mock.calls[0]?.[0]?.resetType).toBe("WEEK");
    await waitFor(() => expect(mocks.sendText).toHaveBeenCalledWith("周额度耗尽场景"));
  });

  it("两档同时耗尽 + 有周卡 → 先核销 WEEK，不先烧 5 小时卡", async () => {
    const expiresAt = Date.now() + 60 * 60_000;
    let weekUsedAt: number | null = null;
    const getCodingPlanResetStatus = vi.fn(async () =>
      weekUsedAt === null
        ? status({
            availableFiveHourResets: [{ expireAt: expiresAt }],
            availableWeekResets: [{ expireAt: expiresAt }],
          })
        : status({
            latestWeekResetHistory: { usedAt: weekUsedAt },
            hasUnreadHistory: true,
            availableFiveHourResets: [{ expireAt: expiresAt }],
          }),
    );
    const useCodingPlanReset = vi.fn(async () => {
      weekUsedAt = Date.now();
      return { used: true as const };
    }) as IUsageStatsService["useCodingPlanReset"];
    const claimBroadcast = createClaimBroadcastService();
    mocks.entitlement = {
      // 两档都耗尽：FIVE_HOUR 因周额度无余额被排除，WEEK 是唯一候选。
      snapshot: exhaustedEntitlementSnapshot(),
      loading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
        useCodingPlanReset,
      }),
      settingService: createSettingService(),
      broadcastService: claimBroadcast as unknown as IBroadcastService,
    };

    renderHook(
      () =>
        useQuotaExhaustedAutoRecover({
          sessionId: "session-both-week-first",
          lastError: quotaError(),
          providerId: PROVIDER_ID,
          rowsWindow: [userInputRow("两档同时耗尽")],
          sendText: mocks.sendText,
        }),
      { wrapper },
    );

    await waitFor(() => expect(useCodingPlanReset).toHaveBeenCalledTimes(1));
    expect(useCodingPlanReset.mock.calls[0]?.[0]?.resetType).toBe("WEEK");
    await waitFor(() => expect(mocks.sendText).toHaveBeenCalledWith("两档同时耗尽"));
  });

  it("两档同时耗尽 + 无周卡 → 不核销 5 小时卡（重置了也无法续跑）", async () => {
    const { useCodingPlanReset, getCodingPlanResetStatus } = setup({
      lastError: quotaError(),
      rows: [userInputRow("不应烧卡")],
      // 两档都耗尽，默认快照只有 5 小时卡（setup 只发放 FIVE_HOUR 机会）。
      entitlementSnapshot: exhaustedEntitlementSnapshot(),
    });

    await waitFor(() => expect(getCodingPlanResetStatus).toHaveBeenCalled());
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(useCodingPlanReset).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("5 小时耗尽 + 周档剩余数据缺失 → 保守不烧 5 小时卡", async () => {
    const entitlementSnapshot = exhaustedEntitlementSnapshot({
      weekUsedPercent: null,
    });
    expect(entitlementSnapshot.quota.limits).toHaveLength(1);
    const { useCodingPlanReset, getCodingPlanResetStatus } = setup({
      lastError: quotaError(),
      rows: [userInputRow("周档数据缺失")],
      entitlementSnapshot,
    });

    await waitFor(() => expect(getCodingPlanResetStatus).toHaveBeenCalled());
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(useCodingPlanReset).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("5 小时档开关关闭 → 不核销不重发", async () => {
    const { useCodingPlanReset, getCodingPlanResetStatus } = setup({
      lastError: quotaError(),
      rows: [userInputRow("不应重发")],
      settings: { codingPlanQuotaResetAutoUseOnFiveHourExhausted: false },
    });

    // status 轮询完成后 entry 就绪，但执行通道的实时设置校验必须拦下。
    await waitFor(() => expect(getCodingPlanResetStatus).toHaveBeenCalled());
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(useCodingPlanReset).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("非额度类业务错误（1309 套餐过期）→ 不触发", async () => {
    const { useCodingPlanReset } = setup({
      lastError: quotaError("1309"),
      rows: [userInputRow("不应触发")],
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(useCodingPlanReset).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("额度未耗尽（仍有剩余）→ 不触发", async () => {
    const { useCodingPlanReset } = setup({
      lastError: quotaError(),
      rows: [userInputRow("额度还有")],
      entitlementSnapshot: exhaustedEntitlementSnapshot({
        fiveHourUsedPercent: 55,
        weekUsedPercent: 30,
      }),
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(useCodingPlanReset).not.toHaveBeenCalled();
  });

  it("无可用重置卡 → 不核销不重发", async () => {
    const { useCodingPlanReset } = setup({
      lastError: quotaError(),
      rows: [userInputRow("没有卡")],
      statusOverrides: { availableFiveHourResets: [] },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(useCodingPlanReset).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("同一 errorKey 只自动恢复一次（重发失败后不重复烧卡）", async () => {
    const expiresAt = Date.now() + 60 * 60_000;
    let usedAt: number | null = null;
    const getCodingPlanResetStatus = vi.fn(async () =>
      usedAt === null
        ? status({
            availableFiveHourResets: [{ expireAt: expiresAt }, { expireAt: expiresAt + 1 }],
          })
        : status({
            latestFiveHourResetHistory: { usedAt },
            hasUnreadHistory: true,
            availableFiveHourResets: [{ expireAt: expiresAt + 1 }],
          }),
    );
    const useCodingPlanReset = vi.fn(async () => {
      usedAt = Date.now();
      return { used: true as const };
    }) as IUsageStatsService["useCodingPlanReset"];
    mocks.entitlement = {
      snapshot: exhaustedEntitlementSnapshot({ weekUsedPercent: 30 }),
      loading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    };
    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
        useCodingPlanReset,
      }),
      settingService: createSettingService(),
      broadcastService: createClaimBroadcastService() as unknown as IBroadcastService,
    };
    // sendText 抛错模拟重发失败；同一错误不应再次核销。
    mocks.sendText.mockImplementationOnce(async () => {
      throw new Error("send failed");
    });

    renderHook(
      () =>
        useQuotaExhaustedAutoRecover({
          sessionId: "session-3",
          lastError: quotaError(),
          providerId: PROVIDER_ID,
          rowsWindow: [userInputRow("只恢复一次")],
          sendText: mocks.sendText,
        }),
      { wrapper },
    );

    await waitFor(() => expect(useCodingPlanReset).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.sendText).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
    expect(useCodingPlanReset).toHaveBeenCalledTimes(1);
  });
});
