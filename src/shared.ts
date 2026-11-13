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

/**
 * Attribute the client sets on `<html>` while the motion layer is rewriting
 * rules, so a page-wide style probe or a screenshot harness can tell whether a
 * curve came from this bundle or from the shipped sheet.
 */
export const MOTION_ATTRIBUTE = 'data-dsh-uix-motion'

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

/** Motion curve family. `off` leaves every shipped declaration untouched. */
export type MotionMode = 'off' | 'm3' | 'm3e'

/** Which reduced-motion policy the layer follows. */
export type MotionReduced = 'system' | 'always'

/** Every knob of the motion layer, as the client needs it. */
export interface MotionSettings {
  mode: MotionMode
  /** Multiplier applied to every rewritten literal duration. */
  durationScale: number
  /** Whether spatial and effects transitions take different curves. */
  spatialSplit: boolean
  /** Whether rewritten durations snap onto the Material duration ladder. */
  quantize: boolean
  reduced: MotionReduced
}

/** A motion layer that already did nothing; the client compares against it. */
export const MOTION_OFF: MotionSettings = {
  mode: 'off',
  durationScale: 1,
  spatialSplit: true,
  quantize: false,
  reduced: 'system',
}

/** Arguments of the poll endpoint: the caller's last seen palette version. */
export interface PollArgs {
  known?: string
}

/**
 * Result of the poll endpoint. `active`, `borderWidth`, `paths`, and `motion`
 * ride every response, so a configuration-only edit reaches the client without
 * waiting for a matugen regeneration.
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
    motion: MotionSettings
  }
  | {
    status: 'missing' | 'error'
    message: string
    active: boolean
    borderWidth: string
    paths: PalettePaths
    motion: MotionSettings
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

/** Arguments of the setMotion endpoint; an omitted field keeps its value. */
export interface SetMotionArgs {
  mode?: MotionMode
  durationScale?: number
  spatialSplit?: boolean
  quantize?: boolean
  reduced?: MotionReduced
}

/** Result of the setMotion endpoint: the settings now in effect. */
export type SetMotionResult = MotionSettings
