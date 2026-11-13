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

源码在 `src/`（`index.ts` 为宿主半，`client.ts` 为浏览器半，`shared.ts` 为两端共享的协议类型），esbuild 产物输出到 `lib/`（不入库）。

## 安装

作为 profile 依赖以 `link:` 方式引入，详见 [docs/DETAIL.md](docs/DETAIL.md)。
