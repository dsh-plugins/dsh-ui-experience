# 界面体验

界面体验增强插件：读取系统 matugen 生成的 Material You 配色，叠加在 DeepSeek Harness 当前主题上。

## 使用

1. 安装并启用本插件后刷新页面。
2. 打开「设置 → 通用设置」，开启 **Matugen 配色跟随** 开关，界面立即叠加 matugen 当前生成的配色。
3. 之后每当 matugen 重新生成颜色（例如更换壁纸），界面配色在数秒内自动跟随，无需刷新。
4. 关闭开关即可回到原生配色；开关状态会被持久化，重启应用后自动恢复。「外观」行的浅色 / 深色 / 跟随系统是原生配置，与开关互不影响。

## 颜色来源

插件按以下顺序读取配色：

1. `~/.local/state/quickshell/user/generated/dsh-tokens.json` —— 专用 DSH token 文件（见下方模板接入）。
2. `~/.local/state/quickshell/user/generated/colors.json` —— matugen 输出的 Material You 颜色表，由插件内置映射转换为界面配色。

两个文件任一存在即可；都被 matugen 重写时界面自动更新。

## matugen 模板接入（可选）

默认的 colors.json 只含一套（暗色）方案。若希望自行控制 DSH 全部 token 的取值，可在 `~/.config/matugen/config.toml` 增加一个模板：

```toml
[templates.dsh]
input_path = '~/.config/matugen/templates/dsh-tokens.json'
output_path = '~/.local/state/quickshell/user/generated/dsh-tokens.json'
```

模板文件内容示例（直接产出 `{ light, dark }` 两卷 DSW token 表）：

```json
{
  "light": {
    "--dsw-alias-bg-base": "{{colors.surface.default.hex}}",
    "--dsw-alias-bg-layer-1": "{{colors.surface_container_low.default.hex}}",
    "--dsw-alias-bg-layer-2": "{{colors.surface_container.default.hex}}",
    "--dsw-alias-bg-overlay": "{{colors.surface_container_high.default.hex}}",
    "--dsw-alias-border-l1": "{{colors.outline_variant.default.hex}}",
    "--dsw-alias-border-l2": "{{colors.outline.default.hex}}",
    "--dsw-alias-brand-primary": "{{colors.primary.default.hex}}",
    "--dsw-alias-label-primary": "{{colors.on_surface.default.hex}}",
    "--dsw-alias-label-secondary": "{{colors.on_surface_variant.default.hex}}",
    "--dsw-alias-state-error-primary": "{{colors.error.default.hex}}",
    "--dsw-alias-state-idle-primary": "{{colors.outline.default.hex}}",
    "--dsw-alias-state-success-primary": "{{colors.tertiary.default.hex}}",
    "--dsw-alias-state-warn-primary": "{{colors.secondary.default.hex}}",
    "--dsw-specific-sidebar-fill": "{{colors.surface_container_lowest.default.hex}}"
  },
  "dark": { "…同上字段…": "…" }
}
```

token 名必须以 `--dsw-` 开头；未列出的 token 保持 DSH 内置值。

## 限制

- matugen 当前输出为暗色方案，浅色 / 深色两种模式都叠加同一张配色表；界面的亮色/暗色切换只影响未覆盖的元素。
- 轮询间隔 2 秒；配色变化最多延迟约 2 秒生效。
