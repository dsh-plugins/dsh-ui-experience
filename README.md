# dsh-ui-experience

DeepSeek Harness 的界面体验插件（`@dsh-plugin/dsh-ui-experience`）。

它做三件事：跟随系统 matugen 生成的 Material You 配色、把界面的过渡与动画改写为 Material 3 曲线、统一界面边框宽度。前两项在「设置 → 通用设置」里各自开关和调整，边框宽度跟随配色开关。

## 功能

| 功能 | 说明 |
| --- | --- |
| Matugen 配色跟随 | 读取 matugen 输出的 Material You 配色，作为叠加层套在 DSH 当前主题上；matugen 重新生成颜色后约 2 秒内自动跟随 |
| 配色文件路径 | 两个配色文件的位置可在设置行里修改并持久化 |
| M3 动效 | 把页面上已生效的 `transition` / `animation` 曲线换成 Material 3 或 Material 3 Expressive 曲线族 |
| 滚动曲线 | 脚本滚动、滚轮滚动与跟随滑行改用本页曲线，并让 `scrollend` 呈现「一次手势一次结束」 |
| 流式文本渐显 | 生成中的正文与思考摘要按遮罩线推进显现，不截断文字 |
| 边框宽度 | 全局覆盖界面边框宽度，默认 `0.5px`，仅在配色跟随开启时生效 |

配色文件只在本地读取，不上传。

## 安装

通过「插件管理器 → 添加插件 → 安装第三方插件」安装，粘贴 Git 仓库地址：

```
git+https://github.com/dsh-plugins/dsh-ui-experience.git
```

地址必须以 `git+` 开头，裸 `https://` 不会被识别为 Git 仓库。构建产物 `lib/` 已入库，目标设备无需构建环境，安装后按提示重启 DSH。

## 配置

安装并启用后刷新页面，在「设置 → 通用设置」里找到两行设置：

- **Matugen 配色跟随**：开关控制启用/停用；展开可编辑两个配色文件路径。开关状态与路径都保存在 profile 里，重启后恢复。
- **M3 动效**：选择曲线族（`关闭` / `M3` / `M3E`），调整时长倍率、时长对齐、位移与效果是否分开、减弱动效策略，以及滚动与流式文本的开关。

配色文件只在「Matugen 配色跟随」开启时读取；边框宽度同理。

### 配色文件

| 文件 | 默认路径 | 用途 |
| --- | --- | --- |
| 颜色文件 | `~/.local/state/quickshell/user/generated/colors.json` | matugen 原始输出，插件用内置映射转换成全部 148 个界面 token |
| 令牌文件 | `~/.local/state/quickshell/user/generated/dsh-tokens.json` | 由 matugen 模板产出的 `{ light, dark }` 两张 token 表，逐 token 叠加在映射之上 |

两者是叠加关系：令牌文件里给出的 token 覆盖映射值，未给出的保留映射值。有颜色文件作底时，只写关心的少数几项也能生效。

路径必须是绝对路径或以 `~/` 开头。两个文件都不存在时插件不上色，界面保持原生配色。检测周期 2 秒。

## 配色

内置映射把 Material You 的六档表面按明度排成阶梯：

`surface_container_lowest` → `surface_container_low` → `surface_container` → `surface_container_high` → `surface_container_highest` → `surface_bright`

侧栏取最暗一档，主面板从第二档起算，其余表面（菜单、卡片、输入区、代码块）按原有相对层级整体上移一档。相邻档的色差本身较小，需要更强的分区感时应单独调整对应 token。`overlay` 已在阶梯顶端，用加白提亮保持它高于其余浮层；遮罩类 token 保留半透明，避免不透明的纯 `scrim` 盖住下层界面。

### matugen 模板接入

`colors.json` 只含一套暗色方案，浅色与深色会得到同一张表。要让两种模式各自配色，用仓库里的 [`templates/dsh-tokens.json`](templates/dsh-tokens.json) 作为 matugen 模板：它覆盖全部 148 个 token 的两套模式，取值是 `{{colors.<角色>.<light|dark>.hex}}` 占位符。

把它复制到 matugen 的模板目录，并在 `~/.config/matugen/config.toml` 里加一段：

```toml
[templates.dsh]
input_path = '~/.config/matugen/templates/dsh-tokens.json'
output_path = '~/.local/state/quickshell/user/generated/dsh-tokens.json'
```

重新运行 matugen，插件在下一个轮询周期读到新文件后生效。token 值按原样写入 CSS 变量，因此 `color-mix(...)` 这类表达式可以直接写在模板里。

**没有颜色文件时，令牌文件需要是完整的。** 此时没有映射可作底，未列出的 token 只能保持 DSH 内置值，界面会一半是插件配色、一半是原生配色。用上述模板生成即可保证完整；仓库的 `pnpm build` 会从同一份映射重新生成该模板，两者不会漂移。

## 动效

### 曲线族

| 用途 | M3 | M3E |
| --- | --- | --- |
| 位移（transform、宽高、内外距、gap、圆角…） | `cubic-bezier(0.05, 0.7, 0.1, 1)`（emphasized decelerate） | 声明时长 ≤200ms 用 `cubic-bezier(0.42, 1.67, 0.21, 0.9)`，否则用 `cubic-bezier(0.38, 1.21, 0.22, 1)` |
| 效果（颜色、透明度、阴影、滤镜…） | `cubic-bezier(0.2, 0, 0, 1)`（standard） | `cubic-bezier(0.34, 0.8, 0.34, 1)` |

两族都把移动与效果分开：位移曲线可以带过冲，效果曲线不过冲——颜色过冲会闪出调色板里不存在的颜色。M3 用官方单列的 `emphasized-decelerate` 承担位移，效果侧用 `standard`。

本层无法区分入场与出场，位移一律用 decelerate。关闭「位移与效果使用不同曲线」后两族都只用效果曲线。

### 实现方式

遍历 `document.styleSheets` 与 `document.adoptedStyleSheets`，递归进入 `@media` / `@supports` / `@layer` / 嵌套规则，对声明了 `transition` / `animation` 的规则原地改写其长写属性。这样优先级不变、新增或改名的组件自动被覆盖，关闭时按记录的 `cssText` 原样写回。

`steps()`、`step-end` 这类离散步进不动；无限循环上的 `linear` 与无限循环的时长不动；`1ms` 及以下的时长视为立即。滚动驱动的动画（`animation-timeline` 不是 `auto` / `none`）整条跳过——它的进度来自滚动位置而不是时钟。

首次应用时全量扫描，之后用 `MutationObserver` 观察样式注入。跨源样式表读不到 `cssRules`，会在浏览器控制台记录一行并跳过。

### 时长与减弱动效

- 时长倍率提供 0.5× / 0.75× / 1× / 1.25× / 1.5× / 2×，作用于写死的字面时长；引用 `var(--ds-transition-duration*)` 的时长改为按同一倍率缩放这三个自定义属性。
- 开启「时长对齐到 Material 档位」后结果吸附到 50…1000ms 的档位。
- 减弱动效可设为跟随系统（默认）或始终压制；压制时全部时长压到 1ms、动画只跑一轮。

### 滚动

勾选「滚动使用同一曲线」（默认开启）后，脚本平滑滚动（`scrollTo` / `scrollBy` / `scrollIntoView` 的 `behavior:'smooth'`）、符合跟随特征的 `scrollTop` 赋值与滚轮增量都改走本页曲线，同时遮蔽 `scrollend` 让消费者看到一次结束。

`behavior:'instant'` 的请求永远即时——它的调用方会在下一行立刻回读位置来判断视口在哪，延后写入会让跟随控制器误判。动画期间容器高度变化时保留终点、以布局给出的新位置为起点重新计时，不会取消动画或沿原路退回。

### 流式文本

曲线族选成 `M3` / `M3E` 后，「流式文本渐进显现」（默认开启）会让生成中的正文与思考摘要按遮罩线推进显现。文字一个字都不截断，只移动 `mask-image`，选择、复制与读屏都按完整文本工作。

## 边框宽度

插件配置 `borderWidth` 默认 `0.5px`，只在「Matugen 配色跟随」开启时生效，关闭开关后立即恢复原生宽度。它全局覆盖所有元素的边框，因此会同时压窄正文引用块等刻意加粗的装饰性边框；给元素加 `data-dsh-uix-keep-border` 属性可豁免。

## 已知限制

- 只用 `colors.json` 时两种模式叠加同一张暗色表，明暗切换只影响未被覆盖的元素；需要两套配色请改用 `dsh-tokens.json`。
- 配色检测周期 2 秒，文件变化最多延迟约 2 秒生效。
- 关闭配色开关后叠加层立即撤销，但注入的样式与脚本元素保留到下次刷新。
- 跨源样式表里的规则无法改写，只在控制台记录。
- 本层只改写曲线与时长，不新增、不改写关键帧本身；DSH 没定义的动效不会因此出现。
- 位移/效果的判定依据属性名与关键帧内容，不分析取值变化；判定不出来的（例如只由 `all` 声明的过渡）按效果处理。
- 流式渐显按遮罩线推进，粒度为行内字符：斜线跨过的那几行同时处于部分显现中，行内从左向右推进，换行时整行会有短暂推迟，而不是严格的逐行打字。
- 跟随写入默认缓动滑行（「跟随到底时平滑滑行」默认开启），视口因此短暂落后半行到一行，落后超过 40px 直接贴底；关掉该开关后每次跟随瞬时贴齐。
- 新行进场只在应用自己声明正贴底时触发；读者上翻时新到达的内容直接出现。
- 遮蔽期内的合成 `scrollend` 其 `isTrusted` 为 `false`。
- 浏览器半在刷新页面时重载，宿主半只在进程重启时重载。刚升级插件但没重启 DSH 时：宿主完全不认识动效配置的话，动效行保持无操作；宿主认识但缺流式字段的话，只有流式开关隐藏、渐显照常。两种情况都会在控制台记录原因，重启后恢复。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

源码在 `src/`：

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 宿主半：配色文件解析、Remote 服务、配置文件注入 |
| `client.ts` | 浏览器半：设置行与页面级图层接线 |
| `palette.ts` | 配色映射规则，以及随之生成的 matugen 模板 |
| `motion.ts` | CSSOM 遍历与曲线改写 |
| `motion-plan.ts` | 纯函数：值列表切分、时长解析与重定时、属性分类、曲线选择与求值 |
| `scroll.ts` | 脚本平滑滚动、滚轮缓动、跟随滑行与 `scrollend` 遮蔽 |
| `stream.ts` | 流式文本渐进显现 |
| `styles.ts` | 设置行样式表 |
| `shared.ts` | 两端共享的协议类型 |

esbuild 产物输出到 `lib/`，`pnpm build` 同时从 `src/palette.ts` 重新生成 `templates/dsh-tokens.json`。`lib/` 会提交入库，以便其他设备直接从 git 安装而无需构建环境；改动源码后务必重新构建并一并提交产物。

`pnpm test` 覆盖 `motion-plan.ts` 的纯规则与生成模板的格式规则。模板的完整性由生成脚本自己保证——缺 token 就不写文件。CSSOM 改写与脚本滚动属于 DOM 编排，不在单元测试范围内，用真实浏览器验证。

设置行的控件样式复制自宿主原语，而不是依赖 `@deepseek-ai/dsh-client-ui-primitives`——DSH 明确禁止插件加载 Harness Client 包，且这些包一旦改名或拆包，异常会发生在 slot 组件内部导致整行设置消失。基线为 DSH 0.2.2-rc.2，全部规则集中在 [`src/styles.ts`](src/styles.ts)，每条规则上方标注了对应的宿主源文件与选择器；颜色、圆角、焦点环都用 `--dsw-*` 主题 token。
