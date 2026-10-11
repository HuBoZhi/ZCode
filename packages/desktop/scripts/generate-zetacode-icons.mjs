#!/usr/bin/env node
/* eslint-disable no-console */
// ZetaCode 图标资产生成：build/zetacode-icon.svg（矢量母版）→ 各尺寸 PNG。
// 仓库没有 sharp/ImageMagick，用 Electron renderer canvas 完成高质量矢量栅格化与缩放。
// 用法：pnpm exec electron scripts/generate-zetacode-icons.mjs（工作目录 packages/desktop）。
const { app, BrowserWindow } = await import("electron");
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const { resolve, dirname } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svgSource = await readFile(resolve(desktopRoot, "build/zetacode-icon.svg"), "utf8");
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

const RENDERER_HTML = `<!doctype html><html><body style="margin:0">
<script>
  const { ipcRenderer } = require("electron");
  const SIZES = ${JSON.stringify(SIZES)};
  window.__run = async (svg) => {
    const blobUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.decoding = "sync";
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = blobUrl; });
    // 先栅格化到 1024 再逐档缩放：矢量直接缩到 16px 时 stroke 比例失真，两级缩放更平滑。
    const base = document.createElement("canvas");
    base.width = 1024; base.height = 1024;
    base.getContext("2d").drawImage(img, 0, 0, 1024, 1024);
    const out = [];
    for (const size of SIZES) {
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(base, 0, 0, size, size);
      out.push({ size, dataUrl: canvas.toDataURL("image/png") });
    }
    return out;
  };
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 1100,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(RENDERER_HTML)}`);
  const results = await win.webContents.executeJavaScript(
    `window.__run(${JSON.stringify(svgSource)})`,
  );

  const outDir = resolve(desktopRoot, "build/.zetacode-icon-render");
  await mkdir(outDir, { recursive: true });
  for (const { size, dataUrl } of results) {
    const base64 = dataUrl.slice("data:image/png;base64,".length);
    await writeFile(resolve(outDir, `icon-${size}.png`), Buffer.from(base64, "base64"));
  }
  console.log(`[icon] rendered ${results.length} sizes to ${outDir}`);
  app.exit(0);
});
