import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  desktopProductIdentities,
  resolveDesktopArtifactSuffix,
  resolveDesktopProductFlavor,
  resolveWindowsAppUserModelId,
  resolveWindowsAppUserModelIdForFlavor,
  resolveDesktopProductIdentity,
} from "../scripts/desktop-product-identity.mjs";
import { ZCODE_AGENT_RUNTIME, ZCODE_DATA_DIR_NAME } from "@zcode/shared";
import { resolveCuaPermissionPanelMessages } from "../src/renderer/cuaPermissionPanelMessages.js";

describe("desktop product identity", () => {

  it("品牌数据根目录名与 agent runtime 配置目录一致（fork 数据根隔离）", () => {
    // specs/fork-data-root-isolation.md：单一权威在 @zcode/shared，services / CLI / desktop 共同引用。
    expect(ZCODE_DATA_DIR_NAME).toBe(".zetacode");
    expect(ZCODE_AGENT_RUNTIME.nativeConfigDir).toBe(`${ZCODE_DATA_DIR_NAME}/cli`);
  });
  it("根锁文件的发布版本与构建版本一致", () => {
    // 合并上游发布提交只对齐当前版本，不恢复上游旧版本，也不重算依赖锁。
    const readRootJson = (name: string) =>
      JSON.parse(readFileSync(resolve(import.meta.dirname, "../../..", name), "utf8"));
    const version = readRootJson("package.json").version;
    const lock = readRootJson("package-lock.json");
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
  });

  it("ZCODE_ENV=test 使用可与生产版并排安装的 Preview 身份", () => {
    expect(resolveDesktopProductIdentity({ ZCODE_ENV: "test" })).toEqual({
      flavor: "preview",
      appId: "dev.zetacode.app.preview",
      productName: "ZetaCode Preview",
      linuxExecutableName: "zetacode-preview",
      linuxPackageName: "zetacode-preview",
      cuaHelperInstallVariant: "preview",
    });
  });

  it("ZCODE_PREVIEW_IDENTITY=1 让生产后端的构建改用 Preview 身份", () => {
    // 身份与后端环境分轴：同一份 Preview 身份既可以连测试后端，也可以连生产后端。
    for (const flag of ["1", " 1 "]) {
      const env = { ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: flag };
      expect(resolveDesktopProductFlavor(env)).toBe("preview");
      expect(resolveDesktopProductIdentity(env)).toBe(desktopProductIdentities.preview);
    }
    for (const flag of ["", "0"]) {
      const env = { ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: flag };
      expect(resolveDesktopProductFlavor(env)).toBe("production");
    }
  });

  it("开关只认 1/0：其它拼写在构建期直接失败，不能在路由层漏匹配却在脚本层开启", () => {
    // CI workflow 规则与 release 门做 == "1" 精确比较；若脚本层再接受 true/yes/on，
    // `ZCODE_PREVIEW_IDENTITY=true` 会落入 @electron/dev 生产验收目录却打出 Preview 身份包。
    for (const flag of ["true", "yes", "on", "false", "no", "off", "2"]) {
      expect(() =>
        resolveDesktopProductFlavor({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: flag }),
      ).toThrow(/expected 1 or 0/);
    }
  });

  it("测试后端永远是 Preview 身份，开关无法把它变成正式 ZCode", () => {
    expect(resolveDesktopProductFlavor({ ZCODE_ENV: "test", ZCODE_PREVIEW_IDENTITY: "0" })).toBe(
      "preview",
    );
    expect(resolveDesktopProductFlavor({ ZCODE_ENV: "test", ZCODE_PREVIEW_IDENTITY: "1" })).toBe(
      "preview",
    );
  });

  it("产物后缀只标记后端环境，生产后端的 Preview 包靠 productName 区分", () => {
    expect(resolveDesktopArtifactSuffix({ ZCODE_ENV: "test" })).toBe("_TEST");
    expect(resolveDesktopArtifactSuffix({ ZCODE_ENV: "production" })).toBe("");
    expect(
      resolveDesktopArtifactSuffix({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" }),
    ).toBe("");
    expect(resolveDesktopArtifactSuffix({})).toBe("_TEST");
  });

  it("ZCODE_ENV=production 完整保留正式包身份", () => {
    expect(resolveDesktopProductIdentity({ ZCODE_ENV: "production" })).toBe(
      desktopProductIdentities.production,
    );
    expect(desktopProductIdentities.production).toEqual({
      flavor: "production",
      appId: "dev.zetacode.app",
      productName: "ZetaCode",
      linuxExecutableName: "zetacode",
      linuxPackageName: "zetacode",
      cuaHelperInstallVariant: null,
    });
  });

  it("未注入或未知环境时不应误生成正式安装身份", () => {
    expect(resolveDesktopProductIdentity({}).flavor).toBe("preview");
    expect(resolveDesktopProductIdentity({ ZCODE_ENV: "staging" }).flavor).toBe("preview");
  });

  it("打包态 Windows AUMID 必须和 NSIS appId 保持一致", () => {
    expect(resolveWindowsAppUserModelId({ ZCODE_ENV: "production" })).toBe(
      desktopProductIdentities.production.appId,
    );
    expect(resolveWindowsAppUserModelId({ ZCODE_ENV: "test" })).toBe(
      desktopProductIdentities.preview.appId,
    );
    expect(
      resolveWindowsAppUserModelId({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" }),
    ).toBe(desktopProductIdentities.preview.appId);
    // 主进程按编译期 flavor 取 AUMID，不依赖安装后机器上的环境变量。
    expect(resolveWindowsAppUserModelIdForFlavor("preview")).toBe(
      desktopProductIdentities.preview.appId,
    );
    expect(resolveWindowsAppUserModelIdForFlavor("production")).toBe(
      desktopProductIdentities.production.appId,
    );
  });

  it("开发态继续使用独立 AUMID，避免污染打包版 Shell 身份", () => {
    // fork 的开发态 AUMID 同样改名，与官方 ZCode 的开发调试身份区分开。
    expect(resolveWindowsAppUserModelId({}, { isPackaged: false })).toBe("dev.zetacode.app.dev");
  });

  it("renderer 窗口标题不得回退成旧 ZCode 品牌", () => {
    // 主窗口 BrowserWindow 的 title 为空，任务栏悬浮预览/Alt+Tab 显示的实际标题来自
    // renderer HTML 的 <title>（页面加载后 document.title 覆盖空标题）。这些静态标题
    // 曾在 fork 改名时遗漏，导致任务栏悬浮弹窗仍显示 "ZCode"。
    const rendererDir = resolve(import.meta.dirname, "../src/renderer");
    const htmlFiles = readdirSync(rendererDir).filter((name) => name.endsWith(".html"));
    expect(htmlFiles.length).toBeGreaterThan(0);
    for (const fileName of htmlFiles) {
      const content = readFileSync(resolve(rendererDir, fileName), "utf8");
      const title = content.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
      expect(title.startsWith("ZCode"), `${fileName} title="${title}"`).toBe(false);
    }
    // CUA 权限浮窗在运行时用 documentTitle 覆盖 <title>，同样必须跟随 ZetaCode 品牌。
    expect(resolveCuaPermissionPanelMessages("zh-CN", "accessibility").documentTitle).toBe(
      "ZetaCode Computer Use 权限",
    );
    expect(resolveCuaPermissionPanelMessages("en-US", "accessibility").documentTitle).toBe(
      "ZetaCode Computer Use Permissions",
    );
  });
});
