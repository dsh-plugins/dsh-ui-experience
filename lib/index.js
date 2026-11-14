// src/index.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile as readFileAsync, stat as statAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/shared.ts
var REMOTE_SERVICE = "uiExperience";
var BOOT_ATTRIBUTE = "data-dsh-uix-matugen";
var DEFAULT_COLORS_PATH = "~/.local/state/quickshell/user/generated/colors.json";
var DEFAULT_TOKENS_PATH = "~/.local/state/quickshell/user/generated/dsh-tokens.json";

// src/palette.ts
var MATUGEN_ROLES = [
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
var SURFACE_ROLES = [
  "surface_container_lowest",
  "surface_container_low",
  "surface_container",
  "surface_container_high",
  "surface_container_highest",
  "surface_bright"
];
var RECIPES = [
  // ── surfaces ──────────────────────────────────────────────
  ["--dsw-alias-bg-base", { surface: 1 }],
  ["--dsw-alias-bg-layer-1", { surface: 2 }],
  ["--dsw-alias-bg-layer-2", { surface: 3 }],
  ["--dsw-alias-bg-layer-3", { surface: 4 }],
  ["--dsw-alias-bg-layer-4", { surface: 5 }],
  ["--dsw-alias-bg-overlay", { surface: 5, mix: { with: "white", percent: 8 } }],
  // 内置主题的遮罩是半透明黑，直接取 scrim 会得到不透明纯黑，盖住下层界面。
  ["--dsw-alias-bg-mask-1", { role: "scrim", mix: { with: "transparent", percent: 50 } }],
  ["--dsw-alias-bg-module-platform", { surface: 4 }],
  ["--dsw-alias-bg-skeleton", { surface: 4 }],
  // ── borders — uniform outline_variant to avoid visual fragmentation ──
  ["--dsw-alias-border-l1", { role: "outline_variant" }],
  ["--dsw-alias-border-l2", { role: "outline_variant" }],
  ["--dsw-alias-border-l2-darkmode-thin", { role: "outline_variant" }],
  ["--dsw-alias-border-l3", { role: "outline_variant" }],
  ["--dsw-alias-border-l4", { role: "outline_variant" }],
  // ── brand & labels ────────────────────────────────────────
  ["--dsw-alias-brand-primary", { role: "primary" }],
  ["--dsw-alias-brand-primary-new-colorprimary-new-color", { role: "primary" }],
  ["--dsw-alias-label-primary", { role: "on_surface" }],
  ["--dsw-alias-label-secondary", { role: "on_surface_variant" }],
  ["--dsw-alias-label-tertiary", { role: "on_surface_variant" }],
  ["--dsw-alias-label-caption", { role: "on_surface_variant" }],
  ["--dsw-alias-label-dimmed", { role: "outline" }],
  ["--dsw-alias-label-error", { role: "error" }],
  ["--dsw-alias-label-primary-foreground", { role: "on_primary" }],
  ["--dsw-alias-label-shimmer", { role: "on_surface_variant" }],
  ["--dsw-alias-link", { role: "primary" }],
  // ── interactive ───────────────────────────────────────────
  ["--dsw-alias-interactive-bg-hover", { surface: 4 }],
  ["--dsw-alias-interactive-bg-active", { surface: 5 }],
  ["--dsw-alias-interactive-bg-hover-danger", { role: "error_container" }],
  // ── buttons ───────────────────────────────────────────────
  ["--dsw-alias-button-primary-fill", { role: "primary" }],
  ["--dsw-alias-button-primary-hover", { role: "primary" }],
  ["--dsw-alias-button-info-fill", { role: "primary" }],
  ["--dsw-alias-button-ghost-active-fill", { surface: 4 }],
  ["--dsw-alias-button-ghost-active-border", { role: "outline" }],
  ["--dsw-alias-button-tool-bar-fill", { surface: 4 }],
  ["--dsw-alias-button-tool-bar-hover", { surface: 5 }],
  ["--dsw-alias-label-on-color", { role: "on_primary" }],
  // ── states ────────────────────────────────────────────────
  ["--dsw-alias-state-error-primary", { role: "error" }],
  ["--dsw-alias-state-idle-primary", { role: "outline" }],
  ["--dsw-alias-state-success-primary", { role: "tertiary" }],
  ["--dsw-alias-state-success-tertiary", { role: "tertiary_container" }],
  ["--dsw-alias-state-warn-primary", { role: "secondary" }],
  ["--dsw-alias-state-warn-label", { role: "secondary" }],
  ["--dsw-alias-state-warn-tertiary", { role: "secondary_container" }],
  ["--dsw-alias-state-business-primary", { role: "primary" }],
  // ── switch ────────────────────────────────────────────────
  // switch-thumb 是关闭态滑块色，语义为中性前景，内置主题暗色取
  // neutral-bluish-400（纯灰）、浅色取近白。映射成 primary 会让关闭态带上
  // 强调色，映射成 on_surface_variant 又会把前景色渗进整体观感；这里不做
  // 覆盖，保持原生纯灰，开关只在开启态轨道显示强调色。
  // ── menu & overlay ────────────────────────────────────────
  ["--dsw-alias-menu-icon", { role: "on_surface_variant" }],
  ["--dsw-alias-menu-group-header-fill", { surface: 4 }],
  ["--dsw-alias-hovercard-bg", { surface: 4 }],
  ["--dsw-alias-hovercard-label-primary", { role: "on_surface" }],
  // 官方契约里 tooltip 与 toast 始终是深色气泡配浅色文字，key 块是气泡色
  // 混 18% 白。Material 的 inverse_* 在深色调色板下方向相反（浅底深字），
  // 会让继承 label 色的键位提示变成深底深字，故这里改用容器面与前景色。
  ["--dsw-alias-tooltip-bg", { surface: 4 }],
  ["--dsw-alias-tooltip-label", { role: "on_surface" }],
  ["--dsw-alias-tooltip-key-bg", { surface: 4, mix: { with: "white", percent: 18 } }],
  ["--dsw-alias-toast-bg", { surface: 4 }],
  ["--dsw-alias-toast-label", { role: "on_surface" }],
  ["--dsw-alias-toast-action", { role: "primary" }],
  // ── scrollbar ─────────────────────────────────────────────
  ["--dsw-alias-scrollbar-bg-l2", { surface: 2 }],
  ["--dsw-alias-scrollbar-hover-l2", { surface: 4 }],
  // ── markdown & code ───────────────────────────────────────
  ["--dsw-alias-markdown-code-block", { surface: 2 }],
  ["--dsw-alias-markdown-code-block-banner", { surface: 3 }],
  ["--dsw-alias-markdown-inline-code", { surface: 4 }],
  ["--dsw-alias-markdown-tag", { surface: 4 }],
  // ── JSON tree ─────────────────────────────────────────────
  ["--dsw-alias-json-tree-hover", { surface: 4 }],
  ["--dsw-alias-json-tree-icon", { role: "on_surface_variant" }],
  ["--dsw-alias-json-tree-keyword", { role: "primary" }],
  ["--dsw-alias-json-tree-number", { role: "tertiary" }],
  ["--dsw-alias-json-tree-property", { role: "on_surface" }],
  ["--dsw-alias-json-tree-punctuation", { role: "on_surface_variant" }],
  ["--dsw-alias-json-tree-string", { role: "secondary" }],
  // ── diff ──────────────────────────────────────────────────
  ["--dsw-alias-code-diff-added", { surface: 4 }],
  ["--dsw-alias-code-diff-deleted", { surface: 4 }],
  ["--dsw-alias-file-diff-added-bg", { surface: 2 }],
  ["--dsw-alias-file-diff-added-marker", { role: "tertiary" }],
  ["--dsw-alias-file-diff-deleted-bg", { surface: 2 }],
  ["--dsw-alias-file-diff-deleted-marker", { role: "error" }],
  // ── app-specific ──────────────────────────────────────────
  ["--dsw-specific-sidebar-fill", { surface: 0 }],
  ["--dsw-specific-input-major", { surface: 2 }],
  ["--dsw-specific-bubble", { surface: 2 }],
  ["--dsw-specific-menu", { surface: 3 }],
  ["--dsw-menu-surface-fill", { surface: 3 }],
  ["--dsw-focus-ring-color", { role: "primary" }],
  // ── plugin-side surfaces & fills ──────────────────────────
  ["--dsw-alias-bg-document-preview", { surface: 2 }],
  ["--dsw-alias-bg-l1", { surface: 2 }],
  ["--dsw-alias-bg-mask-drop", { role: "scrim", mix: { with: "transparent", percent: 30 } }],
  ["--dsw-alias-card-fill", { surface: 2 }],
  ["--dsw-alias-card-fill-hover", { surface: 3 }],
  ["--dsw-alias-card-tile-fill", { surface: 2 }],
  ["--dsw-alias-fill-l1", { surface: 2 }],
  ["--dsw-alias-fill-l2", { surface: 4 }],
  ["--dsw-alias-fill-tsp-secondary", { surface: 3 }],
  ["--dsw-alias-settings-card-fill", { surface: 2 }],
  ["--dsw-alias-settings-card-stroke", { role: "outline_variant" }],
  ["--dsw-alias-illustration-background", { surface: 1 }],
  ["--dsw-alias-illustration-backing", { surface: 2 }],
  ["--dsw-alias-illustration-detail", { surface: 3 }],
  ["--dsw-alias-illustration-inset", { surface: 0 }],
  ["--dsw-alias-illustration-shadow", { role: "shadow" }],
  ["--dsw-alias-illustration-surface", { surface: 4 }],
  // ── plugin-side borders & separators ──────────────────────
  ["--dsw-alias-border-inverted", { role: "inverse_surface" }],
  ["--dsw-alias-border-selected", { role: "primary" }],
  ["--dsw-alias-separator-primary", { role: "outline_variant" }],
  // ── plugin-side buttons ───────────────────────────────────
  ["--dsw-alias-button-contrast-fill", { role: "inverse_surface" }],
  ["--dsw-alias-button-elevated-fill", { surface: 4 }],
  ["--dsw-alias-button-floating-fill", { surface: 4 }],
  ["--dsw-alias-button-floating-hover", { surface: 5 }],
  ["--dsw-alias-button-info-hover", { role: "primary_container" }],
  // ── plugin-side labels ────────────────────────────────────
  ["--dsw-alias-label-deep-diving", { role: "primary" }],
  ["--dsw-alias-label-deep-diving-shimmer", { role: "secondary" }],
  ["--dsw-alias-label-primary-bluish", { role: "on_surface" }],
  ["--dsw-alias-label-primary-dimmed", { role: "on_surface_variant" }],
  ["--dsw-alias-label-primary-inverted", { role: "inverse_on_surface" }],
  ["--dsw-alias-label-quaternary", { role: "outline" }],
  ["--dsw-alias-hovercard-label-secondary", { role: "on_surface_variant" }],
  ["--dsw-alias-hovercard-label-tertiary", { role: "on_surface_variant" }],
  // ── plugin-side interactive & states ──────────────────────
  ["--dsw-alias-interactive-bg-hover-accent", { role: "primary_container" }],
  ["--dsw-alias-interactive-bg-hover-solid", { surface: 5 }],
  ["--dsw-alias-state-business-tertiary", { role: "primary_container" }],
  ["--dsw-alias-state-error-secondary", { role: "error_container" }],
  ["--dsw-alias-state-success-secondary", { role: "tertiary_container" }],
  ["--dsw-alias-state-warn-secondary", { role: "secondary_container" }],
  ["--dsw-alias-trajectory-accent", { role: "primary" }],
  // ── charts, citations, onboarding, turn triggers ──────────
  ["--dsw-alias-chart-messages", { role: "primary" }],
  ["--dsw-alias-chart-system", { role: "secondary" }],
  ["--dsw-alias-chart-tools", { role: "tertiary" }],
  ["--dsw-alias-markdown-citation", { surface: 4 }],
  ["--dsw-alias-onboarding-accent", { role: "primary" }],
  ["--dsw-alias-onboarding-card-fill", { surface: 2 }],
  ["--dsw-alias-onboarding-checkbox-border", { role: "outline" }],
  ["--dsw-alias-onboarding-secondary-fill", { surface: 4 }],
  ["--dsw-alias-turn-trigger-bg", { surface: 4 }],
  ["--dsw-alias-turn-trigger-bg-hover", { surface: 5 }],
  // ── plugin-side scrollbars ────────────────────────────────
  ["--dsw-alias-scrollbar-bg-l1", { surface: 0 }],
  ["--dsw-alias-scrollbar-hover-l1", { surface: 2 }],
  // ── diff gutters ──────────────────────────────────────────
  ["--dsw-alias-file-diff-added-gutter", { role: "tertiary_container" }],
  ["--dsw-alias-file-diff-deleted-gutter", { role: "error_container" }],
  // ── sidebar & misc specifics ──────────────────────────────
  // 侧栏玻璃按钮是侧栏内层，取比侧栏底色高一级，避免与底色重合。tint 与
  // wash 只在 macOS 上作为透明渐变叠加在侧栏之上，这里保持与底色同值。
  ["--dsw-specific-sidebar-glass-fill", { surface: 1 }],
  ["--dsw-specific-sidebar-glass-hover", { surface: 2 }],
  ["--dsw-specific-sidebar-glass-collapsed-fill", { surface: 1 }],
  ["--dsw-specific-sidebar-glass-collapsed-hover", { surface: 2 }],
  ["--dsw-specific-sidebar-nav-item-active", { surface: 4 }],
  // 该 token 也作为「推荐」徽标等元素的文字底色，文字色是 button-info-fill
  // （映射为 primary），因此这里必须用容器色保证对比。
  ["--dsw-specific-sidebar-nav-item-active-accent", { role: "primary_container" }],
  ["--dsw-specific-sidebar-right-flash", { surface: 3 }],
  ["--dsw-specific-sidebar-tint", { surface: 0 }],
  ["--dsw-specific-sidebar-wash-bottom", { surface: 0 }],
  ["--dsw-specific-sidebar-wash-bottom-clear", { surface: 0 }],
  ["--dsw-specific-sidebar-wash-top", { surface: 0 }],
  ["--dsw-specific-sidebar-wash-top-clear", { surface: 0 }],
  ["--dsw-specific-file-upload-track", { surface: 4 }],
  ["--dsw-specific-guide-hero", { role: "primary" }],
  ["--dsw-specific-selector", { surface: 4 }]
];
function roleOf(recipe) {
  return "surface" in recipe ? SURFACE_ROLES[recipe.surface] : recipe.role;
}
function render(value, mix) {
  return mix === void 0 ? value : `color-mix(in srgb, ${value}, ${mix.with} ${mix.percent}%)`;
}
var PALETTE_TOKENS = RECIPES.map(([token]) => token);
function mapColors(colors) {
  const table = {};
  for (const [token, recipe] of RECIPES) {
    const value = colors[roleOf(recipe)];
    if (value === void 0) throw new Error(`matugen colors table has no role "${roleOf(recipe)}"`);
    table[token] = render(value, recipe.mix);
  }
  return table;
}

// src/index.ts
var LOG_FILE = join(homedir(), ".dsh", "ui-experience.log");
var LOG_MAX_BYTES = 512 * 1024;
function logLine(message) {
  try {
    const dir = dirname(LOG_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) writeFileSync(LOG_FILE, "");
    appendFileSync(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`);
  } catch (error) {
    console.error(`[ui-experience] failed to write ${LOG_FILE}: ${error.message}`);
  }
}
var BORDER_WIDTH = /^(?:0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em))$/;
var PATH_PATTERN = /^(?:~$|~\/|\/)/;
var MOTION_MODE = /^(?:off|m3|m3e)$/;
var MOTION_REDUCED = /^(?:system|always)$/;
var Config = z.object({
  active: z.boolean().default(false).volatile(),
  borderWidth: z.string().pattern(BORDER_WIDTH).default("0.5px").volatile(),
  colorsPath: z.string().pattern(PATH_PATTERN).default(DEFAULT_COLORS_PATH).volatile(),
  tokensPath: z.string().pattern(PATH_PATTERN).default(DEFAULT_TOKENS_PATH).volatile(),
  motion: z.string().pattern(MOTION_MODE).default("off").volatile(),
  motionDurationScale: z.number().min(0.5).max(2).default(1).volatile(),
  motionSpatialSplit: z.boolean().default(true).volatile(),
  motionQuantize: z.boolean().default(false).volatile(),
  motionReduced: z.string().pattern(MOTION_REDUCED).default("system").volatile(),
  motionScroll: z.boolean().default(true).volatile(),
  motionStream: z.boolean().default(true).volatile(),
  motionFollowScroll: z.boolean().default(true).volatile(),
  streamRevealMinMs: z.number().min(60).max(2e3).default(250).volatile(),
  streamRevealMaxMs: z.number().min(200).max(8e3).default(1200).volatile(),
  streamEnterMs: z.number().min(0).max(2e3).default(220).volatile(),
  streamRollMs: z.number().min(0).max(2e3).default(260).volatile()
});
var HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
var CSS_VALUE_FORBIDDEN = /[{};<>\n\r]|\/\*|\*\//;
var CSS_VALUE_MAX_LENGTH = 256;
function isSafeTokenValue(value) {
  return value.length > 0 && value.length <= CSS_VALUE_MAX_LENGTH && !CSS_VALUE_FORBIDDEN.test(value);
}
var REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
function validateColors(value) {
  if (typeof value !== "object" || value === null) {
    throw new Error("matugen colors file is not a JSON object");
  }
  const colors = value;
  for (const key of MATUGEN_ROLES) {
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
      if (typeof color !== "string" || !isSafeTokenValue(color)) {
        throw new Error(`dsh-tokens file: token "${name}" must be a CSS value without braces, semicolons, or angle brackets, got ${JSON.stringify(color)}`);
      }
    }
  }
  return document;
}
function resolvePath(raw, label) {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error(`ui-experience: ${label} is empty; set it in the plugin configuration`);
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) {
    throw new Error(`ui-experience: ${label} must be absolute or start with "~/": ${raw}`);
  }
  return expanded;
}
function effectivePaths(config) {
  return { colors: config.colorsPath.get(), tokens: config.tokensPath.get() };
}
function effectiveMotion(config) {
  return {
    mode: config.motion.get(),
    durationScale: config.motionDurationScale.get(),
    spatialSplit: config.motionSpatialSplit.get(),
    quantize: config.motionQuantize.get(),
    reduced: config.motionReduced.get(),
    scroll: config.motionScroll.get(),
    stream: config.motionStream.get(),
    followScroll: config.motionFollowScroll.get(),
    streamRevealMinMs: config.streamRevealMinMs.get(),
    streamRevealMaxMs: config.streamRevealMaxMs.get(),
    streamEnterMs: config.streamEnterMs.get(),
    streamRollMs: config.streamRollMs.get()
  };
}
var paletteCache;
var PALETTE_MAX_BYTES = 4 * 1024 * 1024;
var readFileText = (path) => readFileAsync(path, "utf8");
var statFile = (path) => statAsync(path);
function resolveSources(config) {
  const paths = effectivePaths(config);
  try {
    const tokensFile = resolvePath(paths.tokens, "tokensPath");
    const colorsFile = resolvePath(paths.colors, "colorsPath");
    return {
      ok: true,
      sources: {
        paths,
        tokensFile,
        colorsFile,
        hasTokens: existsSync(tokensFile),
        hasColors: existsSync(colorsFile)
      }
    };
  } catch (error) {
    return { ok: false, paths, status: "error", message: error.message };
  }
}
function composePalette(sources, mapped, tokens) {
  if (mapped === void 0 && tokens === void 0) {
    throw new Error(`no palette file at tokensPath (${sources.tokensFile}) or colorsPath (${sources.colorsFile})`);
  }
  if (mapped === void 0) return tokens;
  if (tokens === void 0) return mapped;
  return {
    light: { ...mapped.light, ...tokens.light },
    dark: { ...mapped.dark, ...tokens.dark }
  };
}
function auditCoverage(tokens, mapped) {
  if (tokens === void 0) return;
  if (mapped !== void 0) {
    logLine(`palette composed from colorsPath mapping + tokensPath overrides (light ${coverage(tokens.light)}/${PALETTE_TOKENS.length}, dark ${coverage(tokens.dark)}/${PALETTE_TOKENS.length})`);
    return;
  }
  const missingLight = PALETTE_TOKENS.filter((token) => typeof tokens.light[token] !== "string");
  const missingDark = PALETTE_TOKENS.filter((token) => typeof tokens.dark[token] !== "string");
  logLine(`no colorsPath base: tokensPath covers light ${coverage(tokens.light)}/${PALETTE_TOKENS.length}, dark ${coverage(tokens.dark)}/${PALETTE_TOKENS.length}`);
  if (missingLight.length > 0) {
    logLine(`light mode keeps the shipped palette for ${missingLight.length} token(s): ${summarize(missingLight)}`);
  }
  if (missingDark.length > 0) {
    logLine(`dark mode keeps the shipped palette for ${missingDark.length} token(s): ${summarize(missingDark)}`);
  }
  if (missingLight.length > 0 || missingDark.length > 0) {
    logLine(`a complete template ships at ${templatePath()}; it covers every token in both modes`);
  }
}
function coverage(table) {
  return PALETTE_TOKENS.filter((token) => typeof table[token] === "string").length;
}
function summarize(tokens) {
  const shown = tokens.slice(0, LOGGED_TOKEN_NAMES);
  const rest = tokens.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, and ${rest} more` : shown.join(", ");
}
var LOGGED_TOKEN_NAMES = 12;
function templatePath() {
  return fileURLToPath(new URL("../templates/dsh-tokens.json", import.meta.url));
}
function parseMapped(text) {
  const table = mapColors(validateColors(JSON.parse(text)));
  return { light: table, dark: table };
}
function loadPartSync(path, exists, parse) {
  if (!exists) return { key: "-", has: false };
  const stat = statSync(path);
  if (stat.size > PALETTE_MAX_BYTES) {
    throw new Error(`${path} is ${stat.size} bytes, over the ${PALETTE_MAX_BYTES} byte limit`);
  }
  return { key: `${path}@${stat.mtimeMs}:${stat.size}`, has: true, modes: parse(readFileSync(path, "utf8")) };
}
function readPaletteSync(config) {
  const resolved = resolveSources(config);
  if (!resolved.ok) return resolved;
  const { sources } = resolved;
  if (!sources.hasTokens && !sources.hasColors) {
    return {
      ok: false,
      paths: sources.paths,
      status: "missing",
      message: `no palette file at tokensPath (${sources.tokensFile}) or colorsPath (${sources.colorsFile})`
    };
  }
  try {
    const mapped = loadPartSync(sources.colorsFile, sources.hasColors, parseMapped);
    const tokens = loadPartSync(sources.tokensFile, sources.hasTokens, (text) => validateTokenDocument(JSON.parse(text)));
    const version = `${mapped.key}|${tokens.key}`;
    if (paletteCache !== void 0 && paletteCache.version === version) {
      return { ok: true, paths: sources.paths, palette: paletteCache };
    }
    const modes = composePalette(sources, mapped.modes, tokens.modes);
    auditCoverage(tokens.modes, mapped.modes);
    paletteCache = { source: sources.paths.tokens, version, tokens: modes };
    return { ok: true, paths: sources.paths, palette: paletteCache };
  } catch (error) {
    return {
      ok: false,
      paths: sources.paths,
      status: "error",
      message: `cannot read palette: ${error.message}`
    };
  }
}
async function loadPart(path, exists, parse) {
  if (!exists) return { key: "-", has: false };
  const stat = await statFile(path);
  if (stat.size > PALETTE_MAX_BYTES) {
    throw new Error(`${path} is ${stat.size} bytes, over the ${PALETTE_MAX_BYTES} byte limit`);
  }
  return { key: `${path}@${stat.mtimeMs}:${stat.size}`, has: true, modes: parse(await readFileText(path)) };
}
async function readPalette(config) {
  const resolved = resolveSources(config);
  if (!resolved.ok) return resolved;
  const { sources } = resolved;
  if (!sources.hasTokens && !sources.hasColors) {
    return {
      ok: false,
      paths: sources.paths,
      status: "missing",
      message: `no palette file at tokensPath (${sources.tokensFile}) or colorsPath (${sources.colorsFile})`
    };
  }
  try {
    const mapped = await loadPart(sources.colorsFile, sources.hasColors, parseMapped);
    const tokens = await loadPart(sources.tokensFile, sources.hasTokens, (text) => validateTokenDocument(JSON.parse(text)));
    const version = `${mapped.key}|${tokens.key}`;
    if (paletteCache !== void 0 && paletteCache.version === version) {
      return { ok: true, paths: sources.paths, palette: paletteCache };
    }
    const modes = composePalette(sources, mapped.modes, tokens.modes);
    auditCoverage(tokens.modes, mapped.modes);
    paletteCache = { source: sources.paths.tokens, version, tokens: modes };
    return { ok: true, paths: sources.paths, palette: paletteCache };
  } catch (error) {
    return {
      ok: false,
      paths: sources.paths,
      status: "error",
      message: `cannot read palette: ${error.message}`
    };
  }
}
function bootColor(value, mode) {
  if (value !== void 0 && HEX_COLOR.test(value)) return value;
  const fallback = mode === "light" ? "#fff" : "#151517";
  logLine(`boot paint: ${mode} base color ${JSON.stringify(value)} is not a hex color; using ${fallback}`);
  return fallback;
}
function bootRows(palette) {
  const light = bootColor(palette.tokens.light["--dsw-alias-bg-base"], "light");
  const dark = bootColor(palette.tokens.dark["--dsw-alias-bg-base"], "dark");
  const scope = `html[${BOOT_ATTRIBUTE}]`;
  const text = `${scope} body[data-ds-dark-theme]{background-color:${dark};--dsh-boot-bg:${dark}}${scope} body:not([data-ds-dark-theme]){background-color:${light};--dsh-boot-bg:${light}}`;
  return [
    { kind: "style", text },
    {
      kind: "script",
      placement: "body",
      text: `document.documentElement.toggleAttribute(${JSON.stringify(BOOT_ATTRIBUTE)}, true)`
    }
  ];
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
  /**
   * Remote poll endpoint: report the palette when it changed since the caller's
   * known version, and always report the live switch, border width, paths, and
   * motion settings.
   * @param args - the caller's last seen version.
   * @returns the poll payload.
   */
  async poll(args) {
    const read = await readPalette(this.config);
    const active = this.config.active.get();
    const borderWidth = this.config.borderWidth.get();
    const motion = effectiveMotion(this.config);
    if (!read.ok) {
      return { status: read.status, message: read.message, active, borderWidth, paths: read.paths, motion };
    }
    const { palette, paths } = read;
    if (args?.known === palette.version) {
      return {
        status: "ok",
        changed: false,
        version: palette.version,
        source: palette.source,
        active,
        borderWidth,
        paths,
        motion
      };
    }
    return {
      status: "ok",
      changed: true,
      version: palette.version,
      tokens: palette.tokens,
      source: palette.source,
      active,
      borderWidth,
      paths,
      motion
    };
  }
  /**
   * Remote endpoint persisting the Matugen mode switch.
   * @param args - the requested switch state.
   * @returns the persisted state.
   */
  async setActive(args) {
    const next = args?.active;
    if (typeof next !== "boolean") throw new Error("ui-experience: setActive requires a boolean `active`");
    await this.persist((current) => ({ ...current, active: next }));
    logLine(`setActive(${next}) persisted`);
    return { active: next };
  }
  /**
   * Remote endpoint persisting the palette paths.
   * @param args - the paths to write; an omitted field keeps its value.
   * @returns the paths now in effect.
   */
  async setPaths(args) {
    const colors = typeof args?.colorsPath === "string" ? args.colorsPath.trim() : void 0;
    const tokens = typeof args?.tokensPath === "string" ? args.tokensPath.trim() : void 0;
    if (colors === void 0 && tokens === void 0) {
      throw new Error("ui-experience: setPaths requires `colorsPath` or `tokensPath`");
    }
    if (colors !== void 0) resolvePath(colors, "colorsPath");
    if (tokens !== void 0) resolvePath(tokens, "tokensPath");
    await this.persist((current) => ({
      ...current,
      ...colors === void 0 ? {} : { colorsPath: colors },
      ...tokens === void 0 ? {} : { tokensPath: tokens }
    }));
    const paths = {
      colors: colors ?? this.config.colorsPath.get(),
      tokens: tokens ?? this.config.tokensPath.get()
    };
    logLine(`setPaths: colors=${paths.colors} tokens=${paths.tokens}`);
    return { paths };
  }
  /**
   * Remote endpoint persisting the motion layer settings. Every field is
   * optional, and an omitted field keeps its stored value so one control can be
   * changed without resending the rest.
   * @param args - the fields to write.
   * @returns the settings now in effect.
   */
  async setMotion(args) {
    const mode = args?.mode;
    const reduced = args?.reduced;
    const scale = args?.durationScale;
    const spatialSplit = args?.spatialSplit;
    const quantize = args?.quantize;
    const scroll = args?.scroll;
    const stream = args?.stream;
    const followScroll = args?.followScroll;
    const streamRevealMinMs = args?.streamRevealMinMs;
    const streamRevealMaxMs = args?.streamRevealMaxMs;
    const streamEnterMs = args?.streamEnterMs;
    const streamRollMs = args?.streamRollMs;
    if (mode === void 0 && reduced === void 0 && scale === void 0 && spatialSplit === void 0 && quantize === void 0 && scroll === void 0 && stream === void 0 && followScroll === void 0 && streamRevealMinMs === void 0 && streamRevealMaxMs === void 0 && streamEnterMs === void 0 && streamRollMs === void 0) {
      throw new Error("ui-experience: setMotion requires at least one field");
    }
    for (const [name, value] of [
      ["streamRevealMinMs", streamRevealMinMs],
      ["streamRevealMaxMs", streamRevealMaxMs],
      ["streamEnterMs", streamEnterMs],
      ["streamRollMs", streamRollMs]
    ]) {
      if (value === void 0) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`ui-experience: ${name} must be a non-negative number, got ${String(value)}`);
      }
    }
    if (mode !== void 0 && !MOTION_MODE.test(mode)) {
      throw new Error(`ui-experience: unknown motion mode ${JSON.stringify(mode)}`);
    }
    if (reduced !== void 0 && !MOTION_REDUCED.test(reduced)) {
      throw new Error(`ui-experience: unknown reduced-motion policy ${JSON.stringify(reduced)}`);
    }
    if (scale !== void 0 && (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.5 || scale > 2)) {
      throw new Error(`ui-experience: durationScale ${String(scale)} is outside 0.5\u20132`);
    }
    if (spatialSplit !== void 0 && typeof spatialSplit !== "boolean") {
      throw new Error(`ui-experience: spatialSplit must be a boolean, got ${typeof spatialSplit}`);
    }
    if (quantize !== void 0 && typeof quantize !== "boolean") {
      throw new Error(`ui-experience: quantize must be a boolean, got ${typeof quantize}`);
    }
    if (scroll !== void 0 && typeof scroll !== "boolean") {
      throw new Error(`ui-experience: scroll must be a boolean, got ${typeof scroll}`);
    }
    if (stream !== void 0 && typeof stream !== "boolean") {
      throw new Error(`ui-experience: stream must be a boolean, got ${typeof stream}`);
    }
    if (followScroll !== void 0 && typeof followScroll !== "boolean") {
      throw new Error(`ui-experience: followScroll must be a boolean, got ${typeof followScroll}`);
    }
    for (const [name, value] of [
      ["streamRevealMinMs", streamRevealMinMs],
      ["streamRevealMaxMs", streamRevealMaxMs],
      ["streamEnterMs", streamEnterMs],
      ["streamRollMs", streamRollMs]
    ]) {
      if (value === void 0) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`ui-experience: ${name} must be a non-negative number, got ${String(value)}`);
      }
    }
    for (const [name, value] of [
      ["streamRevealMinMs", streamRevealMinMs],
      ["streamRevealMaxMs", streamRevealMaxMs],
      ["streamEnterMs", streamEnterMs],
      ["streamRollMs", streamRollMs]
    ]) {
      if (value === void 0) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`ui-experience: ${name} must be a non-negative number, got ${String(value)}`);
      }
    }
    await this.persist((current) => ({
      ...current,
      ...mode === void 0 ? {} : { motion: mode },
      ...reduced === void 0 ? {} : { motionReduced: reduced },
      ...scale === void 0 ? {} : { motionDurationScale: scale },
      ...spatialSplit === void 0 ? {} : { motionSpatialSplit: spatialSplit },
      ...quantize === void 0 ? {} : { motionQuantize: quantize },
      ...scroll === void 0 ? {} : { motionScroll: scroll },
      ...stream === void 0 ? {} : { motionStream: stream },
      ...followScroll === void 0 ? {} : { motionFollowScroll: followScroll },
      ...streamRevealMinMs === void 0 ? {} : { streamRevealMinMs },
      ...streamRevealMaxMs === void 0 ? {} : { streamRevealMaxMs },
      ...streamEnterMs === void 0 ? {} : { streamEnterMs },
      ...streamRollMs === void 0 ? {} : { streamRollMs }
    }));
    const applied = effectiveMotion(this.config);
    logLine(`setMotion: mode=${applied.mode} durationScale=${String(applied.durationScale)} spatialSplit=${String(applied.spatialSplit)} quantize=${String(applied.quantize)} reduced=${applied.reduced} scroll=${String(applied.scroll)} stream=${String(applied.stream)}`);
    return applied;
  }
  /**
   * Write one configuration change through the config editor, logging the
   * failure before it reaches the caller.
   * @param change - derives the next raw config from the current one.
   */
  async persist(change) {
    const { entry, editor } = this;
    if (entry === void 0 || editor === void 0) {
      throw new Error("ui-experience: the plugin entry or the config editor is unavailable; configuration cannot be saved in this profile");
    }
    try {
      await editor.edit(entry, change);
    } catch (error) {
      logLine(`config edit FAILED: ${error.stack ?? error.message}`);
      throw error;
    }
  }
};
Object.defineProperty(UiExperienceService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: "poll", invocation: Object.freeze({ kind: "direct" }) }),
      Object.freeze({ method: "setActive", invocation: Object.freeze({ kind: "direct" }) }),
      Object.freeze({ method: "setPaths", invocation: Object.freeze({ kind: "direct" }) }),
      Object.freeze({ method: "setMotion", invocation: Object.freeze({ kind: "direct" }) })
    ])
  })
});
var inject = ["configEditor"];
function apply(ctx, config) {
  logLine(`apply: active=${String(config.active.get())} borderWidth=${config.borderWidth.get()} colorsPath=${config.colorsPath.get()} tokensPath=${config.tokensPath.get()} motion=${config.motion.get()} durationScale=${String(config.motionDurationScale.get())}`);
  try {
    new UiExperienceService(ctx, config, ctx.fiber.entry, ctx.configEditor);
  } catch (error) {
    console.error(`[ui-experience] failed to register host service: ${error.message}`);
    throw error;
  }
  ctx.on("webserver/index-inject", (table) => {
    if (!config.active.get()) return;
    const read = readPaletteSync(config);
    if (!read.ok) {
      logLine(`boot paint skipped: ${read.message}`);
      return;
    }
    table.push(...bootRows(read.palette));
  });
}
export {
  Config,
  apply,
  inject
};
