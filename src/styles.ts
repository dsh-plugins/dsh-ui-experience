/**
 * Row stylesheet. Every rule below is copied from the host control this row sits
 * beside, because a client bundle may not import a Harness Client package as a
 * module — see `practices.md` in the DSH documentation skill: such packages
 * "change without notice, and a throwing component blanks your slot entry", so
 * the instruction is to "write your own controls" and copy "markup, CSS, and
 * behavior from the primitive's `src/*.tsx` and `*.module.css`".
 *
 * Why copying rather than importing: a third-party bundle resolves those
 * packages only through the web shell's hard-coded module table. A renamed,
 * split, or removed entry makes `require` throw, and because the exception is
 * raised inside a slot component the whole settings row disappears. Copied
 * styles can only drift visually on a redesign; the row keeps working.
 *
 * STYLE BASELINE: DSH 0.2.2-rc.2, from
 * `@deepseek-ai/dsh-client-ui-primitives@0.2.2-rc.2` and the shipped client
 * packages. Each group names the exact source file and rule it mirrors. When
 * upgrading DSH, diff those sources against this file; token values
 * (`--dsw-*`) stay stable across releases, literal lengths may not.
 */
export const ROW_CSS = `
/* Row chrome: AppearanceRow.module.css .group — 16/0 padding, hairline
   separator, column gap 8 (the section column strips the last separator). */
.dsh-uix-row{display:flex;flex-direction:column;gap:8px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dsh-uix-head{display:flex;align-items:center;justify-content:space-between;gap:24px}
.dsh-uix-text{display:flex;flex-direction:column;gap:4px;min-width:0}

/* Title and description: FontSizeRow.module.css .title / .desc —
   14/400/22 label-primary and 12/400/18 label-tertiary. */
.dsh-uix-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-uix-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}

/* Feedback lines: ConfigField.module.css .field p — 12px, no margin. The
   success line reuses the same metrics with the success token. */
.dsh-uix-problem{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.dsh-uix-notice{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-success-primary)}

/* Disclosure target: sized like the field label it introduces, with the
   shared hover wash and focus ring instead of a colour-only affordance. */
/* Disclosure: FontSizeRow.module.css .expander — a 24px icon button whose
   chevron rotates 180deg while expanded, beside the label text. */
.dsh-uix-disclosure{display:inline-flex;align-items:center;gap:4px;align-self:flex-start;margin-top:4px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:1.5;cursor:pointer}
.dsh-uix-disclosure:hover{color:var(--dsw-alias-label-secondary)}
.dsh-uix-disclosure:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.dsh-uix-disclosure-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:var(--dsw-radius-xs)}
.dsh-uix-disclosure:hover .dsh-uix-disclosure-icon{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-uix-disclosure-icon svg{transition:transform 150ms ease}
.dsh-uix-disclosure[aria-expanded=true] .dsh-uix-disclosure-icon svg{transform:rotate(180deg)}

/* Path fields: ConfigField.module.css .field, .field + .field, .head label,
   and .field input. The input is sized by padding, not a fixed height. */
.dsh-uix-form{display:flex;flex-direction:column}
.dsh-uix-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dsh-uix-field+.dsh-uix-field{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsh-uix-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
/* Input primitive: Input.module.css .wrap / .input / placeholder — the
   wrapper owns the 32px box and the border, the inner input is transparent.
   The same page's font-family fields render through this primitive. */
.dsh-uix-input-wrap{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;height:32px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dsh-uix-input-wrap:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.dsh-uix-input{flex:1;min-width:0;border:none;outline:none;background:transparent;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-uix-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dsh-uix-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}

/* Form footer and its save action: the configuration form's footer and save
   button (13px, 5/14 padding, radius md, inverted fill). */
.dsh-uix-footer{display:flex;align-items:center;gap:8px;padding-top:16px}
.dsh-uix-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-uix-save:disabled{cursor:not-allowed;opacity:.4}

/* Secondary action: primitives Button.module.css .outline — inset hairline
   that keeps its width independent of the border, plus the shared wash. */
.dsh-uix-reset{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;border:0.5px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 var(--dsh-hairline-width,0.5px) var(--dsh-button-outline-color,var(--dsw-alias-border-l3))}
.dsh-uix-reset:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-uix-reset:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dsh-uix-reset:disabled{cursor:not-allowed;opacity:.4}
.dsh-uix-save:focus-visible,.dsh-uix-reset:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:2px}

/* Switch: Switch.module.css — 36x20 track, 2px inset, 16px thumb, keyed off
   aria-checked so the visual state cannot disagree with assistive technology.
   corner-shape opts the capsule and the thumb out of the superellipse. */
.dsh-uix-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}
.dsh-uix-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.dsh-uix-switch:disabled{cursor:default;opacity:.5}
.dsh-uix-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-uix-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.dsh-uix-switch[aria-checked=false] .dsh-uix-switch-thumb{background:var(--dsw-alias-switch-thumb)}
.dsh-uix-switch[aria-checked=true] .dsh-uix-switch-thumb{transform:translate(16px)}

/* A labelled control line: the caption column and the control that follows it,
   mirroring the settings form's label/control pairing. */
.dsh-uix-choice{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.dsh-uix-choice-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}

/* Segmented control: SegmentedControl.module.css .control / .indicator / .tab —
   a hover-wash track holding one sliding pill. The indicator is placed
   arithmetically from the segment count and index carried as custom properties,
   so nothing measures the DOM. */
.dsh-uix-segment{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-uix-segment-indicator{position:absolute;top:4px;left:4px;width:calc((100% - 8px - 2px * (var(--dsh-segment-count) - 1)) / var(--dsh-segment-count));height:calc(100% - 8px);border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);transform:translateX(calc(var(--dsh-segment-index) * (100% + 2px)));transition:transform 160ms ease;pointer-events:none}
.dsh-uix-segment-tab{box-sizing:border-box;position:relative;z-index:1;height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer;transition:color 120ms ease}
.dsh-uix-segment-tab[aria-selected=true]{color:var(--dsw-alias-label-primary)}
.dsh-uix-segment-tab:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsh-uix-segment-tab:disabled{cursor:default;opacity:.4}
.dsh-uix-segment-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}

/* Boolean option row: DeveloperToolsRow.module.css .row / .title / .description —
   the title column takes the width, the switch sits at the inline end. The copied
   Switch above is the same control, so an option row and the row above it match. */
.dsh-uix-option{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0}
.dsh-uix-option+.dsh-uix-option{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsh-uix-option-text{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-uix-option-title{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-uix-option-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
`
