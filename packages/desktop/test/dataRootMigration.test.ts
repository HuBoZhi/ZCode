import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { ZCODE_DATA_DIR_NAME } from "@zcode/shared";
import { migrateLegacyDataRootIfNeeded } from "../src/main/dataRootMigration.js";

function createFakeHome(): string {
  return mkdtempSync(join(tmpdir(), "data-root-migration-"));
}

function seedLegacyRoot(home: string): void {
  mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
  writeFileSync(join(home, ".zcode", "v2", "setting.json"), '{"recentProjects":["G:/proj"]}');
  mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
  writeFileSync(join(home, ".zcode", "cli", "db", "db.sqlite"), "db-bytes");
  // tmp 是可再生目录，spec 规定不迁移
  mkdirSync(join(home, ".zcode", "tmp"), { recursive: true });
  writeFileSync(join(home, ".zcode", "tmp", "cache.bin"), "cache");
}

describe("migrateLegacyDataRootIfNeeded", () => {
  it("品牌根不存在且 legacy 存在时做快照迁移：内容复制、tmp 排除、原件不动", () => {
    const home = createFakeHome();
    try {
      seedLegacyRoot(home);
      const result = migrateLegacyDataRootIfNeeded({ homeDir: home });
      expect(result).toEqual({ migrated: true, reason: "done" });

      const brandRoot = join(home, ZCODE_DATA_DIR_NAME);
      expect(existsSync(join(brandRoot, "v2", "setting.json"))).toBe(true);
      expect(readFileSync(join(brandRoot, "v2", "setting.json"), "utf8")).toBe(
        '{"recentProjects":["G:/proj"]}',
      );
      expect(existsSync(join(brandRoot, "cli", "db", "db.sqlite"))).toBe(true);
      // tmp 可再生，不迁移
      expect(existsSync(join(brandRoot, "tmp"))).toBe(false);
      // 快照语义：legacy 原样保留，官方 ZCode 数据不受影响
      expect(existsSync(join(home, ".zcode", "v2", "setting.json"))).toBe(true);
      expect(existsSync(join(home, ".zcode", "tmp", "cache.bin"))).toBe(true);
      // 不留临时目录
      expect(readdirHasNoStaging(home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("品牌根已存在时跳过（幂等）", () => {
    const home = createFakeHome();
    try {
      seedLegacyRoot(home);
      mkdirSync(join(home, ZCODE_DATA_DIR_NAME, "v2"), { recursive: true });
      const result = migrateLegacyDataRootIfNeeded({ homeDir: home });
      expect(result).toEqual({ migrated: false, reason: "brand-root-exists" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("legacy 根不存在时跳过", () => {
    const home = createFakeHome();
    try {
      const result = migrateLegacyDataRootIfNeeded({ homeDir: home });
      expect(result).toEqual({ migrated: false, reason: "no-legacy-root" });
      expect(existsSync(join(home, ZCODE_DATA_DIR_NAME))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("设置了 ZCODE_DATA_BASE_DIR 时不迁移（进程级强覆盖让位）", () => {
    const home = createFakeHome();
    try {
      seedLegacyRoot(home);
      const result = migrateLegacyDataRootIfNeeded({
        homeDir: home,
        env: { ZCODE_DATA_BASE_DIR: "/custom/data" },
      });
      expect(result).toEqual({ migrated: false, reason: "env-data-base-dir" });
      expect(existsSync(join(home, ZCODE_DATA_DIR_NAME))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function readdirHasNoStaging(home: string): boolean {
  return !readdirSync(home).some((name) => name.startsWith(`${ZCODE_DATA_DIR_NAME}-migrating`));
}
