/**
 * Fork 数据根首次快照迁移（specs/fork-data-root-isolation.md）。
 * 在 main 启动最早阶段（applyEarlyDataBaseDirBootstrap 之前）同步执行：
 * 品牌根不存在且 legacy ~/.zcode 存在且未设置 ZCODE_DATA_BASE_DIR 时，
 * 整根复制到临时目录后原子 rename，保证 ZetaCode 与官方 ZCode 数据互不可见。
 * 同步实现是有意的：迁移只发生一次，首启阻塞换时序必然性——
 * 后续所有模块（setting bootstrap / logger / services）读品牌根时必然已迁移完成。
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZCODE_DATA_DIR_NAME } from "@zcode/shared";

const LEGACY_DATA_DIR_NAME = ".zcode";
/** 可再生目录不迁移（spec：刻意不迁移 tmp）。 */
const MIGRATION_EXCLUDED_DIR_NAMES = new Set(["tmp"]);

export interface DataRootMigrationResult {
  migrated: boolean;
  reason: "brand-root-exists" | "no-legacy-root" | "env-data-base-dir" | "done" | "copy-failed";
}

function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    env.HOME?.trim() ||
    env.USERPROFILE?.trim() ||
    homedir()
  );
}

function lastSegment(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
}

export function migrateLegacyDataRootIfNeeded(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): DataRootMigrationResult {
  const env = options?.env ?? process.env;
  const home = options?.homeDir ?? resolveHomeDir(env);
  const brandRoot = join(home, ZCODE_DATA_DIR_NAME);
  const legacyRoot = join(home, LEGACY_DATA_DIR_NAME);

  // ZCODE_DATA_BASE_DIR 是进程级强覆盖；此时品牌根概念让位，不做迁移。
  if (env.ZCODE_DATA_BASE_DIR?.trim()) {
    return { migrated: false, reason: "env-data-base-dir" };
  }
  if (existsSync(brandRoot)) {
    return { migrated: false, reason: "brand-root-exists" };
  }
  if (!existsSync(legacyRoot)) {
    return { migrated: false, reason: "no-legacy-root" };
  }

  // 复制到同卷临时名再 rename：rename 原子，竞态（另一实例已迁完）时报
  // EEXIST/ENOTEMPTY，清理临时目录跳过即可。
  const stagingRoot = join(home, `${ZCODE_DATA_DIR_NAME}-migrating-${process.pid}`);
  try {
    rmSync(stagingRoot, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    cpSync(legacyRoot, stagingRoot, {
      recursive: true,
      force: false,
      filter: (source) => {
        // source 为根目录本身时 basename 为 ".zcode"，不在排除集合，自然放行。
        return !MIGRATION_EXCLUDED_DIR_NAMES.has(lastSegment(source));
      },
    });
    renameSync(stagingRoot, brandRoot);
    console.log(
      `[dataRootMigration] migrated legacy data root ${legacyRoot} -> ${brandRoot} (snapshot copy; original untouched)`,
    );
    return { migrated: true, reason: "done" };
  } catch (error) {
    // 尽力而为：迁移失败不阻断启动，品牌根从空目录开始。
    try {
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      // 清理失败不影响启动
    }
    console.warn(
      `[dataRootMigration] legacy data root migration failed (${legacyRoot} -> ${brandRoot}); starting fresh:`,
      error,
    );
    return { migrated: false, reason: "copy-failed" };
  }
}
