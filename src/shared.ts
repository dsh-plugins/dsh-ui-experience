/**
 * Shared protocol between the host and client halves of the UI experience
 * bundle: the Remote service namespace and the poll payload shapes. Both
 * halves import this file; the client build must keep it free of Node and
 * DSH package imports.
 */

/** Cordis service key and wire namespace of the host-side Remote service. */
export const REMOTE_SERVICE = 'uiExperience'

/** DSW token overrides for one palette mode. */
export type ThemeTokenTable = Record<string, string>

/** Token overrides split by palette mode, as `theme.overrideTokens` requires. */
export interface ThemeTokenModes {
  light: ThemeTokenTable
  dark: ThemeTokenTable
}

/** Arguments of the poll endpoint: the caller's last seen palette version. */
export interface PollArgs {
  known?: number
}

/**
 * Result of the poll endpoint. `borderWidth` rides every changed payload and
 * every steady-state payload, so a config-only border edit reaches the client
 * without waiting for a matugen regeneration.
 */
export type PollResult =
  | { changed: true; version: number; tokens: ThemeTokenModes; active: boolean; borderWidth: string }
  | { changed: false; active: boolean; borderWidth: string }
  | { missing: true; active: boolean }
  | { error: string; active: boolean }

/** Arguments of the setActive endpoint. */
export interface SetActiveArgs {
  active?: boolean
}

/** Result of the setActive endpoint. */
export interface SetActiveResult {
  active: boolean
}
