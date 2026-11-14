/**
 * The matugen palette mapping, in one place.
 *
 * One Material You scheme becomes the whole DSW token table, and the same recipe
 * list also renders the matugen template a user needs to produce that table
 * themselves with per-mode values. Both artifacts come from this list, so a token
 * can never exist in the mapping and be missing from the template — a template
 * short of tokens is what leaves an interface half themed, with the tokens it
 * omits still on the shipped palette.
 */

import type { ThemeTokenModes, ThemeTokenTable } from './shared.ts'

/** One matugen colors table, keyed by Material color role. */
export type MatugenColors = Record<string, string>

/** Material You color roles the mapping consumes; a colors file must hold all of them. */
export const MATUGEN_ROLES = [
  'surface_container_lowest', 'surface_container_low', 'surface_container',
  'surface_container_high', 'surface_container_highest', 'surface_bright',
  'on_surface', 'on_surface_variant', 'outline', 'outline_variant',
  'primary', 'primary_container', 'on_primary',
  'secondary', 'secondary_container',
  'tertiary', 'tertiary_container',
  'error', 'error_container',
  'inverse_surface', 'inverse_on_surface',
  'scrim', 'shadow',
] as const

/** A Material color role. */
export type MatugenRole = (typeof MATUGEN_ROLES)[number]

// Material 的 surface 阶梯，由暗到亮。侧栏取最暗一级，主面板从第二级起，
// 其余表面按原有相对层级整体上移一级：主面板比原先更亮、侧栏更暗，各层
// 表面的相对明暗顺序不变。overlay 原本就居顶，阶梯没有更高的档位可用，
// 因此在最亮一级上加白提亮，保持它高于其余浮层。
const SURFACE_ROLES = [
  'surface_container_lowest', 'surface_container_low', 'surface_container',
  'surface_container_high', 'surface_container_highest', 'surface_bright',
] as const satisfies readonly MatugenRole[]

/** Which surface level a token takes its value from, darkest first. */
type SurfaceSlot = 0 | 1 | 2 | 3 | 4 | 5

/** One token's source: a role, or a surface level standing in for one. */
type RecipeBase = { readonly role: MatugenRole } | { readonly surface: SurfaceSlot }

/** A token that is a translucent or whitened variant of its source. */
interface Mix {
  readonly with: 'white' | 'transparent'
  readonly percent: number
}

/** How one DSW token is derived from the Material scheme. */
type Recipe = RecipeBase & { readonly mix?: Mix }

/** Every token this plugin themes, in mapping order. */
const RECIPES: readonly (readonly [string, Recipe])[] = [
  // ── surfaces ──────────────────────────────────────────────
  ['--dsw-alias-bg-base', { surface: 1 }],
  ['--dsw-alias-bg-layer-1', { surface: 2 }],
  ['--dsw-alias-bg-layer-2', { surface: 3 }],
  ['--dsw-alias-bg-layer-3', { surface: 4 }],
  ['--dsw-alias-bg-layer-4', { surface: 5 }],
  ['--dsw-alias-bg-overlay', { surface: 5, mix: { with: 'white', percent: 8 } }],
  // 内置主题的遮罩是半透明黑，直接取 scrim 会得到不透明纯黑，盖住下层界面。
  ['--dsw-alias-bg-mask-1', { role: 'scrim', mix: { with: 'transparent', percent: 50 } }],
  ['--dsw-alias-bg-module-platform', { surface: 4 }],
  ['--dsw-alias-bg-skeleton', { surface: 4 }],
  // ── borders — uniform outline_variant to avoid visual fragmentation ──
  ['--dsw-alias-border-l1', { role: 'outline_variant' }],
  ['--dsw-alias-border-l2', { role: 'outline_variant' }],
  ['--dsw-alias-border-l2-darkmode-thin', { role: 'outline_variant' }],
  ['--dsw-alias-border-l3', { role: 'outline_variant' }],
  ['--dsw-alias-border-l4', { role: 'outline_variant' }],
  // ── brand & labels ────────────────────────────────────────
  ['--dsw-alias-brand-primary', { role: 'primary' }],
  ['--dsw-alias-brand-primary-new-colorprimary-new-color', { role: 'primary' }],
  ['--dsw-alias-label-primary', { role: 'on_surface' }],
  ['--dsw-alias-label-secondary', { role: 'on_surface_variant' }],
  ['--dsw-alias-label-tertiary', { role: 'on_surface_variant' }],
  ['--dsw-alias-label-caption', { role: 'on_surface_variant' }],
  ['--dsw-alias-label-dimmed', { role: 'outline' }],
  ['--dsw-alias-label-error', { role: 'error' }],
  ['--dsw-alias-label-primary-foreground', { role: 'on_primary' }],
  ['--dsw-alias-label-shimmer', { role: 'on_surface_variant' }],
  ['--dsw-alias-link', { role: 'primary' }],
  // ── interactive ───────────────────────────────────────────
  ['--dsw-alias-interactive-bg-hover', { surface: 4 }],
  ['--dsw-alias-interactive-bg-active', { surface: 5 }],
  ['--dsw-alias-interactive-bg-hover-danger', { role: 'error_container' }],
  // ── buttons ───────────────────────────────────────────────
  ['--dsw-alias-button-primary-fill', { role: 'primary' }],
  ['--dsw-alias-button-primary-hover', { role: 'primary' }],
  ['--dsw-alias-button-info-fill', { role: 'primary' }],
  ['--dsw-alias-button-ghost-active-fill', { surface: 4 }],
  ['--dsw-alias-button-ghost-active-border', { role: 'outline' }],
  ['--dsw-alias-button-tool-bar-fill', { surface: 4 }],
  ['--dsw-alias-button-tool-bar-hover', { surface: 5 }],
  ['--dsw-alias-label-on-color', { role: 'on_primary' }],
  // ── states ────────────────────────────────────────────────
  ['--dsw-alias-state-error-primary', { role: 'error' }],
  ['--dsw-alias-state-idle-primary', { role: 'outline' }],
  ['--dsw-alias-state-success-primary', { role: 'tertiary' }],
  ['--dsw-alias-state-success-tertiary', { role: 'tertiary_container' }],
  ['--dsw-alias-state-warn-primary', { role: 'secondary' }],
  ['--dsw-alias-state-warn-label', { role: 'secondary' }],
  ['--dsw-alias-state-warn-tertiary', { role: 'secondary_container' }],
  ['--dsw-alias-state-business-primary', { role: 'primary' }],
  // ── switch ────────────────────────────────────────────────
  // switch-thumb 是关闭态滑块色，语义为中性前景，内置主题暗色取
  // neutral-bluish-400（纯灰）、浅色取近白。映射成 primary 会让关闭态带上
  // 强调色，映射成 on_surface_variant 又会把前景色渗进整体观感；这里不做
  // 覆盖，保持原生纯灰，开关只在开启态轨道显示强调色。
  // ── menu & overlay ────────────────────────────────────────
  ['--dsw-alias-menu-icon', { role: 'on_surface_variant' }],
  ['--dsw-alias-menu-group-header-fill', { surface: 4 }],
  ['--dsw-alias-hovercard-bg', { surface: 4 }],
  ['--dsw-alias-hovercard-label-primary', { role: 'on_surface' }],
  // 官方契约里 tooltip 与 toast 始终是深色气泡配浅色文字，key 块是气泡色
  // 混 18% 白。Material 的 inverse_* 在深色调色板下方向相反（浅底深字），
  // 会让继承 label 色的键位提示变成深底深字，故这里改用容器面与前景色。
  ['--dsw-alias-tooltip-bg', { surface: 4 }],
  ['--dsw-alias-tooltip-label', { role: 'on_surface' }],
  ['--dsw-alias-tooltip-key-bg', { surface: 4, mix: { with: 'white', percent: 18 } }],
  ['--dsw-alias-toast-bg', { surface: 4 }],
  ['--dsw-alias-toast-label', { role: 'on_surface' }],
  ['--dsw-alias-toast-action', { role: 'primary' }],
  // ── scrollbar ─────────────────────────────────────────────
  ['--dsw-alias-scrollbar-bg-l2', { surface: 2 }],
  ['--dsw-alias-scrollbar-hover-l2', { surface: 4 }],
  // ── markdown & code ───────────────────────────────────────
  ['--dsw-alias-markdown-code-block', { surface: 2 }],
  ['--dsw-alias-markdown-code-block-banner', { surface: 3 }],
  ['--dsw-alias-markdown-inline-code', { surface: 4 }],
  ['--dsw-alias-markdown-tag', { surface: 4 }],
  // ── JSON tree ─────────────────────────────────────────────
  ['--dsw-alias-json-tree-hover', { surface: 4 }],
  ['--dsw-alias-json-tree-icon', { role: 'on_surface_variant' }],
  ['--dsw-alias-json-tree-keyword', { role: 'primary' }],
  ['--dsw-alias-json-tree-number', { role: 'tertiary' }],
  ['--dsw-alias-json-tree-property', { role: 'on_surface' }],
  ['--dsw-alias-json-tree-punctuation', { role: 'on_surface_variant' }],
  ['--dsw-alias-json-tree-string', { role: 'secondary' }],
  // ── diff ──────────────────────────────────────────────────
  ['--dsw-alias-code-diff-added', { surface: 4 }],
  ['--dsw-alias-code-diff-deleted', { surface: 4 }],
  ['--dsw-alias-file-diff-added-bg', { surface: 2 }],
  ['--dsw-alias-file-diff-added-marker', { role: 'tertiary' }],
  ['--dsw-alias-file-diff-deleted-bg', { surface: 2 }],
  ['--dsw-alias-file-diff-deleted-marker', { role: 'error' }],
  // ── app-specific ──────────────────────────────────────────
  ['--dsw-specific-sidebar-fill', { surface: 0 }],
  ['--dsw-specific-input-major', { surface: 2 }],
  ['--dsw-specific-bubble', { surface: 2 }],
  ['--dsw-specific-menu', { surface: 3 }],
  ['--dsw-menu-surface-fill', { surface: 3 }],
  ['--dsw-focus-ring-color', { role: 'primary' }],
  // ── plugin-side surfaces & fills ──────────────────────────
  ['--dsw-alias-bg-document-preview', { surface: 2 }],
  ['--dsw-alias-bg-l1', { surface: 2 }],
  ['--dsw-alias-bg-mask-drop', { role: 'scrim', mix: { with: 'transparent', percent: 30 } }],
  ['--dsw-alias-card-fill', { surface: 2 }],
  ['--dsw-alias-card-fill-hover', { surface: 3 }],
  ['--dsw-alias-card-tile-fill', { surface: 2 }],
  ['--dsw-alias-fill-l1', { surface: 2 }],
  ['--dsw-alias-fill-l2', { surface: 4 }],
  ['--dsw-alias-fill-tsp-secondary', { surface: 3 }],
  ['--dsw-alias-settings-card-fill', { surface: 2 }],
  ['--dsw-alias-settings-card-stroke', { role: 'outline_variant' }],
  ['--dsw-alias-illustration-background', { surface: 1 }],
  ['--dsw-alias-illustration-backing', { surface: 2 }],
  ['--dsw-alias-illustration-detail', { surface: 3 }],
  ['--dsw-alias-illustration-inset', { surface: 0 }],
  ['--dsw-alias-illustration-shadow', { role: 'shadow' }],
  ['--dsw-alias-illustration-surface', { surface: 4 }],
  // ── plugin-side borders & separators ──────────────────────
  ['--dsw-alias-border-inverted', { role: 'inverse_surface' }],
  ['--dsw-alias-border-selected', { role: 'primary' }],
  ['--dsw-alias-separator-primary', { role: 'outline_variant' }],
  // ── plugin-side buttons ───────────────────────────────────
  ['--dsw-alias-button-contrast-fill', { role: 'inverse_surface' }],
  ['--dsw-alias-button-elevated-fill', { surface: 4 }],
  ['--dsw-alias-button-floating-fill', { surface: 4 }],
  ['--dsw-alias-button-floating-hover', { surface: 5 }],
  ['--dsw-alias-button-info-hover', { role: 'primary_container' }],
  // ── plugin-side labels ────────────────────────────────────
  ['--dsw-alias-label-deep-diving', { role: 'primary' }],
  ['--dsw-alias-label-deep-diving-shimmer', { role: 'secondary' }],
  ['--dsw-alias-label-primary-bluish', { role: 'on_surface' }],
  ['--dsw-alias-label-primary-dimmed', { role: 'on_surface_variant' }],
  ['--dsw-alias-label-primary-inverted', { role: 'inverse_on_surface' }],
  ['--dsw-alias-label-quaternary', { role: 'outline' }],
  ['--dsw-alias-hovercard-label-secondary', { role: 'on_surface_variant' }],
  ['--dsw-alias-hovercard-label-tertiary', { role: 'on_surface_variant' }],
  // ── plugin-side interactive & states ──────────────────────
  ['--dsw-alias-interactive-bg-hover-accent', { role: 'primary_container' }],
  ['--dsw-alias-interactive-bg-hover-solid', { surface: 5 }],
  ['--dsw-alias-state-business-tertiary', { role: 'primary_container' }],
  ['--dsw-alias-state-error-secondary', { role: 'error_container' }],
  ['--dsw-alias-state-success-secondary', { role: 'tertiary_container' }],
  ['--dsw-alias-state-warn-secondary', { role: 'secondary_container' }],
  ['--dsw-alias-trajectory-accent', { role: 'primary' }],
  // ── charts, citations, onboarding, turn triggers ──────────
  ['--dsw-alias-chart-messages', { role: 'primary' }],
  ['--dsw-alias-chart-system', { role: 'secondary' }],
  ['--dsw-alias-chart-tools', { role: 'tertiary' }],
  ['--dsw-alias-markdown-citation', { surface: 4 }],
  ['--dsw-alias-onboarding-accent', { role: 'primary' }],
  ['--dsw-alias-onboarding-card-fill', { surface: 2 }],
  ['--dsw-alias-onboarding-checkbox-border', { role: 'outline' }],
  ['--dsw-alias-onboarding-secondary-fill', { surface: 4 }],
  ['--dsw-alias-turn-trigger-bg', { surface: 4 }],
  ['--dsw-alias-turn-trigger-bg-hover', { surface: 5 }],
  // ── plugin-side scrollbars ────────────────────────────────
  ['--dsw-alias-scrollbar-bg-l1', { surface: 0 }],
  ['--dsw-alias-scrollbar-hover-l1', { surface: 2 }],
  // ── diff gutters ──────────────────────────────────────────
  ['--dsw-alias-file-diff-added-gutter', { role: 'tertiary_container' }],
  ['--dsw-alias-file-diff-deleted-gutter', { role: 'error_container' }],
  // ── sidebar & misc specifics ──────────────────────────────
  // 侧栏玻璃按钮是侧栏内层，取比侧栏底色高一级，避免与底色重合。tint 与
  // wash 只在 macOS 上作为透明渐变叠加在侧栏之上，这里保持与底色同值。
  ['--dsw-specific-sidebar-glass-fill', { surface: 1 }],
  ['--dsw-specific-sidebar-glass-hover', { surface: 2 }],
  ['--dsw-specific-sidebar-glass-collapsed-fill', { surface: 1 }],
  ['--dsw-specific-sidebar-glass-collapsed-hover', { surface: 2 }],
  ['--dsw-specific-sidebar-nav-item-active', { surface: 4 }],
  // 该 token 也作为「推荐」徽标等元素的文字底色，文字色是 button-info-fill
  // （映射为 primary），因此这里必须用容器色保证对比。
  ['--dsw-specific-sidebar-nav-item-active-accent', { role: 'primary_container' }],
  ['--dsw-specific-sidebar-right-flash', { surface: 3 }],
  ['--dsw-specific-sidebar-tint', { surface: 0 }],
  ['--dsw-specific-sidebar-wash-bottom', { surface: 0 }],
  ['--dsw-specific-sidebar-wash-bottom-clear', { surface: 0 }],
  ['--dsw-specific-sidebar-wash-top', { surface: 0 }],
  ['--dsw-specific-sidebar-wash-top-clear', { surface: 0 }],
  ['--dsw-specific-file-upload-track', { surface: 4 }],
  ['--dsw-specific-guide-hero', { role: 'primary' }],
  ['--dsw-specific-selector', { surface: 4 }],
]

/** The role a recipe reads from a colors table. */
function roleOf(recipe: Recipe): MatugenRole {
  return 'surface' in recipe ? SURFACE_ROLES[recipe.surface] : recipe.role
}

/** Wrap a color value in the recipe's variant, if it has one. */
function render(value: string, mix: Mix | undefined): string {
  return mix === undefined ? value : `color-mix(in srgb, ${value}, ${mix.with} ${mix.percent}%)`
}

/** Every token this plugin themes, for coverage checks and diagnostics. */
export const PALETTE_TOKENS: readonly string[] = RECIPES.map(([token]) => token)

/**
 * DSW token mapping from one Material You scheme. The palette matugen emits is a
 * dark scheme, so the theme registers with colorScheme 'dark'; the override layer
 * still requires both modes, hence the same values on light.
 * @param colors - matugen colors table, as validated against `MATUGEN_ROLES`.
 * @returns DSW token overrides for one mode.
 */
export function mapColors(colors: MatugenColors): ThemeTokenTable {
  const table: ThemeTokenTable = {}
  for (const [token, recipe] of RECIPES) {
    const value = colors[roleOf(recipe)]
    if (value === undefined) throw new Error(`matugen colors table has no role "${roleOf(recipe)}"`)
    table[token] = render(value, recipe.mix)
  }
  return table
}

/**
 * The matugen template that produces this mapping with per-mode values.
 *
 * Each entry is written out as matugen's `{{colors.<role>.<mode>.hex}}`
 * placeholder, so one template yields a light table and a dark table instead of
 * the single dark scheme `colors.json` carries.
 * @returns the template document, keyed by mode.
 */
export function tokensTemplate(): ThemeTokenModes {
  const mode = (which: 'light' | 'dark'): ThemeTokenTable => {
    const table: ThemeTokenTable = {}
    for (const [token, recipe] of RECIPES) {
      table[token] = render(`{{colors.${roleOf(recipe)}.${which}.hex}}`, recipe.mix)
    }
    return table
  }
  return { light: mode('light'), dark: mode('dark') }
}
