#!/usr/bin/env node
/* eslint-disable no-console */
// 把 build/.zetacode-icon-render 的 PNG 组装成 electron-builder 需要的图标资产：
// icon.ico / icon_installer.ico（PNG-in-ICO，Vista+ 全支持）、覆盖 build/*.png 与 icons/ hicolor 全套。
// ICNS 由 app-builder.exe icns 单独生成（见脚本尾部提示）。用法同 generate-zetacode-icons.mjs。
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const renderDir = resolve(desktopRoot, "build/.zetacode-icon-render");
const buildDir = resolve(desktopRoot, "build");

// ICO：6 字节 header + N 条 16 字节 directory + PNG 数据（PNG-in-ICO）。
async function packIco(sizes, outPath) {
  const entries = await Promise.all(
    sizes.map(async (size) => ({
      size,
      data: await readFile(resolve(renderDir, `icon-${size}.png`)),
    })),
  );
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(entries.length * 16);
  let dataOffset = 6 + entries.length * 16;
  entries.forEach((entry, index) => {
    const base = index * 16;
    // 256 在 ICO directory 里写作 0。
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    dir.writeUInt16LE(1, base + 4); // planes
    dir.writeUInt16LE(32, base + 6); // bpp
    dir.writeUInt32LE(entry.data.length, base + 8);
    dir.writeUInt32LE(dataOffset, base + 12);
    dataOffset += entry.data.length;
  });
  await writeFile(outPath, Buffer.concat([header, dir, ...entries.map((e) => e.data)]));
}

await packIco([256, 128, 64, 48, 32, 16], resolve(buildDir, "icon.ico"));
await packIco([256, 128, 64, 48, 32, 16], resolve(buildDir, "icon_installer.ico"));

// 母版 PNG：icon.png（应用内 about/tray/cua 弹窗与 extraResources icon.png）、
// icon_windows.png、icon_installer.png 全部用同一母版（官方三者也同款）。
await copyFile(resolve(renderDir, "icon-1024.png"), resolve(buildDir, "icon.png"));
await copyFile(resolve(renderDir, "icon-1024.png"), resolve(buildDir, "icon_windows.png"));
await copyFile(resolve(renderDir, "icon-1024.png"), resolve(buildDir, "icon_installer.png"));

// Linux icon set：build/icons/ 平铺 {size}x{size}.png（electron-builder linux 约定，与官方结构一致）。
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await copyFile(resolve(renderDir, `icon-${size}.png`), resolve(buildDir, "icons", `${size}x${size}.png`));
}
console.log("[icon] ico/png assets written");
