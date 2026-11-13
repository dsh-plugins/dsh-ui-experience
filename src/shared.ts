/**
 * Shared protocol between the host and client halves of the UI experience
 * bundle: the Remote service namespace, the configuration defaults, and the
 * poll payload shapes. Both halves import this file; the client build must
 * keep it free of Node and DSH package imports.
 */

/** Cordis service key and wire namespace of the host-side Remote service. */
export const REMOTE_SERVICE = 'uiExperience'

/**
 * Attribute the host's boot script sets on `<html>` while the palette is
 * active, and the client drops when the user turns the switch off. The boot
 * CSS is scoped by it, so removing it restores the built-in boot paint.
 */
export const BOOT_ATTRIBUTE = 'data-dsh-uix-matugen'

/** Default matugen colors file, written by the user's quickshell setup. */
export const DEFAULT_COLORS_PATH = '~/.local/state/quickshell/user/generated/colors.json'

/** Default pre-mapped DSH token file; its tokens layer over the colors file mapping. */
export const DEFAULT_TOKENS_PATH = '~/.local/state/quickshell/user/generated/dsh-tokens.json'

/** DSW token overrides for one palette mode. */
export type ThemeTokenTable = Record<string, string>

/** Token overrides split by palette mode, as `theme.overrideTokens` requires. */
export interface ThemeTokenModes {
  light: ThemeTokenTable
  dark: ThemeTokenTable
}

/** The palette paths in effect, exactly as configured (before `~` expansion). */
export interface PalettePaths {
  colors: string
  tokens: string
}

/** Arguments of the poll endpoint: the caller's last seen palette version. */
export interface PollArgs {
  known?: string
}

/**
 * Result of the poll endpoint. `active`, `borderWidth`, and `paths` ride every
 * response, so a configuration-only edit reaches the client without waiting
 * for a matugen regeneration.
 */
export type PollResult =
  | {
    status: 'ok'
    changed: boolean
    version: string
    tokens?: ThemeTokenModes
    source: string
    active: boolean
    borderWidth: string
    paths: PalettePaths
  }
  | {
    status: 'missing' | 'error'
    message: string
    active: boolean
    borderWidth: string
    paths: PalettePaths
  }

/** Arguments of the setActive endpoint. */
export interface SetActiveArgs {
  active?: boolean
}

/** Result of the setActive endpoint. */
export interface SetActiveResult {
  active: boolean
}

/** Arguments of the setPaths endpoint; an omitted field keeps its value. */
export interface SetPathsArgs {
  colorsPath?: string
  tokensPath?: string
}

/** Result of the setPaths endpoint: the paths now in effect. */
export interface SetPathsResult {
  paths: PalettePaths
}
