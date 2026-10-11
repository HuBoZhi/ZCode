# Desktop 产品身份（fork：ZetaCode）

本仓库是 ZCode 的个人 fork，安装身份统一为 **ZetaCode**，目标是与官方 ZCode 安装包并排共存、互不干扰。身份的唯一权威定义在 `packages/desktop/scripts/desktop-product-identity.mjs`。

## 身份规则

| 身份轴 | 正式（production） | 预览（preview） |
| --- | --- | --- |
| productName | ZetaCode | ZetaCode Preview |
| appId（AUMID / macOS Bundle ID） | dev.zetacode.app | dev.zetacode.app.preview |
| Linux 可执行名 / 包名 | zetcode | zetcode-preview |
| 开发态 AUMID（未打包） | dev.zetacode.app.dev | - |
| 开发态 macOS bundle（`devElectronAppBundle.mjs`） | ZetaCode Dev / dev.zetacode.app.development | - |

- 运行时应用名（`desktopRuntimeEnv.ts` 的 `runtimeApplicationName`）默认值为 ZetaCode / ZetaCode Preview / ZetaCode Dev（dev 态），可由 `ZCODE_DESKTOP_APPLICATION_NAME` 覆盖（e2e 用）。
- userData / sessionData 目录由 `runtimeApplicationName` 派生（Roaming 下同名目录），因此 fork 与官方安装天然隔离。
- Windows 资源管理器右键菜单使用独立注册表键 `ZetaCode.OpenInZetaCode`，不与官方 `ZCode.OpenInZCode` 键互相覆盖。
- 窗口标题（任务栏悬浮预览、Alt+Tab 显示名）：主窗口 `BrowserWindow` 的 `title` 为空，实际标题由 renderer HTML 的 `<title>` 提供（页面加载后 `document.title` 覆盖空标题）。所有 renderer HTML 的 `<title>` 与运行时写入的 `document.title`（如 CUA 权限浮窗文案）一律以 ZetaCode 品牌开头，不得残留旧 `ZCode` 品牌。

- **全局数据根品牌隔离**：运行时数据根目录名为 `.zetacode`（常量 `ZCODE_DATA_DIR_NAME`，权威定义在 `packages/shared/src/zcode-agent-runtime.ts`），与官方 ZCode 的 `~/.zcode` 互不可见；首次启动做一次性快照迁移。规则与验收见 [fork-data-root-isolation.md](./fork-data-root-isolation.md)。

## 刻意不改的部分

- **`zcode://` 深度链接协议**：OAuth 回调地址 `zcode://oauth/callback` 是服务端注册的固定 redirect URI（见 `packages/services/src/oauth/providers/*`），改协议会破坏登录。代价是两个应用同时安装时，`zcode://` 归最后注册方所有。
- **历史数据迁移路径**：`mcpUserDirectory/legacy.ts` 中的 `ZCode` / `ZCode Dev` 等路径是旧版本数据的迁移候选来源，指向历史安装位置，必须保留。
- **`@zcode/*` 包名与内部标识符**（NSIS 宏、环境变量前缀 `ZCODE_` 等）：属内部实现，不影响安装身份。

## 验收场景

1. `node --test` / vitest：`packages/desktop/test/desktopProductIdentity.test.ts` 与 `desktopRuntimeEnv.test.ts` 断言上表值。
2. 打包产物：安装目录、快捷方式、可执行文件名为 ZetaCode；`程序和功能` 中发布者为 ZetaCode。
3. 与官方 ZCode 并排安装：两个应用各自拥有独立的 userData 目录、右键菜单项与 AUMID；卸载任一不影响另一个。
