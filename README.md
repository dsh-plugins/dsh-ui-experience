# dsh-ui-experience

DeepSeek Harness 界面体验插件（`@dsh-plugin/dsh-ui-experience`，仓库：<https://github.com/dsh-plugins/dsh-ui-experience>）：读取系统 matugen 生成的 Material You 配色，作为叠加层套在 DSH 当前主题上；按 Material 3 曲线改写整个界面的过渡与关键帧动画；并统一界面边框宽度。

## 功能

- 「设置 → 通用设置」新增一行 **Matugen 配色跟随**，由开关控制启用 / 停用。开启后界面立即叠加 matugen 当前输出的配色；matugen 重新生成颜色（例如更换壁纸）后数秒内自动跟随，无需刷新页面。
- 配色是叠加层，不改写原生「浅色 / 深色 / 跟随系统」偏好；开关关闭后回到原生配色。
- 同一行可展开 **配色文件路径**，分别编辑 matugen 颜色文件与 DSH 令牌文件的路径，两者都会持久化；开关状态与路径均保存在 profile 配置里，重启应用后自动恢复。
- 统一界面边框宽度：插件配置 `borderWidth`（默认 `0.5px`），仅在「Matugen 配色跟随」开启时生效。
- 「设置 → 通用设置」另起一行 **M3 动效**，可选择 `M3` / `M3E` 两族曲线，并调时长倍率、时长对齐与减弱动效策略。它原地改写页面上已生效的样式规则，覆盖范围包含第三方插件注入的样式。
- 配色文件只在本地读取，不上传。

## 使用

1. 安装并启用插件后刷新页面。
2. 打开「设置 → 通用设置」，开启 **Matugen 配色跟随**。
3. 界面配色随配色文件内容变化自动更新，检测周期 2 秒。
4. 关闭开关：配色叠加层、边框覆盖与启动底色叠加同时立即撤销——注入样式以 `<html data-dsh-uix-matugen>` 为作用域，关闭时该属性被移除，规则立刻失效；注入的 `<style>` / `<script>` 元素本身保留到下次刷新。此后插件停止 2 秒轮询，改为约 30 秒一次的低频检查。

## 配置路径

「Matugen 配色跟随」所在行可展开 **配色文件路径**，编辑两个路径并保存：

| 文件 | 默认路径 | 用途 |
| --- | --- | --- |
| 颜色文件 | `~/.local/state/quickshell/user/generated/colors.json` | matugen 原始输出；插件用内置映射把它转换为界面配色 |
| 令牌文件 | `~/.local/state/quickshell/user/generated/dsh-tokens.json` | 由自定义 matugen 模板产出的 DSH token 表，**逐 token 叠加**在内置映射之上 |

- 两个文件是叠加关系，不是替代关系：颜色文件提供完整的内置映射，令牌文件里列出的 token 覆盖对应项，未列出的继续用映射值。只写需要的几项也能生效，不会让其余界面退回原生配色。
- 只存在令牌文件、没有颜色文件时，未列出的 token 只能保持 DSH 内置值；插件会在日志中说明这一情况。
- 路径必须是绝对路径，或以 `~/` 开头（`~` 按当前用户主目录展开）。
- 「恢复默认」把两个路径重置为上表默认值。
- 两个文件都不存在时插件不上色，界面保持原生配色。

## 表面层级

内置映射把 Material You 的六档表面按明度排成阶梯：

`surface_container_lowest` → `surface_container_low` → `surface_container` → `surface_container_high` → `surface_container_highest` → `surface_bright`

- 侧栏取最暗一档，主面板从第二档起算，因此侧栏比主面板更暗。
- 菜单、卡片、输入区、代码块等其余表面按原有相对层级整体上移一档，各层之间的相对明暗顺序不变。
- Material 相邻档的色差本身较小，输入区、卡片与主面板之间只有微弱的层次区分；需要更强的分区感时应单独调整对应 token，而不是继续依赖相邻档。
- `overlay` 原本就位于阶梯顶端，没有更高的档位可移，因此在最亮一档上用 `color-mix(in srgb, …, white 8%)` 提亮，保持它高于其余浮层。
- 遮罩类 token 用 `color-mix(…, transparent 50%)` 保留透明度，避免不透明的纯 `scrim` 盖住下层界面。

## 颜色来源与合成顺序

1. **颜色文件** `colors.json`：matugen 的 Material You 颜色表，由插件内置映射转换为全部界面 token（148 项）。matugen 只给出一套暗色方案，因此浅色与深色两种模式得到同一张表。
2. **令牌文件** `dsh-tokens.json`（可选）：叠加层。文件里列出的 token 按模式覆盖上一步的结果，未列出的保持映射值。因此可以只写关心的少数几项。
3. 两者都不存在：不叠加配色。

token 名必须以 `--dsw-` 开头；两边都没给的 token 保持 DSH 内置值。

## matugen 模板接入（可选）

默认的 `colors.json` 只含一套暗色方案。若要让浅色与深色各自成表，或自行控制 DSH 全部 token 的取值，可在 `~/.config/matugen/config.toml` 增加一个模板：

```toml
[templates.dsh]
input_path = '~/.config/matugen/templates/dsh-tokens.json'
output_path = '~/.local/state/quickshell/user/generated/dsh-tokens.json'
```

模板文件写成一个合法 JSON 对象，`light` 与 `dark` 各一张表；matugen 把 `{{colors.<角色>.<light|dark>.hex}}` 替换为对应方案的颜色值：

```json
{
  "light": {
    "--dsw-alias-bg-base": "{{colors.surface.light.hex}}",
    "--dsw-alias-bg-layer-1": "{{colors.surface_container_low.light.hex}}",
    "--dsw-alias-bg-layer-2": "{{colors.surface_container.light.hex}}",
    "--dsw-alias-bg-layer-3": "{{colors.surface_container_high.light.hex}}",
    "--dsw-alias-bg-layer-4": "{{colors.surface_container_highest.light.hex}}",
    "--dsw-alias-bg-overlay": "color-mix(in srgb, {{colors.surface_bright.light.hex}}, white 8%)",
    "--dsw-alias-bg-mask-1": "color-mix(in srgb, {{colors.scrim.light.hex}}, transparent 50%)",
    "--dsw-alias-border-l1": "{{colors.outline_variant.light.hex}}",
    "--dsw-alias-border-l2": "{{colors.outline.light.hex}}",
    "--dsw-alias-brand-primary": "{{colors.primary.light.hex}}",
    "--dsw-alias-label-primary": "{{colors.on_surface.light.hex}}",
    "--dsw-alias-label-secondary": "{{colors.on_surface_variant.light.hex}}",
    "--dsw-alias-state-error-primary": "{{colors.error.light.hex}}",
    "--dsw-alias-state-success-primary": "{{colors.tertiary.light.hex}}",
    "--dsw-alias-state-warn-primary": "{{colors.secondary.light.hex}}",
    "--dsw-specific-sidebar-fill": "{{colors.surface_container_lowest.light.hex}}"
  },
  "dark": {
    "--dsw-alias-bg-base": "{{colors.surface.dark.hex}}",
    "--dsw-alias-bg-layer-1": "{{colors.surface_container_low.dark.hex}}",
    "--dsw-alias-bg-layer-2": "{{colors.surface_container.dark.hex}}",
    "--dsw-alias-bg-layer-3": "{{colors.surface_container_high.dark.hex}}",
    "--dsw-alias-bg-layer-4": "{{colors.surface_container_highest.dark.hex}}",
    "--dsw-alias-bg-overlay": "color-mix(in srgb, {{colors.surface_bright.dark.hex}}, white 8%)",
    "--dsw-alias-bg-mask-1": "color-mix(in srgb, {{colors.scrim.dark.hex}}, transparent 50%)",
    "--dsw-alias-border-l1": "{{colors.outline_variant.dark.hex}}",
    "--dsw-alias-border-l2": "{{colors.outline.dark.hex}}",
    "--dsw-alias-brand-primary": "{{colors.primary.dark.hex}}",
    "--dsw-alias-label-primary": "{{colors.on_surface.dark.hex}}",
    "--dsw-alias-label-secondary": "{{colors.on_surface_variant.dark.hex}}",
    "--dsw-alias-state-error-primary": "{{colors.error.dark.hex}}",
    "--dsw-alias-state-success-primary": "{{colors.tertiary.dark.hex}}",
    "--dsw-alias-state-warn-primary": "{{colors.secondary.dark.hex}}",
    "--dsw-specific-sidebar-fill": "{{colors.surface_container_lowest.dark.hex}}"
  }
}
```

token 的值按原样写入 CSS 变量，因此 `color-mix(...)` 这类表达式可以直接写在模板里。改完模板后重新运行 matugen，插件在下一个轮询周期读到文件变化后生效。

## M3 动效

「设置 → 通用设置 → M3 动效」把界面的动画曲线换成 Material 3 / Material 3 Expressive 的曲线族。

### 曲线族

| 用途 | M3 | M3E |
| --- | --- | --- |
| 位移（transform、宽高、内外距、gap、圆角…） | `cubic-bezier(0.05, 0.7, 0.1, 1)`（emphasized decelerate） | 声明时长 ≤200ms 用 `cubic-bezier(0.42, 1.67, 0.21, 0.9)`，否则用 `cubic-bezier(0.38, 1.21, 0.22, 1)` |
| 效果（颜色、透明度、阴影、滤镜…） | `cubic-bezier(0.2, 0, 0, 1)`（standard） | `cubic-bezier(0.34, 0.8, 0.34, 1)` |

两族都把「移动」和「效果」分开，原因在 M3E 上最直观：它的两条位移曲线带过冲，峰值分别为 1.092 与 1.014，效果曲线不过冲。物体移动有惯性，颜色过冲则会闪出调色板里不存在的颜色。

M3 那侧的分离要说明白：Material 3 的 `emphasized` 整体是两段首尾相接的三次贝塞尔（`pathInterpolator(M 0,0 C 0.05,0,0.133333,0.06,0.166666,0.4 C 0.208333,0.82,0.25,1,1,1)`），`cubic-bezier()` 只能表达一段，所以 Material 官方的 Web token 表把 `emphasized` 标为不可用、回退到 `standard`。这里改用官方单列出来的 `emphasized-decelerate`（`cubic-bezier(0.05, 0.7, 0.1, 1)`）承担位移，效果侧用 `standard`——两个都是 Material 自己发布的 token，不是拼出来的近似。

本层无法区分入场与出场，因此位移一律用 decelerate；Material 对出场建议用对应的 accelerate。

关闭「位移与效果使用不同曲线」后，两族都退化为只用效果曲线。

### 为什么是改写 CSSOM，而不是注入覆盖样式表

注入一张「覆盖表」有两种写法，都不成立：

- **按类名覆盖**：需要为每个组件抄一遍选择器并保证优先级不低于原规则。这份抄件正是 DSH 改版时会失效的东西——和「把编译产物里的 hash 类名写死」是同一类错。
- **`!important` 全覆盖**：会连带压掉刻意保留的例外，例如终端光标的 `step-end`、点阵揭示的 `steps()`。

这里改为遍历 `document.styleSheets` 与 `document.adoptedStyleSheets`，递归进入 `@media` / `@supports` / `@layer` / 嵌套规则，对每条真正声明了 `transition` / `animation` 的规则，**原地改写它自己的长写属性**：

- 优先级不变：改的是同一条规则，所以只在原规则生效的地方生效。
- 例外自动保留：`steps()`、`step-end` 这类离散步进不动；无限循环上的 `linear` 不动（旋转指示器被任何缓动曲线处理都会显出一顿一顿）；`0s` 的可见性门控不动。
- 无需随 DSH 更新维护：新增或改名的组件自动被覆盖。
- 精确还原：写入前整块记录 `cssText`，关闭时原样写回；若期间被第三方改过则在日志中说明后仍然还原。

### 关键帧感知

动画该用哪条曲线，取决于它的 `@keyframes` 到底在动什么。扫描时先建立「关键帧名 → 它改动的属性集合」，再据此判定：同时含 `transform` 的是位移，纯 `opacity` 的是效果。查不到名字（定义在跨源样式表里）时按效果处理。

无限循环的动画一律按效果处理：旋转、呼吸、骨架屏都是环境性的，不是一次性位移；给它套带过冲的位移曲线会让循环进度条每一轮都冲出轨道。

### 时长

- 「时长倍率」在界面上提供 0.5× / 0.75× / 1× / 1.25× / 1.5× / 2×。配置里手工写入的其它值（schema 允许 0.5–2）会插入档位表并选中，不会被悄悄折回 1×。
- 倍率作用于**写死的字面时长**；引用 `var(--ds-transition-duration*)` 的时长不动它本身，改为把这三个自定义属性按同一倍率缩放，效果一致且不用逐条改。缩放前会读取页面当前的计算值，DSH 改了基值也按新基值算。
- `1ms` 及以下的时长视为「立即」，既不放缩也不吸附——DSH 的减弱动效规则里写的就是 `.01ms`，把它当成待调的时长去放大，本来即时完成的过渡会变成可见的一跳。
- 无限循环的时长不缩放——1 秒的旋转是设计选定的速度，不是待调的过渡。
- 「时长对齐到 Material 档位」把结果吸附到 50/100/150/200/250/300/350/400/450/500/550/600/700/800/900/1000ms。

### 减弱动效

- `跟随系统`（默认）：系统开启「减弱动态效果」时，全部时长压到 1ms、动画只跑一轮。
- `始终减弱动效`：无论系统设置，一律压制。

这一条是整层里唯一使用 `!important` 的地方——它要压掉本层从未写过的声明，逐条改写做不到。进入压制时会先撤掉已改写的曲线并停掉观察者：时长已被压到 1ms，改写既看不见，还会在压制表插入时被自己的观察者重新触发一次扫描。

### 生效范围

- 覆盖页面上的全部样式表，包括其他插件注入的。首次应用时全量扫描，之后用 `MutationObserver` 监视 `head` 与 `body`；只有当新增节点本身是 `<style>` / `<link>`，或子树里含有时才补扫——聊天流式输出每帧都在改 DOM，无条件补扫会把一次性开销变成每帧开销。
- 通过 `document.adoptedStyleSheets` 挂载的构造式样式表不是 DOM 变更，观察者看不到它，只能在下一次全量扫描（切换曲线族、解除减弱动效、重新应用设置）时被读到。
- 跨源样式表读不到 `cssRules`，会在浏览器控制台记录一行并跳过——这类表的规则无法改写，静默跳过会让部分界面停留在原生曲线而无迹可循。（这条诊断走控制台而非 `~/.dsh/ui-experience.log`：后者由宿主半写入，浏览器半够不到文件系统。）
- 状态会写在 `<html data-dsh-uix-motion="m3|m3e">` 上，便于区分曲线来源。

## 边框宽度

- 插件配置 `borderWidth` 默认为 `0.5px`，只在「Matugen 配色跟随」开启时生效；关闭开关后边框立即恢复原生宽度。
- 实现方式是全局覆盖所有元素的边框宽度，因此会同时压窄正文引用块等刻意加粗的装饰性边框。
- 给元素加 `data-dsh-uix-keep-border` 属性可让该元素不被覆盖。

## 限制

- 走 `colors.json` 路径时 matugen 只提供一套暗色方案，浅色与深色模式叠加同一张配色表，界面的明暗切换只影响未被覆盖的元素；需要两套配色时改用 `dsh-tokens.json`。
- 配色检测周期为 2 秒，文件变化最多延迟约 2 秒生效。
- 关闭开关后启动底色叠加立即撤销（由作用域属性控制）；注入的样式与脚本元素保留到下次刷新，但不产生视觉效果。
- M3 动效的「位移 / 效果」判定依据属性名与关键帧内容，不分析属性的实际取值变化；判定不出来的情况（例如只由 `all` 声明的过渡）按效果处理，宁可不给过冲。
- 跨源样式表里的规则无法改写，只会在日志中记录。
- 本层只改写曲线与时长，不新增、不改写关键帧本身；DSH 没定义的动效不会因此出现。
- 浏览器半在刷新页面时重载，宿主半只在进程重启时重载。两者版本不一致时（刚升级插件但没重启 DSH），M3 动效行会保持无操作并在控制台记录一行原因，配色功能不受影响。

## 样式基线

设置行的控件样式来自宿主既有实现，而不是外部包依赖。原因有两条，都不是偏好问题：

1. **DSH 明确禁止**：「不要 `require('@deepseek-ai/dsh-client-ui-primitives')` 或把任何 Harness Client 包当模块加载……这些包会无通知地变更，且抛错的组件会让整个 slot entry 变空白。请自行实现控件：从原语的 `src/*.tsx` 与 `*.module.css` 复制标记、样式与行为。」（`dsh-doc` 技能 `references/practices.md`）
2. **技术上也不成立**：这些包不在 `dsh` 的 `node_modules` 里，官方包自己也只把原语写在 `devDependencies`。第三方插件能 `require` 到它，全靠 Web 外壳硬编码的模块表。一旦上游改名、拆包或移除条目，`require` 直接抛错——因为异常发生在 slot 组件内部，整行设置会消失，而不是样式退化。

两种失效的性质不同：**复制样式**最坏是某次改版后尺寸或配色略有偏差，功能完好；**依赖内部包**则是整行消失。所以这里选择复制，并把漂移控制在可核查的范围内。

当前基线为 **DSH 0.2.2-rc.2**，全部规则集中在 [`src/styles.ts`](src/styles.ts)，每条规则上方标注了对应的宿主源文件与选择器：

| 本插件类 | 对应宿主来源 |
| --- | --- |
| `.dsh-uix-row` | `AppearanceRow.module.css` `.group` |
| `.dsh-uix-title` / `.dsh-uix-desc` | `FontSizeRow.module.css` `.title` / `.desc` |
| `.dsh-uix-field` / `-label` | `ConfigField.module.css` `.field` / `.head label` |
| `.dsh-uix-input-wrap` / `-input` | `Input.module.css` `.wrap` / `.input`（同页字体字段用的就是这个原语） |
| `.dsh-uix-disclosure` / `-icon` | `FontSizeRow.module.css` `.expander`，箭头复用其 chevron 路径 |
| `.dsh-uix-save` | 配置表单的保存按钮 |
| `.dsh-uix-reset` | `Button.module.css` `.outline` |
| `.dsh-uix-switch` / `-thumb` | `Switch.module.css` `.switch` / `.thumb` |
| `.dsh-uix-segment` / `-indicator` / `-tab` | `SegmentedControl.module.css` `.control` / `.indicator` / `.tab` |
| `.dsh-uix-check` / `-label` / `-hint` | `Checkbox.module.css` `.checkbox` 及其原生输入 |

所有颜色、圆角、焦点环都用 `--dsw-*` 主题 token，这些是跨版本稳定的公开契约；只有长度值（内距、尺寸、字号）可能随改版调整。升级 DSH 后，把上表的源文件与 `src/styles.ts` 对照一遍即可。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
```

源码在 `src/`（`index.ts` 为宿主半，`client.ts` 为浏览器半，`shared.ts` 为两端共享的协议类型），esbuild 产物输出到 `lib/`。`lib/` 会提交入库，以便其他设备直接从 git 安装而无需构建环境；改动源码后务必重新构建并一并提交产物。

## 安装

其他设备通过「插件管理器 → 添加插件 → 安装第三方插件」安装，粘贴 Git 仓库地址：

```
git+https://github.com/dsh-plugins/dsh-ui-experience.git
```

注意：

- 地址必须以 `git+` 开头；裸 `https://` 不会被识别为 Git 仓库。
- 目标设备需要能访问该仓库。
- 构建产物 `lib/` 已入库，无需在目标设备上构建；安装后按提示重启 DSH。
- 不要手动编辑 profile 的 `package.json`：包名以仓库 `package.json` 的 `name` 为准（`@dsh-plugin/dsh-ui-experience`），别名与仓库名不一致时需显式声明。
