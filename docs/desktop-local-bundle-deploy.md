# Desktop 本机打包与部署（Windows）

## 背景

ZetaCode fork 的日常验收方式之一是「从 dev 工作区打 Windows 安装包并部署到本机安装版」。CI 正式发布流程见 [desktop-ci-cd.md](desktop-ci-cd.md)，本文只覆盖本机（Windows + Git Bash）的打包与静默部署，并沉淀历次踩过的坑。经验来自 2026-10-11 的实际打包部署。

## 打包

前置条件：

- Node `24.14.0` / pnpm `10.33.2`（以 `mise.toml` 为准）。
- `node scripts/check-workspace-freshness.mjs` 确认基线。
- 打包内容等于当前工作区（含未提交改动）；想排除未提交改动先 stash。

命令（仓库根目录）：

```
pnpm bundle:desktop -- --os win --arch x64
```

- 全程约 10~15 分钟（runtime assets → 全量 build → electron-builder → 校验），建议放后台执行。
- 产物：`packages/desktop/dist/ZetaCode-<version>-win-x64.exe`（约 148 MiB）与同名 `.blockmap`。
- 脚本自带两道机械校验，全部通过才视为打包成功：
  - `bundle:verify-runtime-dependencies`：app.asar 内运行时依赖闭包（undici、ssh2 依赖链、OTLP 导出链等）必须齐全；
  - `bundle:audit-bundle-size`：产物体积 < 500 MiB。
- `ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT` 未设为 `1` 时，安装包不携带 Windows 浏览器导入 helper，这是默认预期。

## 部署（本机全机安装）

本机 ZetaCode 是 per-machine 安装：

- 安装目录 `D:\Program Files\ZetaCode`，卸载键在 `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`，`/allusers` 模式。
- 卸载键里 `InstallLocation` 为空 → 静默安装必须显式 `/D=` 指定目录，否则会装到默认 `C:\Program Files\ZetaCode`，形成第二份安装。

从非提权 shell 执行（会弹一次 UAC，需要人在机器前点「是」）：

```bash
powershell -NoProfile -Command '$p = Start-Process -FilePath "G:\Coding\Github\ZCode\packages\desktop\dist\ZetaCode-<version>-win-x64.exe" -ArgumentList "/S /allusers /D=D:\Program Files\ZetaCode" -Verb RunAs -Wait -PassThru; "installer exit code: " + $p.ExitCode'
```

行为细节（依据 electron-builder NSIS 模板 `app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh`）：

- `/S` 静默模式下遇到运行中的应用会自动结束进程（`MessageBox MB_OKCANCEL /SD IDOK` → `doStopProcess` → kill 后轮询等待退出），不需要也不建议先手动 taskkill。
- 安装器先按注册表 UninstallString 卸载旧版再装新版；用户数据（`~/.zetacode`）不受影响。
- NSIS `/D=` 规则：必须是最后一个参数，且即使路径含空格也不能加引号。因此 PowerShell `-ArgumentList` 必须传单个字符串——传数组时 PowerShell 会给含空格的参数自动加引号，`/D=` 随即失效。
- 静默安装不会自动重启应用，部署完成后手动拉起：

```bash
powershell -NoProfile -Command 'Start-Process -FilePath "D:\Program Files\ZetaCode\ZetaCode.exe"'
```

## 验证

- `D:\Program Files\ZetaCode\ZetaCode.exe` 的修改时间应等于本次构建时间。
- 内容级验证：对比安装目录 `resources/app.asar` 与 `packages/desktop/dist/win-unpacked/resources/app.asar` 的 sha256，应完全一致。
- 版本号不变时（`package.json` 未升版），注册表 `DisplayVersion` 与应用内「关于」页都不变，不能作为新旧判断依据；要么用上面的时间戳/哈希，要么打包前先升版本号。

## 踩坑记录

### Git Bash 调 PowerShell：`$_` 必须外层单引号

在 Git Bash 中执行 `powershell -NoProfile -Command "… $_.Name …"`（外层双引号）时，`$_` 会先被 bash 展开成「上一条命令的最后一个参数」。本机 zcode CLI 的 bash 启动脚本会把内层脚本路径带进命令行，PowerShell 收到的命令被污染，产生上百 KB 的重复报错垃圾输出，而且报错内容看起来毫不相关，极难一眼定位。

规则：从 Git Bash 调 PowerShell 一律外层用单引号，内层需要引号的字符串改用双引号：

```bash
# 错误：$_ 被 bash 提前展开
powershell -NoProfile -Command "Get-Process | Where-Object { $_.Name -match 'ZetaCode' }"

# 正确
powershell -NoProfile -Command 'Get-Process | Where-Object { $_.Name -match "ZetaCode" }'
```

### 其他已知噪音

- pnpm 启动时 `The "pnpm" field in package.json is no longer read by pnpm` 警告是已知噪音，不影响打包结果。
- 查注册表/进程时优先用上面的单引号写法；`reg.exe query` 是无 `$_` 陷阱的备选。
- 部署用的 UAC 弹窗必须人工确认，无人值守任务不要把「部署」排在没人操作的时段。
