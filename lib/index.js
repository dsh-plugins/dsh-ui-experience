// src/index.ts
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/shared.ts
var REMOTE_SERVICE = "uiExperience";

// src/index.ts
var LOG_FILE = join(homedir(), ".dsh", "ui-experience.log");
function logLine(message) {
  try {
    appendFileSync(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`);
  } catch (error) {
    console.error(`[ui-experience] failed to write ${LOG_FILE}: ${error.message}`);
  }
}
var COLORS_PATH = join(homedir(), ".local/state/quickshell/user/generated/colors.json");
var TOKENS_PATH = join(homedir(), ".local/state/quickshell/user/generated/dsh-tokens.json");
var Config = z.object({
  active: z.boolean().default(false),
  borderWidth: z.string().default("0.5px")
});
var REQUIRED_COLOR_KEYS = [
  "surface_container_lowest",
  "surface_container_low",
  "surface_container",
  "surface_container_high",
  "surface_container_highest",
  "surface_bright",
  "on_surface",
  "on_surface_variant",
  "outline",
  "outline_variant",
  "primary",
  "primary_container",
  "on_primary",
  "secondary",
  "secondary_container",
  "tertiary",
  "tertiary_container",
  "error",
  "error_container",
  "inverse_surface",
  "inverse_on_surface",
  "scrim",
  "shadow"
];
var HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
var REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
function mapColors(colors) {
  const surface = [
    colors.surface_container_lowest,
    colors.surface_container_low,
    colors.surface_container,
    colors.surface_container_high,
    colors.surface_container_highest,
    colors.surface_bright
  ];
  return {
    // ── surfaces ──────────────────────────────────────────────
    "--dsw-alias-bg-base": surface[1],
    "--dsw-alias-bg-layer-1": surface[2],
    "--dsw-alias-bg-layer-2": surface[3],
    "--dsw-alias-bg-layer-3": surface[4],
    "--dsw-alias-bg-layer-4": surface[5],
    "--dsw-alias-bg-overlay": `color-mix(in srgb, ${surface[5]}, white 8%)`,
    // 内置主题的遮罩是半透明黑，直接取 scrim 会得到不透明纯黑，盖住下层界面。
    "--dsw-alias-bg-mask-1": `color-mix(in srgb, ${colors.scrim}, transparent 50%)`,
    "--dsw-alias-bg-module-platform": surface[4],
    "--dsw-alias-bg-skeleton": surface[4],
    // ── borders — uniform outline_variant to avoid visual fragmentation ──
    "--dsw-alias-border-l1": colors.outline_variant,
    "--dsw-alias-border-l2": colors.outline_variant,
    "--dsw-alias-border-l2-darkmode-thin": colors.outline_variant,
    "--dsw-alias-border-l3": colors.outline_variant,
    "--dsw-alias-border-l4": colors.outline_variant,
    // ── brand & labels ────────────────────────────────────────
    "--dsw-alias-brand-primary": colors.primary,
    "--dsw-alias-brand-primary-new-colorprimary-new-color": colors.primary,
    "--dsw-alias-label-primary": colors.on_surface,
    "--dsw-alias-label-secondary": colors.on_surface_variant,
    "--dsw-alias-label-tertiary": colors.on_surface_variant,
    "--dsw-alias-label-caption": colors.on_surface_variant,
    "--dsw-alias-label-dimmed": colors.outline,
    "--dsw-alias-label-error": colors.error,
    "--dsw-alias-label-primary-foreground": colors.on_primary,
    "--dsw-alias-label-shimmer": colors.on_surface_variant,
    "--dsw-alias-link": colors.primary,
    // ── interactive ───────────────────────────────────────────
    "--dsw-alias-interactive-bg-hover": surface[4],
    "--dsw-alias-interactive-bg-active": surface[5],
    "--dsw-alias-interactive-bg-hover-danger": colors.error_container,
    // ── buttons ───────────────────────────────────────────────
    "--dsw-alias-button-primary-fill": colors.primary,
    "--dsw-alias-button-primary-hover": colors.primary,
    "--dsw-alias-button-info-fill": colors.primary,
    "--dsw-alias-button-ghost-active-fill": surface[4],
    "--dsw-alias-button-ghost-active-border": colors.outline,
    "--dsw-alias-button-tool-bar-fill": surface[4],
    "--dsw-alias-button-tool-bar-hover": surface[5],
    "--dsw-alias-label-on-color": colors.on_primary,
    // ── states ────────────────────────────────────────────────
    "--dsw-alias-state-error-primary": colors.error,
    "--dsw-alias-state-idle-primary": colors.outline,
    "--dsw-alias-state-success-primary": colors.tertiary,
    "--dsw-alias-state-success-tertiary": colors.tertiary_container,
    "--dsw-alias-state-warn-primary": colors.secondary,
    "--dsw-alias-state-warn-label": colors.secondary,
    "--dsw-alias-state-warn-tertiary": colors.secondary_container,
    "--dsw-alias-state-business-primary": colors.primary,
    // ── switch ────────────────────────────────────────────────
    "--dsw-alias-switch-thumb": colors.primary,
    // ── menu & overlay ────────────────────────────────────────
    "--dsw-alias-menu-icon": colors.on_surface_variant,
    "--dsw-alias-menu-group-header-fill": surface[4],
    "--dsw-alias-hovercard-bg": surface[4],
    "--dsw-alias-hovercard-label-primary": colors.on_surface,
    // 官方契约里 tooltip 与 toast 始终是深色气泡配浅色文字，key 块是气泡色
    // 混 18% 白。Material 的 inverse_* 在深色调色板下方向相反（浅底深字），
    // 会让继承 label 色的键位提示变成深底深字，故这里改用容器面与前景色。
    "--dsw-alias-tooltip-bg": surface[4],
    "--dsw-alias-tooltip-label": colors.on_surface,
    "--dsw-alias-tooltip-key-bg": `color-mix(in srgb, ${surface[4]}, white 18%)`,
    "--dsw-alias-toast-bg": surface[4],
    "--dsw-alias-toast-label": colors.on_surface,
    "--dsw-alias-toast-action": colors.primary,
    // ── scrollbar ─────────────────────────────────────────────
    "--dsw-alias-scrollbar-bg-l2": surface[2],
    "--dsw-alias-scrollbar-hover-l2": surface[4],
    // ── markdown & code ───────────────────────────────────────
    "--dsw-alias-markdown-code-block": surface[2],
    "--dsw-alias-markdown-code-block-banner": surface[3],
    "--dsw-alias-markdown-inline-code": surface[4],
    "--dsw-alias-markdown-tag": surface[4],
    // ── JSON tree ─────────────────────────────────────────────
    "--dsw-alias-json-tree-hover": surface[4],
    "--dsw-alias-json-tree-icon": colors.on_surface_variant,
    "--dsw-alias-json-tree-keyword": colors.primary,
    "--dsw-alias-json-tree-number": colors.tertiary,
    "--dsw-alias-json-tree-property": colors.on_surface,
    "--dsw-alias-json-tree-punctuation": colors.on_surface_variant,
    "--dsw-alias-json-tree-string": colors.secondary,
    // ── diff ──────────────────────────────────────────────────
    "--dsw-alias-code-diff-added": surface[4],
    "--dsw-alias-code-diff-deleted": surface[4],
    "--dsw-alias-file-diff-added-bg": surface[2],
    "--dsw-alias-file-diff-added-marker": colors.tertiary,
    "--dsw-alias-file-diff-deleted-bg": surface[2],
    "--dsw-alias-file-diff-deleted-marker": colors.error,
    // ── app-specific ──────────────────────────────────────────
    "--dsw-specific-sidebar-fill": surface[0],
    "--dsw-specific-input-major": surface[2],
    "--dsw-specific-bubble": surface[2],
    "--dsw-specific-menu": surface[3],
    "--dsw-menu-surface-fill": surface[3],
    "--dsw-focus-ring-color": colors.primary,
    // ── plugin-side surfaces & fills ──────────────────────────
    "--dsw-alias-bg-document-preview": surface[2],
    "--dsw-alias-bg-l1": surface[2],
    "--dsw-alias-bg-mask-drop": `color-mix(in srgb, ${colors.scrim}, transparent 30%)`,
    "--dsw-alias-card-fill": surface[2],
    "--dsw-alias-card-fill-hover": surface[3],
    "--dsw-alias-card-tile-fill": surface[2],
    "--dsw-alias-fill-l1": surface[2],
    "--dsw-alias-fill-l2": surface[4],
    "--dsw-alias-fill-tsp-secondary": surface[3],
    "--dsw-alias-settings-card-fill": surface[2],
    "--dsw-alias-settings-card-stroke": colors.outline_variant,
    "--dsw-alias-illustration-background": surface[1],
    "--dsw-alias-illustration-backing": surface[2],
    "--dsw-alias-illustration-detail": surface[3],
    "--dsw-alias-illustration-inset": surface[0],
    "--dsw-alias-illustration-shadow": colors.shadow,
    "--dsw-alias-illustration-surface": surface[4],
    // ── plugin-side borders & separators ──────────────────────
    "--dsw-alias-border-inverted": colors.inverse_surface,
    "--dsw-alias-border-selected": colors.primary,
    "--dsw-alias-separator-primary": colors.outline_variant,
    // ── plugin-side buttons ───────────────────────────────────
    "--dsw-alias-button-contrast-fill": colors.inverse_surface,
    "--dsw-alias-button-elevated-fill": surface[4],
    "--dsw-alias-button-floating-fill": surface[4],
    "--dsw-alias-button-floating-hover": surface[5],
    "--dsw-alias-button-info-hover": colors.primary_container,
    // ── plugin-side labels ────────────────────────────────────
    "--dsw-alias-label-deep-diving": colors.primary,
    "--dsw-alias-label-deep-diving-shimmer": colors.secondary,
    "--dsw-alias-label-primary-bluish": colors.on_surface,
    "--dsw-alias-label-primary-dimmed": colors.on_surface_variant,
    "--dsw-alias-label-primary-inverted": colors.inverse_on_surface,
    "--dsw-alias-label-quaternary": colors.outline,
    "--dsw-alias-hovercard-label-secondary": colors.on_surface_variant,
    "--dsw-alias-hovercard-label-tertiary": colors.on_surface_variant,
    // ── plugin-side interactive & states ──────────────────────
    "--dsw-alias-interactive-bg-hover-accent": colors.primary_container,
    "--dsw-alias-interactive-bg-hover-solid": surface[5],
    "--dsw-alias-state-business-tertiary": colors.primary_container,
    "--dsw-alias-state-error-secondary": colors.error_container,
    "--dsw-alias-state-success-secondary": colors.tertiary_container,
    "--dsw-alias-state-warn-secondary": colors.secondary_container,
    "--dsw-alias-trajectory-accent": colors.primary,
    // ── charts, citations, onboarding, turn triggers ──────────
    "--dsw-alias-chart-messages": colors.primary,
    "--dsw-alias-chart-system": colors.secondary,
    "--dsw-alias-chart-tools": colors.tertiary,
    "--dsw-alias-markdown-citation": surface[4],
    "--dsw-alias-onboarding-accent": colors.primary,
    "--dsw-alias-onboarding-card-fill": surface[2],
    "--dsw-alias-onboarding-checkbox-border": colors.outline,
    "--dsw-alias-onboarding-secondary-fill": surface[4],
    "--dsw-alias-turn-trigger-bg": surface[4],
    "--dsw-alias-turn-trigger-bg-hover": surface[5],
    // ── plugin-side scrollbars ────────────────────────────────
    "--dsw-alias-scrollbar-bg-l1": surface[0],
    "--dsw-alias-scrollbar-hover-l1": surface[2],
    // ── diff gutters ──────────────────────────────────────────
    "--dsw-alias-file-diff-added-gutter": colors.tertiary_container,
    "--dsw-alias-file-diff-deleted-gutter": colors.error_container,
    // ── sidebar & misc specifics ──────────────────────────────
    // 侧栏玻璃按钮是侧栏内层，取比侧栏底色高一级，避免与底色重合。tint 与
    // wash 只在 macOS 上作为透明渐变叠加在侧栏之上，这里保持与底色同值。
    "--dsw-specific-sidebar-glass-fill": surface[1],
    "--dsw-specific-sidebar-glass-hover": surface[2],
    "--dsw-specific-sidebar-glass-collapsed-fill": surface[1],
    "--dsw-specific-sidebar-glass-collapsed-hover": surface[2],
    "--dsw-specific-sidebar-nav-item-active": surface[4],
    // 该 token 也作为「推荐」徽标等元素的文字底色，文字色是 button-info-fill
    // （映射为 primary），因此这里必须用容器色保证对比。
    "--dsw-specific-sidebar-nav-item-active-accent": colors.primary_container,
    "--dsw-specific-sidebar-right-flash": surface[3],
    "--dsw-specific-sidebar-tint": surface[0],
    "--dsw-specific-sidebar-wash-bottom": surface[0],
    "--dsw-specific-sidebar-wash-bottom-clear": surface[0],
    "--dsw-specific-sidebar-wash-top": surface[0],
    "--dsw-specific-sidebar-wash-top-clear": surface[0],
    "--dsw-specific-file-upload-track": surface[4],
    "--dsw-specific-guide-hero": colors.primary,
    "--dsw-specific-selector": surface[4]
  };
}
function validateColors(value) {
  if (typeof value !== "object" || value === null) {
    throw new Error("matugen colors file is not a JSON object");
  }
  const colors = value;
  for (const key of REQUIRED_COLOR_KEYS) {
    const color = colors[key];
    if (typeof color !== "string" || !HEX_COLOR.test(color)) {
      throw new Error(`matugen colors file: role "${key}" is missing or not a hex color`);
    }
  }
  return colors;
}
function validateTokenDocument(value) {
  if (typeof value !== "object" || value === null) {
    throw new Error('dsh-tokens file must be { "light": {...}, "dark": {...} } token tables');
  }
  const document = value;
  for (const mode of ["light", "dark"]) {
    const table = document[mode];
    if (typeof table !== "object" || table === null) {
      throw new Error(`dsh-tokens file: missing "${mode}" token table`);
    }
    for (const [name, color] of Object.entries(table)) {
      if (!name.startsWith("--dsw-")) {
        throw new Error(`dsh-tokens file: invalid token name ${JSON.stringify(name)}`);
      }
      if (typeof color !== "string" || color.length === 0) {
        throw new Error(`dsh-tokens file: token "${name}" must map to a non-empty string`);
      }
    }
  }
  return document;
}
function paletteSource() {
  if (existsSync(TOKENS_PATH)) return TOKENS_PATH;
  if (existsSync(COLORS_PATH)) return COLORS_PATH;
  return void 0;
}
function readPaletteTokens(source) {
  if (source === TOKENS_PATH) return validateTokenDocument(JSON.parse(readFileSync(source, "utf8")));
  const colors = validateColors(JSON.parse(readFileSync(source, "utf8")));
  const tokens = mapColors(colors);
  return { light: tokens, dark: tokens };
}
function readPalette() {
  const source = paletteSource();
  if (source === void 0) return { missing: true };
  return { version: statSync(source).mtimeMs, tokens: readPaletteTokens(source) };
}
var UiExperienceService = class extends TypertRemoteService {
  constructor(ctx, config, entry, editor) {
    super(ctx, REMOTE_SERVICE);
    this.config = config;
    this.entry = entry;
    this.editor = editor;
  }
  config;
  entry;
  editor;
  /** Parsed palette cache keyed by source path and mtime, so steady-state
   *  polls only stat the file instead of re-parsing and re-mapping it. */
  cache;
  /**
   * Remote poll endpoint: report whether the palette changed since the
   * caller's known version, carrying the mapped tokens when it did.
   */
  poll(args) {
    const source = paletteSource();
    if (source === void 0) return { missing: true, active: this.config.active };
    let version;
    try {
      version = statSync(source).mtimeMs;
    } catch (error) {
      return { error: error.message, active: this.config.active };
    }
    if (this.cache?.source !== source || this.cache.version !== version) {
      let tokens;
      try {
        tokens = readPaletteTokens(source);
      } catch (error) {
        return { error: error.message, active: this.config.active };
      }
      this.cache = { source, version, tokens };
    }
    if (args?.known === version) return { changed: false, active: this.config.active, borderWidth: this.config.borderWidth };
    return { changed: true, version, tokens: this.cache.tokens, active: this.config.active, borderWidth: this.config.borderWidth };
  }
  /** Remote endpoint persisting the Matugen mode switch through the config editor. */
  async setActive(args) {
    const next = args?.active === true;
    const entry = this.entry;
    logLine(`setActive(${next}): entry=${entry === void 0 ? "missing" : entry.options.id}`);
    if (entry === void 0) throw new Error("ui-experience: plugin entry is unavailable; cannot persist the mode switch");
    try {
      await this.editor.edit(entry, (current) => ({ ...current, active: next }));
    } catch (error) {
      logLine(`setActive(${next}) FAILED: ${error.stack ?? error.message}`);
      throw error;
    }
    logLine(`setActive(${next}) persisted`);
    return { active: next };
  }
};
Object.defineProperty(UiExperienceService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: "poll", invocation: Object.freeze({ kind: "direct" }) }),
      Object.freeze({ method: "setActive", invocation: Object.freeze({ kind: "direct" }) })
    ])
  })
});
function bootMatugenStyle() {
  let light = "#fff";
  let dark = "#151517";
  try {
    const palette = readPalette();
    if (!("missing" in palette)) {
      light = palette.tokens.light["--dsw-alias-bg-base"] ?? light;
      dark = palette.tokens.dark["--dsw-alias-bg-base"] ?? dark;
    }
  } catch (error) {
    logLine(`failed to read palette for boot paint: ${error.message}`);
  }
  return `:root{color-scheme:dark}body{background-color:${dark};--dsh-boot-bg:${dark}}@media(prefers-color-scheme:light){:root{color-scheme:light}body{background-color:${light};--dsh-boot-bg:${light}}}`;
}
var inject = ["configEditor"];
function apply(ctx, config) {
  logLine(`apply: active=${String(config.active)} borderWidth=${config.borderWidth}`);
  ctx.on("webserver/index-inject", (table) => {
    if (config.active) table.push({ kind: "style", text: bootMatugenStyle() });
  });
  try {
    new UiExperienceService(ctx, config, ctx.fiber.entry, ctx.configEditor);
  } catch (error) {
    console.error(`[ui-experience] failed to register host service: ${error.message}`);
    throw error;
  }
}
export {
  Config,
  apply,
  inject
};
