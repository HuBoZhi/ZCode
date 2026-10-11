import { migrateLegacyDataRootIfNeeded } from "./dataRootMigration.js";
import { applyEarlyDataBaseDirBootstrap } from "./desktopDataBaseDirBootstrap.js";

// 品牌根迁移必须先于 bootstrap 读 setting.json（specs/fork-data-root-isolation.md）。
migrateLegacyDataRootIfNeeded();
applyEarlyDataBaseDirBootstrap();
