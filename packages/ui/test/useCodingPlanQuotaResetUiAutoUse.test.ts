// @vitest-environment jsdom
// 临期自动核销（spec：specs/coding-plan-quota-reset-auto-use.md）：剩余有效期不足 30 分钟的
// 重置机会自动走手动核销路径；跨窗口 claim 决定唯一执行者；开关关闭或 claim 不可用时不执行。

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IBroadcastService,
  ISettingService,
  IUsageStatsService,
} from "@zcode/services";
import type {
  CodingPlanResetStatusSnapshot,
  ZCodeAccountAccess,
} from "@zcode/shared";
import { StoreProvider } from "@/store/StoreProvider.js";

const mocks = vi.hoisted(() => ({
  services: null as Record<string, unknown> | null,
  toast: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => mocks.services,
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

import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";

const storeBroadcastService = {
  send: vi.fn(async () => undefined),
  onMessage: () => ({ dispose: () => {} }),
} as unknown as IBroadcastService;

const TEST_ACCOUNT_ACCESS: ZCodeAccountAccess = {
  type: "zhipu-account",
  family: "bigmodel",
  planKind: "individual-coding-plan",
};

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    StoreProvider,
    { broadcastService: storeBroadcastService },
    children,
  );
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

function createUsageStatsService(
  overrides: Partial<IUsageStatsService> = {},
): IUsageStatsService {
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
  };
}

function createSettingService(
  codingPlanQuotaResetAutoUseEnabled: boolean | undefined = true,
): ISettingService {
  return {
    get: vi.fn(async () => ({ codingPlanQuotaResetAutoUseEnabled })),
    update: vi.fn(async () => undefined),
  } as unknown as ISettingService;
}

function createClaimBroadcastService(
  acquire: () => Promise<unknown> = async () => ({
    status: "acquired",
    lease: { key: "claim-key", token: "token" },
  }),
) {
  return {
    send: vi.fn(async () => undefined),
    onMessage: () => ({ dispose: () => {} }),
    acquireClaim: vi.fn(acquire),
    commitClaim: vi.fn(async () => undefined),
    releaseClaim: vi.fn(async () => undefined),
    tryClaim: vi.fn(async () => true),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// 自动核销由 1s ticker 评估驱动；对“不应触发”的断言至少覆盖一次完整 ticker 周期。
const TICK_SETTLE_MS = 1_400;

const HOOK_OPTIONS = {
  sourceKey: "builtin:personal-auto-use",
  preferredProviderId: "builtin:personal-auto-use",
  accountAccess: TEST_ACCOUNT_ACCESS,
} as const;

describe("useCodingPlanQuotaResetUi 临期自动核销", () => {
  beforeEach(() => {
    mocks.toast.mockReset();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    cleanup();
    mocks.services = null;
  });

  it("剩余不足 30 分钟时自动核销并 commit claim", async () => {
    const expiresAt = Date.now() + 25 * 60_000;
    let usedAt: number | null = null;
    const getCodingPlanResetStatus = vi.fn(async () =>
      usedAt === null
        ? status({ availableFiveHourResets: [{ expireAt: expiresAt }] })
        : status({
            latestFiveHourResetHistory: { usedAt },
            hasUnreadHistory: true,
          }),
    );
    const useCodingPlanReset = vi.fn(async () => {
      usedAt = Date.now();
      return { used: true as const };
    });
    const claimBroadcast = createClaimBroadcastService();

    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
        useCodingPlanReset,
      }),
      settingService: createSettingService(true),
      broadcastService: claimBroadcast as unknown as IBroadcastService,
    };

    const hook = renderHook(() => useCodingPlanQuotaResetUi(HOOK_OPTIONS), {
      wrapper,
    });

    await waitFor(() => expect(useCodingPlanReset).toHaveBeenCalledTimes(1));
    expect(useCodingPlanReset.mock.calls[0]?.[0]).toEqual({
      accountAccess: HOOK_OPTIONS.accountAccess,
      preferredProviderId: HOOK_OPTIONS.preferredProviderId,
      idempotencyKey: expect.any(String),
      resetType: "FIVE_HOUR",
    });
    // claim key 必须精确到 (sourceKey, resetType, expiresAt)：同一张卡只允许一个窗口核销一次。
    await waitFor(() =>
      expect(claimBroadcast.commitClaim).toHaveBeenCalledTimes(1),
    );
    expect(claimBroadcast.acquireClaim).toHaveBeenCalledWith(
      `coding-plan-reset-autouse:builtin%3Apersonal-auto-use:FIVE_HOUR:${expiresAt}`,
    );
    expect(claimBroadcast.releaseClaim).not.toHaveBeenCalled();
    await waitFor(() => expect(hook.result.current.done).toBe(true));
    expect(mocks.toast).toHaveBeenCalledWith("codingPlan.quotaReset.autoUsed", {
      variant: "info",
    });
  });

  it("剩余超过 30 分钟时不自动核销", async () => {
    const expiresAt = Date.now() + 45 * 60_000;
    const getCodingPlanResetStatus = vi.fn(async () =>
      status({ availableFiveHourResets: [{ expireAt: expiresAt }] }),
    );
    const useCodingPlanReset = vi.fn(async () => ({ used: true as const }));
    const claimBroadcast = createClaimBroadcastService();

    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
        useCodingPlanReset,
      }),
      settingService: createSettingService(true),
      broadcastService: claimBroadcast as unknown as IBroadcastService,
    };

    const hook = renderHook(() => useCodingPlanQuotaResetUi(HOOK_OPTIONS), {
      wrapper,
    });
    await waitFor(() =>
      expect(hook.result.current.opportunityVisible).toBe(true),
    );

    await sleep(TICK_SETTLE_MS);
    expect(useCodingPlanReset).not.toHaveBeenCalled();
    expect(claimBroadcast.acquireClaim).not.toHaveBeenCalled();
  });

  it("开关关闭时不自动核销", async () => {
    const expiresAt = Date.now() + 25 * 60_000;
    const getCodingPlanResetStatus = vi.fn(async () =>
      status({ availableFiveHourResets: [{ expireAt: expiresAt }] }),
    );
    const useCodingPlanReset = vi.fn(async () => ({ used: true as const }));

    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
        useCodingPlanReset,
      }),
      settingService: createSettingService(false),
    };

    const hook = renderHook(() => useCodingPlanQuotaResetUi(HOOK_OPTIONS), {
      wrapper,
    });
    await waitFor(() =>
      expect(hook.result.current.opportunityVisible).toBe(true),
    );

    await sleep(TICK_SETTLE_MS);
    // 挂载缓存未就绪时评估效应也可能触发 runAutoUse，触发前实时校验必须拦下。
    expect(useCodingPlanReset).not.toHaveBeenCalled();
  });

  it("claim busy（其他窗口在处理）时不执行核销", async () => {
    const expiresAt = Date.now() + 25 * 60_000;
    const getCodingPlanResetStatus = vi.fn(async () =>
      status({ availableFiveHourResets: [{ expireAt: expiresAt }] }),
    );
    const useCodingPlanReset = vi.fn(async () => ({ used: true as const }));
    const claimBroadcast = createClaimBroadcastService(async () => ({
      status: "busy",
      retryAfterMs: 500,
    }));

    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
        useCodingPlanReset,
      }),
      settingService: createSettingService(true),
      broadcastService: claimBroadcast as unknown as IBroadcastService,
    };

    const hook = renderHook(() => useCodingPlanQuotaResetUi(HOOK_OPTIONS), {
      wrapper,
    });
    await waitFor(() =>
      expect(hook.result.current.opportunityVisible).toBe(true),
    );

    await sleep(TICK_SETTLE_MS);
    expect(useCodingPlanReset).not.toHaveBeenCalled();
    expect(claimBroadcast.commitClaim).not.toHaveBeenCalled();
    expect(claimBroadcast.releaseClaim).not.toHaveBeenCalled();
  });

  it("claim committed（其他窗口已核销）时不执行核销", async () => {
    const expiresAt = Date.now() + 25 * 60_000;
    const getCodingPlanResetStatus = vi.fn(async () =>
      status({ availableFiveHourResets: [{ expireAt: expiresAt }] }),
    );
    const useCodingPlanReset = vi.fn(async () => ({ used: true as const }));
    const claimBroadcast = createClaimBroadcastService(async () => ({
      status: "committed",
    }));

    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
        useCodingPlanReset,
      }),
      settingService: createSettingService(true),
      broadcastService: claimBroadcast as unknown as IBroadcastService,
    };

    const hook = renderHook(() => useCodingPlanQuotaResetUi(HOOK_OPTIONS), {
      wrapper,
    });
    await waitFor(() =>
      expect(hook.result.current.opportunityVisible).toBe(true),
    );

    await sleep(TICK_SETTLE_MS);
    expect(useCodingPlanReset).not.toHaveBeenCalled();
  });

  it("broadcastService 缺失时不自动核销（宁作废不双核销）", async () => {
    const expiresAt = Date.now() + 25 * 60_000;
    const getCodingPlanResetStatus = vi.fn(async () =>
      status({ availableFiveHourResets: [{ expireAt: expiresAt }] }),
    );
    const useCodingPlanReset = vi.fn(async () => ({ used: true as const }));

    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
        useCodingPlanReset,
      }),
      settingService: createSettingService(true),
    };

    const hook = renderHook(() => useCodingPlanQuotaResetUi(HOOK_OPTIONS), {
      wrapper,
    });
    await waitFor(() =>
      expect(hook.result.current.opportunityVisible).toBe(true),
    );

    await sleep(TICK_SETTLE_MS);
    expect(useCodingPlanReset).not.toHaveBeenCalled();
  });

  it("自动核销失败时释放 claim 并沿用失败 toast，不 commit", async () => {
    const expiresAt = Date.now() + 25 * 60_000;
    const getCodingPlanResetStatus = vi.fn(async () =>
      status({ availableFiveHourResets: [{ expireAt: expiresAt }] }),
    );
    const useCodingPlanReset = vi.fn(async () => {
      throw new Error("coding_plan_reset_api_error:2007");
    });
    const claimBroadcast = createClaimBroadcastService();

    mocks.services = {
      usageStatsService: createUsageStatsService({
        getCodingPlanResetStatus,
        useCodingPlanReset,
      }),
      settingService: createSettingService(true),
      broadcastService: claimBroadcast as unknown as IBroadcastService,
    };

    renderHook(() => useCodingPlanQuotaResetUi(HOOK_OPTIONS), { wrapper });

    await waitFor(() => expect(useCodingPlanReset).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(claimBroadcast.releaseClaim).toHaveBeenCalledTimes(1),
    );
    expect(claimBroadcast.commitClaim).not.toHaveBeenCalled();
    // 失败提示沿用 reset() 内部的失败文案，不再叠加自动核销专属 toast。
    expect(mocks.toast).toHaveBeenCalledWith("codingPlan.quotaReset.failed", {
      variant: "warning",
    });
    expect(mocks.toast).not.toHaveBeenCalledWith(
      "codingPlan.quotaReset.autoUsed",
      {
        variant: "info",
      },
    );
  });
});
