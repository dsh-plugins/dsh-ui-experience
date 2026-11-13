# dsh-ui-experience

DeepSeek Harness 界面体验增强插件：读取系统 matugen 生成的 Material You 配色，叠加在当前主题上，并统一界面边框宽度。

## 功能

- 「设置 → 通用设置」新增 **Matugen 配色跟随** 开关，开启后界面配色跟随 matugen 输出（换壁纸等触发的重新生成会在数秒内自动生效）；开关状态持久化，重启应用后自动恢复。
- 原生「外观」行的浅色 / 深色 / 跟随系统不受影响，配色作为叠加层工作。
- 边框宽度可通过插件配置 `borderWidth` 调整（默认 `0.5px`）。

## 使用前提

- matugen 输出位于 `~/.local/state/quickshell/user/generated/colors.json`；也可用专用模板产出 `dsh-tokens.json`（见 [docs/DETAIL.md](docs/DETAIL.md)）。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
```

源码在 `src/`（`index.ts` 为宿主半，`client.ts` 为浏览器半，`shared.ts` 为两端共享的协议类型），esbuild 产物输出到 `lib/`。`lib/` 会提交入库，以便其他设备直接从 git 安装而无需构建环境；改动源码后务必重新构建并一并提交产物。

## 安装

本机开发时作为 profile 依赖以 `link:` 方式引入（详见 [docs/DETAIL.md](docs/DETAIL.md)）。

其他设备通过「插件管理器 → 添加插件 → 安装第三方插件」安装，粘贴 Git 仓库地址：

```
git+https://github.com/dsh-plugins/dsh-ui-experience.git
```

注意：

- 地址必须以 `git+` 开头；裸 `https://` 不会被识别为 Git 仓库。
- 目标设备需要能访问该仓库。
- 构建产物 `lib/` 已入库，无需在目标设备上构建；安装后按提示重启 DSH。
- 不要手动编辑 profile 的 `package.json`：包名以仓库 `package.json` 的 `name` 为准（`@dsh-plugin/dsh-ui-experience`），别名与仓库名不一致时需显式声明。

