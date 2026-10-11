# Fork 数据根隔离（ZetaCode vs 官方 ZCode）

本仓库是 ZCode 的个人 fork，安装身份为 ZetaCode（见 [desktop-product-identity.md](./desktop-product-identity.md)）。安装身份隔离后，两个应用仍共用 `~/.zcode` 全局数据根：项目列表（`recentProjects`）、对话历史（`tasks-index.sqlite`、rollout、`cli/db/db.sqlite`）、登录凭据、skills、plugins 全部互相同步。本 spec 定义全局数据根的品牌隔离规则。

## 产品规则

1. **品牌数据根**：ZetaCode 的全局数据根为 `{dataBaseDir}/.zetacode`（默认 `{home}/.zetacode`）；官方 ZCode 继续使用 `~/.zcode`。两侧互不可见、互不写。
2. **workspace 级目录不变**：项目内 `.zcode/`（config.json、skills、commands、agents、workflows、agent-memory 等）跟项目走，目录名保持 `.zcode`。两个应用打开同一项目共享项目级配置是预期行为；`basename === ".zcode"` 的 workspace 级规范化判断保留。
3. **自定义数据根语义不变**：`ZCODE_DATA_BASE_DIR` env 与 setting.json `dataBaseDir` 仍是数据根父目录的唯一覆盖通道（`packages/services/src/paths.ts` 的 `getDataBaseDir()`）。设置后品牌根变为 `<dataBaseDir>/.zetacode`。两个应用被显式指向同一 dataBaseDir 时等于用户主动选择共享，不在本 spec 保护范围。
4. **首次快照迁移**：desktop main 启动最早阶段（`applyEarlyDataBaseDirBootstrap` 之前）执行：
   - 条件：品牌根不存在 且 `~/.zcode` 存在 且 未设置 `ZCODE_DATA_BASE_DIR`。
   - 动作：整根复制 `~/.zcode` → 临时目录（排除 `tmp/`），成功后原子 rename 为品牌根；rename 失败（并发/已存在）清理临时目录并跳过。
   - 幂等：品牌根已存在即跳过，无需 marker 文件。
   - 迁移是尽力而为快照：官方 ZCode 同时运行时 `tasks-index.sqlite`（WAL/SHM）可能取到不一致副本；首次迁移建议先关闭官方 ZCode。凭据随快照复制，若服务端轮换 refresh token 导致一侧失效，重新登录即可。
   - 仅 desktop 触发迁移；CLI 子进程由 desktop 启动，天然晚于迁移。CLI 独立运行且品牌根不存在时从零开始，不迁移。
5. **刻意不迁移**：`tmp/`（可再生）；`mcpUserDirectory/legacy.ts` 的历史迁移来源路径（旧 Electron userData 位置，与数据根无关）。

## 状态所有者与接口

- **常量单一权威**：`packages/shared/src/zcode-agent-runtime.ts` 导出 `ZCODE_DATA_DIR_NAME = ".zetacode"`（上游值为 `".zcode"`，合并上游时保留 fork 值）。`ZCODE_AGENT_RUNTIME.nativeConfigDir` 由该常量拼接为 `.zetacode/cli`。
- CLI workspace 通过 `@zcode/shared`（workspace symlink 指向主 repo `packages/shared`）消费同一常量，不重复定义。
- 全局路径一律经 `ZCODE_DATA_DIR_NAME` 组装；禁止新增 `".zcode"` 字面量用于全局路径（workspace 级除外）。
- desktop 迁移入口：`packages/desktop/src/main/dataRootMigration.ts` 的 `migrateLegacyDataRootIfNeeded()`；main 启动序为 迁移 → `applyEarlyDataBaseDirBootstrap()` → 其余初始化。

## 验收场景

1. 单测：常量值与 `nativeConfigDir` 拼接；迁移函数（临时 home 下造 `~/.zcode` 结构，断言复制 + rename + 幂等跳过 + 排除 `tmp/` + env 设置时不迁移）。
2. 本机实测：启动后 `~/.zetacode` 出现且含 setting.json / v2 / cli；在 ZetaCode 移除项目后 `~/.zcode/v2/setting.json` 的 `recentProjects` 不变。
3. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过。
