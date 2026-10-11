/* eslint-disable max-lines -- 额度重置 hook 集中处理 scope 共享请求、轮询、幂等核销与服务端历史对账。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IBroadcastService, ISettingService, IUsageStatsService } from "@zcode/services";
import type {
  AppSettings,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetType,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useStableAccountAccess } from "@/hooks/useStableAccountAccess.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  requestCodingPlanResetOpportunityWhenDue,
  subscribeCodingPlanQuotaResetPolling,
} from "@/lib/codingPlanQuotaResetCoordinator.js";
import {
  CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
  CODING_PLAN_QUOTA_RESET_TYPES,
  applyCodingPlanQuotaResetStatus,
  completeCodingPlanQuotaResetEntitlementRefresh,
  failCodingPlanQuotaResetManualUse,
  hasUsableCodingPlanQuotaResetOpportunity,
  resolveCodingPlanQuotaResetStatusVisible,
  startCodingPlanQuotaResetManualUse,
  type CodingPlanQuotaResetUiEntries,
  type CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import type {
  CodingPlanQuotaResetAutomaticObservation,
  CodingPlanQuotaResetAutoPlayReservation,
  CodingPlanQuotaResetAutoPlayReservationAttempt,
  CodingPlanQuotaResetAutoPlayedSlot,
} from "@/store/codingPlanQuotaResetState.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

const STATUS_FRESHNESS_MS = 1_500;
const USE_STATUS_RETRY_DELAYS_MS = [0, 250, 750, 1_500] as const;
// 临期自动核销（spec：specs/coding-plan-quota-reset-auto-use.md）：重置机会到期作废收益为 0，
// 核销收益非负，剩余有效期不足该阈值时自动走手动核销路径，避免用户不在场时白扔。
const CODING_PLAN_QUOTA_RESET_AUTO_USE_LEAD_MS = 30 * 60_000;
// 同一张卡每窗口最多自动尝试次数；连续失败多为服务端/网络持续异常，继续重试只会 toast 风暴。
const CODING_PLAN_QUOTA_RESET_AUTO_USE_MAX_ATTEMPTS = 3;
// 两次自动尝试间的最小冷却，覆盖 claim busy（其他窗口在处理）与瞬态失败的即时重触发。
const CODING_PLAN_QUOTA_RESET_AUTO_USE_RETRY_COOLDOWN_MS = 5_000;
const EMPTY_ENTRIES: Record<string, CodingPlanQuotaResetUiEntries> = {};
const EMPTY_PLAYED: Record<string, CodingPlanQuotaResetAutoPlayedSlot> = {};
const EMPTY_AUTOMATIC_OBSERVATIONS: Record<
  string,
  {
    fiveHour: CodingPlanQuotaResetAutomaticObservation | null;
    week: CodingPlanQuotaResetAutomaticObservation | null;
  }
> = {};
const NOOP_SET_ENTRY = (
  _sourceKey: string,
  _resetType: CodingPlanResetType,
  _entry: CodingPlanQuotaResetUiEntry | null,
) => {};
const NOOP_RESERVE_AUTO_PLAY = async (
  _sourceKey: string,
  _resetType: CodingPlanResetType,
  _completedAt: number,
): Promise<CodingPlanQuotaResetAutoPlayReservationAttempt> => ({
  status: "blocked",
});
const NOOP_COMMIT_AUTO_PLAY = (_reservation: CodingPlanQuotaResetAutoPlayReservation): boolean =>
  false;
const NOOP_RELEASE_AUTO_PLAY = async (
  _reservation: CodingPlanQuotaResetAutoPlayReservation,
): Promise<void> => {};

function entryKeyForType(resetType: CodingPlanResetType): keyof CodingPlanQuotaResetUiEntries {
  return resetType === "WEEK" ? "week" : "fiveHour";
}

function latestUsedAtForType(
  snapshot: CodingPlanResetStatusSnapshot,
  resetType: CodingPlanResetType,
): number | null {
  return (
    (resetType === "WEEK"
      ? snapshot.latestWeekResetHistory?.usedAt
      : snapshot.latestFiveHourResetHistory?.usedAt) ?? null
  );
}

// 只替换目标类型的槽位，另一类型保持不变；显式分支避免 union 计算键的类型收窄问题。
function withEntry(
  entries: CodingPlanQuotaResetUiEntries,
  resetType: CodingPlanResetType,
  entry: CodingPlanQuotaResetUiEntry | null,
): CodingPlanQuotaResetUiEntries {
  return resetType === "WEEK" ? { ...entries, week: entry } : { ...entries, fiveHour: entry };
}

// 不能用“组件挂载前 store 已有完成态”判断是否重新登录；设置页可能在同一鉴权会话
// 先写入状态，Composer 后挂载仍应展示。只有同一 used_at 的首次观察记录属于上一鉴权会话时
// 才静音。返回值由 useMemo 缓存，避免静音态每次 render 创建新对象并触发 effect/setNow 循环。
function suppressAutomaticAnimationFromPreviousAuthEpoch(
  entry: CodingPlanQuotaResetUiEntry | null,
  observation: CodingPlanQuotaResetAutomaticObservation | null,
  authSessionSeq: number,
): CodingPlanQuotaResetUiEntry | null {
  if (
    observation !== null &&
    observation.authSessionSeq !== authSessionSeq &&
    entry?.status === "completed" &&
    entry.startedAt === null &&
    entry.observedAt !== null &&
    entry.completedAt === observation.completedAt
  ) {
    return { ...entry, observedAt: null };
  }
  return entry;
}

interface CachedResetStatus {
  fetchedAt: number;
  snapshot: CodingPlanResetStatusSnapshot;
}

interface SharedManualResetAttempt {
  startedAt: number;
  baselineUsedAt: number | null;
  completedAt: number | null;
}

const statusInflightByService = new WeakMap<
  IUsageStatsService,
  Map<string, Promise<CodingPlanResetStatusSnapshot>>
>();
const statusCacheByService = new WeakMap<IUsageStatsService, Map<string, CachedResetStatus>>();
const historyReadInflightByService = new WeakMap<IUsageStatsService, Map<string, Promise<void>>>();
const historyReadCompletedByService = new WeakMap<IUsageStatsService, Set<string>>();
const manualResetAttemptByService = new WeakMap<
  IUsageStatsService,
  Map<string, SharedManualResetAttempt>
>();

interface CodingPlanQuotaResetAutoUseAttempt {
  attempts: number;
  lastTriedAt: number;
  inFlight: boolean;
}

// 自动核销防重计数按 service + scope + 类型 + 卡到期时刻隔离：同一窗口内 Composer、
// 设置页、Usage 页多入口挂载本 hook 时各自评估同一张卡，必须共享同一份 in-flight/次数轨迹。
const autoUseAttemptsByService = new WeakMap<
  IUsageStatsService,
  Map<string, CodingPlanQuotaResetAutoUseAttempt>
>();

function buildAutoUseClaimKey(
  sourceKey: string,
  resetType: CodingPlanResetType,
  expiresAt: number,
): string {
  return `coding-plan-reset-autouse:${encodeURIComponent(sourceKey)}:${resetType}:${expiresAt}`;
}

export interface ExecuteCodingPlanQuotaResetAutoUseParams {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  sourceKey: string;
  broadcastService: Pick<IBroadcastService, "acquireClaim" | "commitClaim" | "releaseClaim">;
  settingService?: Pick<ISettingService, "get">;
  resetType: CodingPlanResetType;
  expiresAt: number;
  /** 核销动作：临期/耗尽触发源各自绑定现有手动 reset() 通道。 */
  reset: (resetType: CodingPlanResetType) => Promise<void>;
  /** 触发前实时读取设置后的放行判定（不同触发源有不同开关）；读取异常按放行处理。 */
  isAllowed: (settings: AppSettings) => boolean;
  /** 核销 + commit 成功后的反馈（toast 文案由调用方决定）。 */
  onSuccess?: () => void;
}

/**
 * 自动核销的唯一执行通道（spec：specs/coding-plan-quota-reset-auto-use.md），临期与额度
 * 耗尽两个触发源共用：跨窗口 claim 决定唯一执行者，模块级 attempts 计数跨触发源防重。
 * broadcastService 由调用方保证存在——缺失时宁作废不双核销，不进入本函数。
 *
 * @returns true = 本次核销 + commit 成功（可触发续跑）；false = 未执行（防重/开关/claim
 *   被其他执行者占用）；核销失败以 reject 抛出（失败 toast 已在 reset() 内部发出）。
 */
export async function executeCodingPlanQuotaResetAutoUse(
  params: ExecuteCodingPlanQuotaResetAutoUseParams,
): Promise<boolean> {
  const { service, scope, sourceKey, broadcastService, settingService } = params;
  const { resetType, expiresAt } = params;
  const attemptKey = `${buildScopeKey(scope)}::${resetType}::${expiresAt}`;
  const attempts = getServiceMap(autoUseAttemptsByService, service);
  const existing = attempts.get(attemptKey);
  if (existing?.inFlight) {
    return false;
  }
  if (existing && existing.attempts >= CODING_PLAN_QUOTA_RESET_AUTO_USE_MAX_ATTEMPTS) {
    return false;
  }
  const nowMs = Date.now();
  if (
    existing &&
    nowMs - existing.lastTriedAt < CODING_PLAN_QUOTA_RESET_AUTO_USE_RETRY_COOLDOWN_MS
  ) {
    return false;
  }
  attempts.set(attemptKey, {
    attempts: existing?.attempts ?? 0,
    lastTriedAt: nowMs,
    inFlight: true,
  });

  try {
    // 触发前实时校验开关：挂载时读到的缓存可能已过期，关闭应立即生效。
    if (settingService) {
      try {
        const settings = await settingService.get();
        if (!params.isAllowed(settings)) {
          return false;
        }
      } catch {
        // 设置读取失败按放行继续：核销收益非负，不应因设置接口抖动作废重置卡。
      }
    }
    let claim: Awaited<ReturnType<typeof broadcastService.acquireClaim>>;
    try {
      claim = await broadcastService.acquireClaim(
        buildAutoUseClaimKey(sourceKey, resetType, expiresAt),
      );
    } catch {
      // claim RPC 异常按稍后重试处理，冷却已由 lastTriedAt 保证。
      return false;
    }
    if (claim.status !== "acquired") {
      // busy：其他窗口在处理这张卡；committed：已被核销；unavailable：Main 暂不可用，
      // 三者都不该由本窗口继续，留待下一次评估。
      return false;
    }
    const nextAttempts = (existing?.attempts ?? 0) + 1;
    attempts.set(attemptKey, {
      attempts: nextAttempts,
      lastTriedAt: nowMs,
      inFlight: true,
    });
    try {
      await params.reset(resetType);
      try {
        await broadcastService.commitClaim(claim.lease);
      } catch {
        // 核销本身已成功；commit 失败只会让其他窗口多试一次 /use，服务端幂等与
        // status 对账会兜住，不影响结果。
      }
      params.onSuccess?.();
      return true;
    } catch (error) {
      try {
        await broadcastService.releaseClaim(claim.lease);
      } catch {
        // 迟到 token 的 release 由 Main 忽略，这里无需处理。
      }
      // 失败 toast 已由 reset() 内部发出；这里只负责停止条件与日志。
      if (nextAttempts >= CODING_PLAN_QUOTA_RESET_AUTO_USE_MAX_ATTEMPTS) {
        logger.warn("[coding-plan-reset] auto use attempts exhausted", {
          sourceKey,
          resetType,
          expiresAt,
          error: toErrorMessage(error),
        });
      }
      throw error;
    }
  } finally {
    const current = attempts.get(attemptKey);
    if (current) {
      attempts.set(attemptKey, { ...current, inFlight: false });
    }
  }
}

function buildScopeKey(scope: CodingPlanResetScopeRequest): string {
  return JSON.stringify([scope.preferredProviderId, scope.accountAccess]);
}

// 手动核销轨迹按 scope + 重置类型隔离：五小时与周额度的手动重置互不干扰。
function buildManualAttemptKey(
  scope: CodingPlanResetScopeRequest,
  resetType: CodingPlanResetType,
): string {
  return `${buildScopeKey(scope)}::${resetType}`;
}

function getServiceMap<T>(
  owner: WeakMap<IUsageStatsService, Map<string, T>>,
  service: IUsageStatsService,
): Map<string, T> {
  const existing = owner.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, T>();
  owner.set(service, created);
  return created;
}

async function requestCodingPlanResetStatus(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  force: boolean;
  authSessionSeq: number;
}): Promise<CodingPlanResetStatusSnapshot> {
  const scopeKey = `${params.authSessionSeq}::${buildScopeKey(params.scope)}`;
  const cache = getServiceMap(statusCacheByService, params.service);
  const cached = cache.get(scopeKey);
  if (!params.force && cached && Date.now() - cached.fetchedAt < STATUS_FRESHNESS_MS) {
    return cached.snapshot;
  }

  const inflight = getServiceMap(statusInflightByService, params.service);
  const existing = inflight.get(scopeKey);
  if (existing) {
    return existing;
  }

  const request = params.service
    .getCodingPlanResetStatus(params.scope)
    .then((snapshot) => {
      cache.set(scopeKey, { fetchedAt: Date.now(), snapshot });
      return snapshot;
    })
    .finally(() => {
      inflight.delete(scopeKey);
      if (inflight.size === 0) {
        statusInflightByService.delete(params.service);
      }
    });
  inflight.set(scopeKey, request);
  return request;
}

function startSharedManualResetAttempt(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  startedAt: number;
  resetType: CodingPlanResetType;
  authSessionSeq: number;
}): void {
  const attemptKey = buildManualAttemptKey(params.scope, params.resetType);
  const cached = statusCacheByService
    .get(params.service)
    ?.get(`${params.authSessionSeq}::${buildScopeKey(params.scope)}`)?.snapshot;
  const baselineUsedAt = cached ? latestUsedAtForType(cached, params.resetType) : null;
  getServiceMap(manualResetAttemptByService, params.service).set(attemptKey, {
    startedAt: params.startedAt,
    baselineUsedAt,
    completedAt: null,
  });
}

function clearSharedManualResetAttempt(
  service: IUsageStatsService,
  scope: CodingPlanResetScopeRequest,
  resetType: CodingPlanResetType,
): void {
  const attempts = manualResetAttemptByService.get(service);
  if (!attempts) {
    return;
  }
  attempts.delete(buildManualAttemptKey(scope, resetType));
  if (attempts.size === 0) {
    manualResetAttemptByService.delete(service);
  }
}

function resolveSharedManualResetStartedAt(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  snapshot: CodingPlanResetStatusSnapshot;
  resetType: CodingPlanResetType;
}): number | null {
  const attempts = manualResetAttemptByService.get(params.service);
  const attemptKey = buildManualAttemptKey(params.scope, params.resetType);
  const attempt = attempts?.get(attemptKey);
  if (!attempt) {
    return null;
  }

  const latestUsedAt = latestUsedAtForType(params.snapshot, params.resetType);
  if (latestUsedAt === null || latestUsedAt === attempt.baselineUsedAt) {
    return null;
  }
  if (attempt.completedAt === null) {
    attempt.completedAt = latestUsedAt;
    return attempt.startedAt;
  }
  if (attempt.completedAt === latestUsedAt) {
    return attempt.startedAt;
  }

  // 共享轨迹只归属第一次变化的 used_at。后续不同历史属于新的自动/运营重置，
  // 必须清除手动标记，保留原有自动 Tooltip 和触发器烟花。
  clearSharedManualResetAttempt(params.service, params.scope, params.resetType);
  return null;
}

function markHistoryReadOnce(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  usedAt: number;
}): Promise<void> {
  // 契约（bigmodelUsageQuotaProvider）：
  // history/read 是用户全 scope 共享游标，请求不带 target scope；任一入口上报后
  // 服务端同时清除所有 scope 的 unread。因此 key 只按 usedAt——同 service 相同
  // usedAt 只发一次是符合契约的去重，按 scope 拆分反而造成重复 POST。
  const historyKey = String(params.usedAt);
  let completed = historyReadCompletedByService.get(params.service);
  if (!completed) {
    completed = new Set<string>();
    historyReadCompletedByService.set(params.service, completed);
  }
  if (completed.has(historyKey)) {
    return Promise.resolve();
  }

  const inflight = getServiceMap(historyReadInflightByService, params.service);
  const existing = inflight.get(historyKey);
  if (existing) {
    return existing;
  }

  const request = params.service
    .markCodingPlanResetHistoryRead(params.scope)
    .then(() => {
      completed?.add(historyKey);
    })
    .finally(() => {
      inflight.delete(historyKey);
      if (inflight.size === 0) {
        historyReadInflightByService.delete(params.service);
      }
    });
  inflight.set(historyKey, request);
  return request;
}

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  if (bytes.some((value) => value !== 0)) {
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // 极旧 WebView 没有 Web Crypto 时仍需保证同一次失败重试稳定；该 key 只用于幂等，不承载鉴权。
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CodingPlanQuotaResetTypeController {
  entry: CodingPlanQuotaResetUiEntry | null;
  /** 仍有可核销的手动重置机会（available，或 completed 携带的同类型余下机会）。 */
  opportunityVisible: boolean;
  /** 手动 use + status 对账中。 */
  processing: boolean;
  /** 已拿到服务端 used_at。 */
  done: boolean;
  statusVisible: boolean;
  /** 发起手动核销；失败 reject 供 Action 恢复交互。 */
  reset: () => Promise<void>;
}

// 五小时字段平铺在顶层保持既有调用方兼容；周额度通过 week 子控制器暴露。
export interface CodingPlanQuotaResetUiController extends CodingPlanQuotaResetTypeController {
  enabled: boolean;
  week: CodingPlanQuotaResetTypeController;
  /** Composer 申请临时播放 reservation；此阶段不写 played。 */
  reserveAutomaticCompletion: (
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  /** 组件仍有效且即将展示时提交 played。 */
  commitAutomaticCompletion: (reservation: CodingPlanQuotaResetAutoPlayReservation) => boolean;
  /** 组件在 commit 前失效时释放 reservation。 */
  releaseAutomaticCompletion: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;
}

export function useCodingPlanQuotaResetUi({
  sourceKey,
  preferredProviderId,
  accountAccess,
  enabled: requestedEnabled = true,
  onEntitlementRefresh,
}: {
  sourceKey: string | null | undefined;
  preferredProviderId?: string | null;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  enabled?: boolean;
  onEntitlementRefresh?: () => void | Promise<void>;
}): CodingPlanQuotaResetUiController {
  const { intl } = useZCodeIntl();
  const services = useOptionalBaseWorkspaceServices();
  const usageStatsService = services?.usageStatsService;
  // 自动核销只信 base host 的 app 全局设置与跨窗口 claim；与 usageStatsService 同源获取。
  const settingService = services?.settingService;
  const broadcastService = services?.broadcastService;
  // 自动核销开关默认开启（AppSettings schema default(true)）；设置读取失败时保持默认，
  // 不因设置接口抖动让临期卡白白作废。触发前还会实时校验一次，关闭立即生效。
  const [autoUseEnabled, setAutoUseEnabled] = useState(true);
  useEffect(() => {
    let cancelled = false;
    settingService
      ?.get()
      .then((settings) => {
        if (!cancelled) {
          setAutoUseEnabled(settings.codingPlanQuotaResetAutoUseEnabled !== false);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settingService]);
  const stableAccountAccess = useStableAccountAccess(accountAccess);
  const scope = useMemo<CodingPlanResetScopeRequest | null>(() => {
    const normalizedProviderId = preferredProviderId?.trim();
    if (!normalizedProviderId || !stableAccountAccess) {
      return null;
    }
    return {
      preferredProviderId: normalizedProviderId,
      accountAccess: stableAccountAccess,
    };
  }, [preferredProviderId, stableAccountAccess]);
  const enabled = Boolean(requestedEnabled && sourceKey?.trim() && usageStatsService && scope);
  const entriesBySource = useZCodeStoreWithDefault(
    (state) => state.codingPlanQuotaResetUiBySource,
    EMPTY_ENTRIES,
  );
  const setEntry = useZCodeStoreWithDefault(
    (state) => state.setCodingPlanQuotaResetUiEntry,
    NOOP_SET_ENTRY,
  );
  const reserveAutoPlay = useZCodeStoreWithDefault(
    (state) => state.reserveCodingPlanQuotaResetAutoPlay,
    NOOP_RESERVE_AUTO_PLAY,
  );
  const commitAutoPlay = useZCodeStoreWithDefault(
    (state) => state.commitCodingPlanQuotaResetAutoPlay,
    NOOP_COMMIT_AUTO_PLAY,
  );
  const releaseAutoPlay = useZCodeStoreWithDefault(
    (state) => state.releaseCodingPlanQuotaResetAutoPlay,
    NOOP_RELEASE_AUTO_PLAY,
  );
  const observationsBySource = useZCodeStoreWithDefault(
    (state) => state.codingPlanQuotaResetAutomaticObservationsBySource,
    EMPTY_AUTOMATIC_OBSERVATIONS,
  );
  const playedBySource = useZCodeStoreWithDefault(
    (state) => state.codingPlanQuotaResetAutoPlayedBySource,
    EMPTY_PLAYED,
  );
  const authSessionSeq = useZCodeStoreWithDefault((state) => state.authSessionSeq, 0);
  const authSessionSeqRef = useRef(authSessionSeq);
  authSessionSeqRef.current = authSessionSeq;
  const storedEntries = sourceKey ? entriesBySource[sourceKey] : undefined;
  const storedObservations = sourceKey ? observationsBySource[sourceKey] : undefined;
  const fiveHourObservation = storedObservations?.fiveHour ?? null;
  const weekObservation = storedObservations?.week ?? null;
  const fiveHourEntry = useMemo(
    () =>
      suppressAutomaticAnimationFromPreviousAuthEpoch(
        enabled ? (storedEntries?.fiveHour ?? null) : null,
        fiveHourObservation,
        authSessionSeq,
      ),
    [authSessionSeq, enabled, fiveHourObservation, storedEntries?.fiveHour],
  );
  const weekEntry = useMemo(
    () =>
      suppressAutomaticAnimationFromPreviousAuthEpoch(
        enabled ? (storedEntries?.week ?? null) : null,
        weekObservation,
        authSessionSeq,
      ),
    [authSessionSeq, enabled, storedEntries?.week, weekObservation],
  );
  const automaticObservationsRef = useRef({
    FIVE_HOUR: fiveHourObservation,
    WEEK: weekObservation,
  });
  automaticObservationsRef.current = {
    FIVE_HOUR: fiveHourObservation,
    WEEK: weekObservation,
  };
  // 跨窗口已播记录走 ref：applyStatusForType 只读最新值，不因 played 合并重建回调身份。
  const playedBySourceRef = useRef(playedBySource);
  playedBySourceRef.current = playedBySource;
  const entriesRef = useRef<CodingPlanQuotaResetUiEntries>({
    fiveHour: fiveHourEntry,
    week: weekEntry,
  });
  const initialRefreshCompletedAt = (entry: CodingPlanQuotaResetUiEntry | null): number | null =>
    entry?.status === "completed" && !entry.quotaOverridePending ? entry.completedAt : null;
  // 五小时与周额度各自记录 entitlement 刷新去重键；已完成但仍处于乐观覆盖时，
  // 新挂载入口必须继续尝试刷新真实 entitlement。
  const lastEntitlementRefreshRef = useRef<
    Record<CodingPlanResetType, { sourceKey: string | null; completedAt: number | null }>
  >({
    FIVE_HOUR: {
      sourceKey: sourceKey ?? null,
      completedAt: initialRefreshCompletedAt(fiveHourEntry),
    },
    WEEK: {
      sourceKey: sourceKey ?? null,
      completedAt: initialRefreshCompletedAt(weekEntry),
    },
  });
  const [now, setNow] = useState(() => Date.now());
  // onEntitlementRefresh 常被调用方以内联箭头传入（每次 render 都是新身份）。
  // 若把它留在 useCallback 依赖里，会连锁重建 refreshStatus 并让轮询 effect 随父组件
  // 每次 render 重启；设置页切换个人/团队套餐时的密集重渲染会对同一 scope 连发多次
  // /opportunity（status 有 1.5s 新鲜度缓存，opportunity 只有 in-flight 合并）。
  // 存入 ref 后轮询身份只随 enabled/scope/sourceKey/service 变化，执行时仍读取最新回调。
  const onEntitlementRefreshRef = useRef(onEntitlementRefresh);

  useEffect(() => {
    onEntitlementRefreshRef.current = onEntitlementRefresh;
  }, [onEntitlementRefresh]);

  useEffect(() => {
    entriesRef.current = { fiveHour: fiveHourEntry, week: weekEntry };
  }, [fiveHourEntry, weekEntry]);

  const applyStatusForType = useCallback(
    async (
      snapshot: CodingPlanResetStatusSnapshot,
      resetType: CodingPlanResetType,
    ): Promise<CodingPlanQuotaResetUiEntry | null> => {
      if (
        !sourceKey ||
        !usageStatsService ||
        !scope ||
        authSessionSeqRef.current !== authSessionSeq
      ) {
        return null;
      }
      const key = entryKeyForType(resetType);
      const previous = entriesRef.current[key];
      const manualStartedAt = resolveSharedManualResetStartedAt({
        service: usageStatsService,
        scope,
        snapshot,
        resetType,
      });
      let next = applyCodingPlanQuotaResetStatus(
        previous,
        snapshot,
        Date.now(),
        manualStartedAt,
        resetType,
      );
      // 补水的旧完成态被粘滞规则保持为 completed 后，createCompletedEntry 会把 observedAt
      // 续期回 now；仅当首次观察记录属于上一鉴权 epoch 时再次置空。同会话其他入口后挂载不静音。
      next = suppressAutomaticAnimationFromPreviousAuthEpoch(
        next,
        automaticObservationsRef.current[resetType],
        authSessionSeq,
      );
      // 该 used_at 的自动完成提示已在其他窗口播放过（本窗口先收到跨窗口已播广播）。
      // 只抑制本窗口"新进入"的完成；粘滞保持的同一完成不抑制，否则本窗口自己播放时写入的
      // played 记录会在重复对账时把自己的 observedAt 清掉，误杀正常短提示。
      // 被抑制时保留完成态驱动 100% 乐观覆盖与 entitlement 刷新，只是不播 Tooltip/撒花。
      const playedUsedAt = playedBySourceRef.current[sourceKey]?.[key] ?? null;
      const isNewCompletionInWindow =
        previous?.status !== "completed" || previous.completedAt !== next?.completedAt;
      if (
        playedUsedAt !== null &&
        isNewCompletionInWindow &&
        next?.status === "completed" &&
        next.startedAt === null &&
        next.observedAt !== null &&
        next.completedAt === playedUsedAt
      ) {
        next = { ...next, observedAt: null };
      }
      entriesRef.current = withEntry(entriesRef.current, resetType, next);
      setEntry(sourceKey, resetType, next, authSessionSeq);

      const completedAt = next?.status === "completed" ? next.completedAt : null;
      const isNewCompletion = completedAt !== null && completedAt !== previous?.completedAt;
      // has_unread_history 是两类共享的单一游标；任一类型完成后标记已读即可清空，
      // used_at 按类型唯一，重复标记无副作用。
      // 必须先于 entitlement 刷新标记已读。等待刷新完成再上报会延迟清理服务端游标，
      // 其他窗口在此期间轮询可能重复播放自动完成提示。
      if (snapshot.hasUnreadHistory && completedAt !== null) {
        void markHistoryReadOnce({
          service: usageStatsService,
          scope,
          usedAt: completedAt,
        }).catch((error) => {
          logger.warn("[coding-plan-reset] history read failed", {
            sourceKey,
            resetType,
            error: toErrorMessage(error),
          });
        });
      }

      const refreshState = lastEntitlementRefreshRef.current[resetType];
      const entitlementAlreadyRefreshed =
        refreshState.sourceKey === sourceKey && refreshState.completedAt === completedAt;
      const refreshEntitlement = onEntitlementRefreshRef.current;
      if (completedAt !== null && !entitlementAlreadyRefreshed && refreshEntitlement) {
        try {
          await refreshEntitlement();
          // 刷新失败时不能提前记为已完成，否则同一 used_at 后续轮询不会再校正真实额度。
          if (authSessionSeqRef.current !== authSessionSeq) {
            return entriesRef.current[key];
          }
          lastEntitlementRefreshRef.current[resetType] = {
            sourceKey,
            completedAt,
          };
          next = completeCodingPlanQuotaResetEntitlementRefresh(next, completedAt);
          entriesRef.current = withEntry(entriesRef.current, resetType, next);
          setEntry(sourceKey, resetType, next, authSessionSeq);
        } catch (error) {
          logger.warn("[coding-plan-reset] entitlement refresh failed", {
            sourceKey,
            resetType,
            error: toErrorMessage(error),
          });
        }
      }

      if (isNewCompletion) {
        logger.info("[coding-plan-reset] completed", {
          sourceKey,
          resetType,
          completedAt,
        });
      }
      return next;
    },
    [authSessionSeq, scope, setEntry, sourceKey, usageStatsService],
  );

  const applyStatus = useCallback(
    async (snapshot: CodingPlanResetStatusSnapshot): Promise<CodingPlanQuotaResetUiEntries> => {
      // 一次 /status 快照同时对账五小时与周额度，避免重复轮询。
      for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
        await applyStatusForType(snapshot, resetType);
      }
      return entriesRef.current;
    },
    [applyStatusForType],
  );

  const refreshStatus = useCallback(
    async (force = false): Promise<CodingPlanQuotaResetUiEntries> => {
      if (!enabled || !usageStatsService || !scope) {
        return entriesRef.current;
      }
      const previous = entriesRef.current;
      const snapshot = await requestCodingPlanResetStatus({
        service: usageStatsService,
        scope,
        force,
        authSessionSeq,
      });
      const next = await applyStatus(snapshot);
      // /opportunity 是 scope 级发放接口,一次同时评估五小时与周两类资格。后端对「同一类型
      // 已持有未消费机会」有发放上限,重复调用不会叠加,因此"已有可用机会"不再阻塞本次调用——
      // 否则一类挂着机会会饿死另一类的发放(周机会可挂数天,期间五小时永远发不出来)。
      // 仍需跳过的两种情形与发放上限无关:
      // - 手动核销进行中:/use 对账循环里 250ms~1.5s 连发 4 次,插入 /opportunity 会撞发卡锁触发 429;
      // - 本轮刚完成:完成周期内已在做 history/read 与 entitlement 强刷,此刻发放必被 next_try_at 拒。
      const anyTypeResetInFlight = CODING_PLAN_QUOTA_RESET_TYPES.some((resetType) => {
        const key = entryKeyForType(resetType);
        const entry = next[key];
        const previousEntry = previous[key];
        const justCompleted =
          entry?.status === "completed" &&
          entry.completedAt !== null &&
          entry.completedAt !== previousEntry?.completedAt;
        return (
          entry?.status === "processing" || previousEntry?.status === "processing" || justCompleted
        );
      });
      if (anyTypeResetInFlight) {
        return next;
      }

      try {
        // /status 只查询已发放机会；必须再调 /opportunity，否则后端不会执行资格判断。
        // 资格仍完全由服务端决定,客户端在非核销/非刚完成时都触发判断,并按 service + scope
        // 合并并发请求。/opportunity 是 scope 级请求,一次即覆盖五小时与周两类机会。
        const result = await requestCodingPlanResetOpportunityWhenDue({
          service: usageStatsService,
          authSessionSeq,
          scope,
        });
        if (result === null) {
          return next;
        }
        if (!result.granted) {
          return next;
        }
        const confirmedSnapshot = await requestCodingPlanResetStatus({
          service: usageStatsService,
          scope,
          force: true,
          authSessionSeq,
        });
        return applyStatus(confirmedSnapshot);
      } catch (error) {
        logger.warn("[coding-plan-reset] opportunity request failed", {
          sourceKey,
          error: toErrorMessage(error),
        });
        return next;
      }
    },
    [applyStatus, authSessionSeq, enabled, scope, sourceKey, usageStatsService],
  );

  // 四个 UI 入口各自维护 60 秒计时器时，只能合并同一瞬间的 in-flight，
  // 错开的挂载与定时 tick 仍会放大 /status 和 /opportunity。改为 auth session + service + scope
  // 唯一 Coordinator；入口只订阅，共享一个可见性监听和一个轮询 owner。
  useEffect(() => {
    if (!enabled || !usageStatsService || !scope) {
      return;
    }
    return subscribeCodingPlanQuotaResetPolling({
      service: usageStatsService,
      authSessionSeq,
      scope,
      refresh: () => refreshStatus(false),
    });
  }, [authSessionSeq, enabled, refreshStatus, scope, usageStatsService]);

  // 可核销倒计时：任一类型仍有可核销机会（含 completed 携带的余下机会）时启动 1 秒 ticker；
  // 入口变化时刷新 now 保证倒计时/窗口基于最新时间。
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const nowMs = Date.now();
    setNow(nowMs);
    const anyUsable =
      hasUsableCodingPlanQuotaResetOpportunity(fiveHourEntry, nowMs) ||
      hasUsableCodingPlanQuotaResetOpportunity(weekEntry, nowMs);
    if (!anyUsable) {
      return;
    }
    const ticker = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(ticker);
  }, [enabled, fiveHourEntry, weekEntry]);

  // completed 短提示窗口：取两类中最近的未过期到期时刻定时刷新，逐个到期后自动停止。
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const completed = [fiveHourEntry, weekEntry].filter(
      (candidate): candidate is CodingPlanQuotaResetUiEntry =>
        candidate?.status === "completed" && candidate.observedAt !== null,
    );
    if (completed.length === 0) {
      return;
    }
    const nowMs = Date.now();
    const nextBoundary = completed
      .map((entry) => (entry.observedAt ?? 0) + CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS)
      .filter((boundary) => boundary > nowMs)
      .sort((left, right) => left - right)[0];
    if (nextBoundary === undefined) {
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), nextBoundary - nowMs);
    return () => window.clearTimeout(timer);
  }, [enabled, fiveHourEntry, weekEntry, now]);

  const reset = useCallback(
    async (resetType: CodingPlanResetType) => {
      if (!enabled || !sourceKey || !usageStatsService || !scope) {
        return;
      }
      const key = entryKeyForType(resetType);
      // Bugfix：放行条件曾是 status === "available"。completed 携带同类型余下机会时，
      // 弹框里再次点击会在这里被静默忽略（弹框仍播放成功反馈，实际没有 /use）。
      // 统一按「是否仍可核销」判定，与弹框行、徽标、标题旁「重置」同一口径。
      if (!hasUsableCodingPlanQuotaResetOpportunity(entriesRef.current[key], Date.now())) {
        return;
      }
      // 跨入口防双核销：同 scope + 类型已有手动核销轨迹（本窗口其他入口发起，或本入口刚核销
      // 完一张）时，本入口可能基于过期轮询仍显示可核销。先强制对账：对方 /use 仍在进行、或
      // 对账后本入口已无可核销机会（额度已被核销），都不得再次 /use——第二次点击会携带新
      // 幂等键重复核销。对账后仍可核销说明轨迹属于更早的核销，余下或新发放的机会放行为新的
      // 一次核销。多窗口 / remote 入口不共享该轨迹，跨窗口并发由服务端按机会核销兜底。
      const priorAttempt = manualResetAttemptByService
        .get(usageStatsService)
        ?.get(buildManualAttemptKey(scope, resetType));
      if (priorAttempt) {
        const reconciled = await refreshStatus(true);
        if (
          priorAttempt.completedAt === null ||
          !hasUsableCodingPlanQuotaResetOpportunity(reconciled[key], Date.now())
        ) {
          return;
        }
      }
      const current = entriesRef.current[key];
      // 放行判定与 processing 起点共用同一时刻，避免机会恰好在两次取时之间到期。
      const startedAt = Date.now();
      if (!current || !hasUsableCodingPlanQuotaResetOpportunity(current, startedAt)) {
        return;
      }
      const idempotencyKey = current.idempotencyKey ?? createIdempotencyKey();
      const processing = startCodingPlanQuotaResetManualUse(current, idempotencyKey, startedAt);
      if (!processing) {
        return;
      }
      // 手动重置的完成历史会被 Composer、设置页和 Usage 页分别轮询到。
      // 轨迹必须按 service + scope + 类型 共享，不能只依赖发起入口自己的 processing 状态。
      startSharedManualResetAttempt({
        service: usageStatsService,
        scope,
        startedAt,
        resetType,
        authSessionSeq,
      });
      entriesRef.current = withEntry(entriesRef.current, resetType, processing);
      setEntry(sourceKey, resetType, processing, authSessionSeq);

      let useAccepted = false;
      try {
        await usageStatsService.useCodingPlanReset({
          ...scope,
          idempotencyKey,
          resetType,
        });
        useAccepted = true;

        for (const delayMs of USE_STATUS_RETRY_DELAYS_MS) {
          await wait(delayMs);
          const confirmed = await refreshStatus(true);
          if (confirmed[key]?.status === "completed") {
            return;
          }
        }
        throw new Error("coding_plan_reset_status_not_confirmed");
      } catch (error) {
        if (!useAccepted) {
          clearSharedManualResetAttempt(usageStatsService, scope, resetType);
        }
        const message = toErrorMessage(error);
        const failed = failCodingPlanQuotaResetManualUse(entriesRef.current[key], message);
        entriesRef.current = withEntry(entriesRef.current, resetType, failed);
        setEntry(sourceKey, resetType, failed, authSessionSeq);
        logger.warn("[coding-plan-reset] manual reset failed", {
          sourceKey,
          resetType,
          error: message,
        });
        toast(intl.formatMessage({ id: "codingPlan.quotaReset.failed" }), {
          variant: "warning",
        });
        throw error;
      }
    },
    [authSessionSeq, enabled, intl, refreshStatus, scope, setEntry, sourceKey, usageStatsService],
  );

  const resetFiveHour = useCallback(() => reset("FIVE_HOUR"), [reset]);
  const resetWeek = useCallback(() => reset("WEEK"), [reset]);

  // 临期自动核销：唯一执行通道在 executeCodingPlanQuotaResetAutoUse（与额度耗尽触发源共用），
  // 这里只绑定本 hook 的 reset() 与临期总开关；claim/attempts/失败处理全部继承。
  const runAutoUse = useCallback(
    async (resetType: CodingPlanResetType, expiresAt: number) => {
      if (!enabled || !sourceKey || !usageStatsService || !scope || !broadcastService) {
        return;
      }
      await executeCodingPlanQuotaResetAutoUse({
        service: usageStatsService,
        scope,
        sourceKey,
        broadcastService,
        settingService,
        resetType,
        expiresAt,
        reset: (type) => reset(type),
        isAllowed: (settings) => settings.codingPlanQuotaResetAutoUseEnabled !== false,
        onSuccess: () => {
          toast(intl.formatMessage({ id: "codingPlan.quotaReset.autoUsed" }), {
            variant: "info",
          });
        },
      }).catch(() => {
        // 失败 toast/日志已在执行通道与 reset() 内部处理；这里吞掉避免未处理 rejection。
      });
    },
    [
      broadcastService,
      enabled,
      intl,
      reset,
      scope,
      settingService,
      sourceKey,
      usageStatsService,
    ],
  );

  // 临期自动核销评估：复用倒计时 1s ticker 的 now（ticker 仅在仍有可用机会时运行，与这里
  // 的候选条件同源）；不在 30 分钟窗口内时不产生任何请求，runAutoUse 内部另有幂等防重。
  useEffect(() => {
    if (!enabled || !autoUseEnabled) {
      return;
    }
    const nowMs = Date.now();
    for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
      const entry = resetType === "WEEK" ? weekEntry : fiveHourEntry;
      // hasUsable 不带类型谓词，这里显式判空完成收窄。
      if (!entry || !hasUsableCodingPlanQuotaResetOpportunity(entry, nowMs)) {
        continue;
      }
      const expiresAt = entry.opportunityExpiresAt;
      if (expiresAt !== null && expiresAt - nowMs <= CODING_PLAN_QUOTA_RESET_AUTO_USE_LEAD_MS) {
        void runAutoUse(resetType, expiresAt);
      }
    }
  }, [autoUseEnabled, enabled, fiveHourEntry, weekEntry, now, runAutoUse]);
  const reserveAutomaticCompletion = useCallback(
    async (
      resetType: CodingPlanResetType,
      completedAt: number,
    ): Promise<CodingPlanQuotaResetAutoPlayReservationAttempt> => {
      if (!enabled || !sourceKey) {
        return { status: "blocked" };
      }
      try {
        return await reserveAutoPlay(sourceKey, resetType, completedAt);
      } catch (error) {
        logger.warn("[coding-plan-reset] autoplay reservation failed", {
          sourceKey,
          resetType,
          completedAt,
          error: toErrorMessage(error),
        });
        return { status: "retry", retryAfterMs: 500 };
      }
    },
    [enabled, reserveAutoPlay, sourceKey],
  );

  const commitAutomaticCompletion = useCallback(
    (reservation: CodingPlanQuotaResetAutoPlayReservation): boolean => commitAutoPlay(reservation),
    [commitAutoPlay],
  );

  const releaseAutomaticCompletion = useCallback(
    async (reservation: CodingPlanQuotaResetAutoPlayReservation): Promise<void> => {
      try {
        await releaseAutoPlay(reservation);
      } catch (error) {
        logger.warn("[coding-plan-reset] autoplay reservation release failed", {
          sourceKey: reservation.sourceKey,
          resetType: reservation.resetType,
          completedAt: reservation.completedAt,
          error: toErrorMessage(error),
        });
      }
    },
    [releaseAutoPlay],
  );

  const buildTypeController = (
    entry: CodingPlanQuotaResetUiEntry | null,
    resetFn: () => Promise<void>,
  ): CodingPlanQuotaResetTypeController => ({
    entry,
    // Bugfix：曾只认 status === "available"，completed 携带的同类型余下机会不可见，
    // 徽标少计、标题显示「已重置」。改用与 reset() 放行同一判定。
    opportunityVisible: hasUsableCodingPlanQuotaResetOpportunity(entry, now),
    processing: entry?.status === "processing",
    done: entry?.status === "completed",
    statusVisible: enabled && resolveCodingPlanQuotaResetStatusVisible(entry, now),
    reset: resetFn,
  });

  return {
    enabled,
    ...buildTypeController(fiveHourEntry, resetFiveHour),
    week: buildTypeController(weekEntry, resetWeek),
    reserveAutomaticCompletion,
    commitAutomaticCompletion,
    releaseAutomaticCompletion,
  };
}
