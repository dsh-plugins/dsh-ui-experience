"use strict";
(() => {
  // src/shared.ts
  var REMOTE_SERVICE = "uiExperience";
  var BOOT_ATTRIBUTE = "data-dsh-uix-matugen";
  var DEFAULT_COLORS_PATH = "~/.local/state/quickshell/user/generated/colors.json";
  var DEFAULT_TOKENS_PATH = "~/.local/state/quickshell/user/generated/dsh-tokens.json";

  // src/styles.ts
  var ROW_CSS = `
/* Row chrome: AppearanceRow.module.css .group \u2014 16/0 padding, hairline
   separator, column gap 8 (the section column strips the last separator). */
.dsh-uix-row{display:flex;flex-direction:column;gap:8px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dsh-uix-head{display:flex;align-items:center;justify-content:space-between;gap:24px}
.dsh-uix-text{display:flex;flex-direction:column;gap:4px;min-width:0}

/* Title and description: FontSizeRow.module.css .title / .desc \u2014
   14/400/22 label-primary and 12/400/18 label-tertiary. */
.dsh-uix-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-uix-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}

/* Feedback lines: ConfigField.module.css .field p \u2014 12px, no margin. The
   success line reuses the same metrics with the success token. */
.dsh-uix-problem{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.dsh-uix-notice{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-success-primary)}

/* Disclosure target: sized like the field label it introduces, with the
   shared hover wash and focus ring instead of a colour-only affordance. */
.dsh-uix-disclosure{align-self:flex-start;padding:2px 6px 2px 0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.5;cursor:pointer}
.dsh-uix-disclosure:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-uix-disclosure:active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-uix-disclosure:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:2px}

/* Path fields: ConfigField.module.css .field, .field + .field, .head label,
   and .field input. The input is sized by padding, not a fixed height. */
.dsh-uix-form{display:flex;flex-direction:column}
.dsh-uix-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dsh-uix-field+.dsh-uix-field{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsh-uix-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-uix-input{padding:6px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit}
.dsh-uix-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-uix-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dsh-uix-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}

/* Form footer and its save action: the configuration form's footer and save
   button (13px, 5/14 padding, radius md, inverted fill). */
.dsh-uix-footer{display:flex;align-items:center;gap:8px;padding-top:16px}
.dsh-uix-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-uix-save:disabled{cursor:not-allowed;opacity:.4}

/* Secondary action: primitives Button.module.css .outline \u2014 inset hairline
   that keeps its width independent of the border, plus the shared wash. */
.dsh-uix-reset{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;border:0.5px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 var(--dsh-hairline-width,0.5px) var(--dsh-button-outline-color,var(--dsw-alias-border-l3))}
.dsh-uix-reset:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-uix-reset:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dsh-uix-reset:disabled{cursor:not-allowed;opacity:.4}
.dsh-uix-save:focus-visible,.dsh-uix-reset:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:2px}

/* Switch: Switch.module.css \u2014 36x20 track, 2px inset, 16px thumb, keyed off
   aria-checked so the visual state cannot disagree with assistive technology.
   corner-shape opts the capsule and the thumb out of the superellipse. */
.dsh-uix-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}
.dsh-uix-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.dsh-uix-switch:disabled{cursor:default;opacity:.5}
.dsh-uix-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-uix-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.dsh-uix-switch[aria-checked=false] .dsh-uix-switch-thumb{background:var(--dsw-alias-switch-thumb)}
.dsh-uix-switch[aria-checked=true] .dsh-uix-switch-thumb{transform:translate(16px)}
`;

  // src/client.ts
  var SOURCE = "@dsh-plugin/dsh-ui-experience";
  var POLL_MS = 2e3;
  var IDLE_TICKS = 15;
  var BORDER_WIDTH = /^(?:0|[0-9]+(?:\.[0-9]+)?(?:px|rem|em))$/;
  function uiExperienceRemoteContribution(zod) {
    const codec = (name, schema) => ({
      mode: "strict",
      typeSymbol: `${SOURCE}/shared#${name}`,
      create: schema
    });
    const descriptor = (method, shape, typeName) => ({
      id: `${SOURCE}#${REMOTE_SERVICE}/${method}`,
      service: REMOTE_SERVICE,
      namespace: REMOTE_SERVICE,
      method,
      invocation: { kind: "direct" },
      parameters: [{
        name: "args",
        wire: "args",
        source: "json",
        codec: codec(typeName, () => zod.object(shape())),
        strictCodec: codec(typeName, () => zod.strictObject(shape()))
      }],
      result: codec(`${method}Result`, () => zod.object({}))
    });
    return {
      package: SOURCE,
      descriptors: [
        descriptor("poll", () => ({ known: zod.string().optional() }), "PollArgs"),
        descriptor("setActive", () => ({ active: zod.boolean().optional() }), "SetActiveArgs"),
        descriptor("setPaths", () => ({ colorsPath: zod.string().optional(), tokensPath: zod.string().optional() }), "SetPathsArgs")
      ]
    };
  }
  var DICTS = {
    zh: {
      "palette.title": "Matugen \u914D\u8272\u8DDF\u968F",
      "palette.description": "\u5C06\u7CFB\u7EDF matugen \u751F\u6210\u7684 Material You \u914D\u8272\u53E0\u52A0\u5728\u5F53\u524D\u4E3B\u9898\u4E0A\uFF0C\u914D\u8272\u6587\u4EF6\u91CD\u65B0\u751F\u6210\u540E\u81EA\u52A8\u8DDF\u968F",
      "palette.persist-failed": "\u5F00\u5173\u72B6\u6001\u4FDD\u5B58\u5931\u8D25",
      "palette.save-failed": "\u8DEF\u5F84\u4FDD\u5B58\u5931\u8D25",
      "palette.saved": "\u5DF2\u4FDD\u5B58",
      "palette.paths": "\u914D\u8272\u6587\u4EF6\u8DEF\u5F84",
      "palette.colors-path": "matugen \u989C\u8272\u6587\u4EF6",
      "palette.tokens-path": "DSH \u4EE4\u724C\u6587\u4EF6\uFF08\u5B58\u5728\u65F6\u4F18\u5148\uFF09",
      "palette.save": "\u4FDD\u5B58",
      "palette.reset": "\u6062\u590D\u9ED8\u8BA4",
      "palette.paths-hint": "\u652F\u6301\u4EE5 ~ \u5F00\u5934\u7684\u8DEF\u5F84\uFF0C\u6216\u7EDD\u5BF9\u8DEF\u5F84\u3002\u4EE4\u724C\u6587\u4EF6\u5B58\u5728\u65F6\u4F18\u5148\u4F7F\u7528\uFF0C\u5426\u5219\u8BFB\u53D6\u989C\u8272\u6587\u4EF6\u5E76\u6620\u5C04\u3002"
    },
    en: {
      "palette.title": "Matugen palette sync",
      "palette.description": "Overlay the system matugen Material You palette on the current theme; follows the file when matugen regenerates it",
      "palette.persist-failed": "Failed to save the switch state",
      "palette.save-failed": "Failed to save the paths",
      "palette.saved": "Saved",
      "palette.paths": "Palette file paths",
      "palette.colors-path": "matugen colors file",
      "palette.tokens-path": "DSH token file (preferred when present)",
      "palette.save": "Save",
      "palette.reset": "Restore defaults",
      "palette.paths-hint": "Paths may start with ~, or be absolute. The token file wins when it exists; otherwise the colors file is read and mapped."
    }
  };
  function registerClient() {
    window.__ModuleLoader__.load({
      id: SOURCE,
      factory(require2) {
        const React = require2("react");
        const zod = require2("zod");
        const h = React.createElement;
        function run(ctx, gateway) {
          const t = ctx.locale.bind("ui-experience");
          ctx.effect(() => ctx.locale.register("ui-experience", DICTS), "ui-experience: dictionaries");
          ctx.effect(() => {
            const sheet = document.createElement("style");
            sheet.textContent = ROW_CSS;
            document.head.appendChild(sheet);
            return () => {
              sheet.remove();
            };
          }, "ui-experience: row styles");
          let disposed = false;
          let known;
          let bootstrapped = false;
          let writing = false;
          let inflight = false;
          let idleTick = 0;
          let lastRpcProblem = "";
          let lastPaletteProblem = "";
          let paintedWidth = "";
          let disposeOverride;
          let borderSheet;
          let mountedOn;
          let mountedVersion;
          let remounting = false;
          const registryNow = () => ctx.get("theme") ?? mountedOn;
          let view = {
            active: false,
            borderWidth: "0.5px",
            paths: { colors: DEFAULT_COLORS_PATH, tokens: DEFAULT_TOKENS_PATH },
            problem: "",
            notice: "",
            saving: false
          };
          const listeners = /* @__PURE__ */ new Set();
          const publish = (patch) => {
            view = { ...view, ...patch };
            for (const listener of listeners) listener();
          };
          const toOverrides = (modes) => {
            const out = {};
            for (const [token, dark] of Object.entries(modes.dark)) {
              const light = modes.light[token] ?? dark;
              if (typeof light === "string" && light !== "") out[token] = { light, dark };
            }
            return out;
          };
          const clearOverride = () => {
            disposeOverride?.();
            disposeOverride = void 0;
            mountedOn = void 0;
            mountedVersion = void 0;
          };
          const applyPalette = (modes, version) => {
            if (disposed) return;
            const registry = registryNow();
            if (registry === void 0) {
              publish({ problem: "theme service is unavailable; palette not applied" });
              return;
            }
            clearOverride();
            try {
              disposeOverride = registry.overrideTokens(SOURCE, toOverrides(modes));
              mountedOn = registry;
              mountedVersion = version;
            } catch (error) {
              mountedOn = void 0;
              mountedVersion = void 0;
              const message = `theme override rejected: ${error.message}`;
              console.error(`ui-experience: ${message}`);
              publish({ problem: message });
            }
          };
          const needsRemount = (version) => remounting === false && (disposeOverride === void 0 || mountedOn !== registryNow() || mountedVersion !== version);
          const remount = async () => {
            if (disposed || remounting) return;
            remounting = true;
            try {
              const answer = unwrap(await gateway.poll({}));
              if (disposed || answer.status !== "ok" || answer.tokens === void 0) return;
              known = answer.version;
              applyPalette(answer.tokens, answer.version);
              applyBorder(answer.borderWidth);
            } catch (error) {
              const message = error.message;
              if (message !== lastRpcProblem) {
                lastRpcProblem = message;
                console.error(`ui-experience: palette refetch failed: ${message}`);
              }
            } finally {
              remounting = false;
            }
          };
          const applyBorder = (width) => {
            if (disposed) return;
            if (!BORDER_WIDTH.test(width)) {
              const message = `borderWidth ${JSON.stringify(width)} is not a CSS length; borders left untouched`;
              console.error(`ui-experience: ${message}`);
              publish({ problem: message });
              return;
            }
            if (width === paintedWidth) return;
            paintedWidth = width;
            borderSheet?.remove();
            borderSheet = document.createElement("style");
            borderSheet.textContent = `body :where(*:not([data-dsh-uix-keep-border])){border-width:${width} !important}`;
            document.head.appendChild(borderSheet);
          };
          const clearBorder = () => {
            borderSheet?.remove();
            borderSheet = void 0;
            paintedWidth = "";
          };
          const setBootAttribute = (on) => {
            if (on) document.documentElement.setAttribute(BOOT_ATTRIBUTE, "");
            else document.documentElement.removeAttribute(BOOT_ATTRIBUTE);
          };
          const teardown = () => {
            clearOverride();
            clearBorder();
            setBootAttribute(false);
          };
          const unwrap = (raw) => {
            const envelope = raw;
            if (envelope.ok === false) throw new Error(envelope.error?.message ?? "remote call failed");
            return envelope.value;
          };
          const adopt = (answer) => {
            if (answer.paths.colors !== view.paths.colors || answer.paths.tokens !== view.paths.tokens || answer.borderWidth !== view.borderWidth) {
              publish({ paths: answer.paths, borderWidth: answer.borderWidth });
            }
            if (!bootstrapped) {
              bootstrapped = true;
              setBootAttribute(answer.active);
              publish({ active: answer.active });
            } else if (!writing && view.active !== answer.active) {
              publish({ active: answer.active });
              if (answer.active) {
                setBootAttribute(true);
                if (answer.status === "ok" && answer.tokens !== void 0) applyPalette(answer.tokens, answer.version);
                applyBorder(answer.borderWidth);
              } else {
                teardown();
              }
            }
            if (answer.status !== "ok") {
              if (answer.message !== lastPaletteProblem) {
                lastPaletteProblem = answer.message;
                console.error(`ui-experience: palette unavailable: ${answer.message}`);
              }
              publish({ problem: answer.message });
              return;
            }
            if (lastPaletteProblem !== "") {
              lastPaletteProblem = "";
              publish({ problem: "" });
            }
            if (answer.changed) {
              known = answer.version;
              if (view.active && answer.tokens !== void 0) applyPalette(answer.tokens, answer.version);
            } else if (view.active && needsRemount(answer.version)) {
              void remount();
            }
            if (view.active) applyBorder(answer.borderWidth);
          };
          const poll = async () => {
            if (disposed || inflight) return;
            if (bootstrapped && !view.active) {
              idleTick = (idleTick + 1) % IDLE_TICKS;
              if (idleTick !== 0) return;
            } else {
              idleTick = 0;
            }
            inflight = true;
            let answer;
            try {
              answer = unwrap(await gateway.poll({ known }));
            } catch (error) {
              const message = error.message;
              if (message !== lastRpcProblem) {
                lastRpcProblem = message;
                console.error(`ui-experience: poll RPC failed: ${message}`);
              }
              return;
            } finally {
              inflight = false;
            }
            if (disposed) return;
            lastRpcProblem = "";
            adopt(answer);
          };
          const setActive = async (next) => {
            if (disposed || writing) return;
            writing = true;
            publish({ saving: true, problem: "", notice: "" });
            try {
              if (!next) {
                await gateway.setActive({ active: false });
                if (disposed) return;
                publish({ active: false });
                teardown();
                return;
              }
              const answer = unwrap(await gateway.poll({}));
              if (disposed) return;
              if (answer.status !== "ok") {
                publish({ problem: answer.message });
                return;
              }
              const tokens = answer.tokens;
              if (tokens === void 0) throw new Error("poll returned no tokens for an activation request");
              await gateway.setActive({ active: true });
              if (disposed) return;
              known = answer.version;
              bootstrapped = true;
              setBootAttribute(true);
              publish({ active: true, paths: answer.paths, notice: t("palette.saved") });
              applyPalette(tokens, answer.version);
              applyBorder(answer.borderWidth);
            } catch (error) {
              const message = error.message;
              console.error(`ui-experience: failed to save the switch state: ${message}`);
              publish({ problem: `${t("palette.persist-failed")}: ${message}` });
            } finally {
              writing = false;
              publish({ saving: false });
            }
          };
          const savePaths = async (colors, tokens) => {
            if (disposed || writing) return;
            writing = true;
            publish({ saving: true, problem: "", notice: "" });
            try {
              const saved = unwrap(await gateway.setPaths({ colorsPath: colors, tokensPath: tokens }));
              if (disposed) return;
              const probe = unwrap(await gateway.poll({}));
              if (disposed) return;
              known = probe.status === "ok" ? probe.version : void 0;
              publish({
                paths: saved.paths,
                notice: probe.status === "ok" ? t("palette.saved") : "",
                problem: probe.status === "ok" ? "" : probe.message
              });
              if (probe.status === "ok" && view.active && probe.tokens !== void 0) applyPalette(probe.tokens, probe.version);
            } catch (error) {
              const message = error.message;
              console.error(`ui-experience: failed to save the palette paths: ${message}`);
              publish({ problem: `${t("palette.save-failed")}: ${message}` });
            } finally {
              writing = false;
              publish({ saving: false });
            }
          };
          function PaletteRow(props) {
            const tr = props.t ?? t;
            const [state, setState] = React.useState(view);
            const [open, setOpen] = React.useState(false);
            const [colors, setColors] = React.useState(view.paths.colors);
            const [tokens, setTokens] = React.useState(view.paths.tokens);
            React.useEffect(() => {
              const listener = () => {
                setState(view);
              };
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            }, []);
            React.useEffect(() => {
              setColors(state.paths.colors);
              setTokens(state.paths.tokens);
            }, [state.paths]);
            const status = state.problem !== "" ? h("p", { className: "dsh-uix-problem", role: "alert" }, state.problem) : state.notice !== "" ? h("p", { className: "dsh-uix-notice" }, state.notice) : null;
            const field = (label, value, placeholder, set, hint) => h(
              "label",
              { className: "dsh-uix-field" },
              h("span", { className: "dsh-uix-label" }, label),
              h("input", {
                className: "dsh-uix-input",
                type: "text",
                value,
                placeholder,
                spellCheck: false,
                onChange: (event) => {
                  set(event.target.value);
                }
              }),
              hint ?? null
            );
            const editor = open ? h(
              "div",
              { className: "dsh-uix-form" },
              field(tr("palette.colors-path"), colors, DEFAULT_COLORS_PATH, setColors),
              field(
                tr("palette.tokens-path"),
                tokens,
                DEFAULT_TOKENS_PATH,
                setTokens,
                h("p", { className: "dsh-uix-hint" }, tr("palette.paths-hint"))
              ),
              h(
                "div",
                { className: "dsh-uix-footer" },
                h("button", {
                  type: "button",
                  className: "dsh-uix-save",
                  disabled: state.saving,
                  onClick: () => {
                    void savePaths(colors.trim(), tokens.trim());
                  }
                }, tr("palette.save")),
                h("button", {
                  type: "button",
                  className: "dsh-uix-reset",
                  disabled: state.saving,
                  onClick: () => {
                    void savePaths(DEFAULT_COLORS_PATH, DEFAULT_TOKENS_PATH);
                  }
                }, tr("palette.reset"))
              )
            ) : null;
            return h(
              "div",
              { className: "dsh-uix-row" },
              h(
                "div",
                { className: "dsh-uix-head" },
                h(
                  "div",
                  { className: "dsh-uix-text" },
                  h("div", { className: "dsh-uix-title" }, tr("palette.title")),
                  h("div", { className: "dsh-uix-desc" }, tr("palette.description"))
                ),
                h("button", {
                  type: "button",
                  role: "switch",
                  "aria-checked": state.active,
                  "aria-label": tr("palette.title"),
                  disabled: state.saving,
                  className: "dsh-uix-switch",
                  onClick: () => {
                    void setActive(!state.active);
                  }
                }, h("span", { className: "dsh-uix-switch-thumb", "aria-hidden": true }))
              ),
              status,
              h("button", {
                type: "button",
                className: "dsh-uix-disclosure",
                "aria-expanded": open,
                onClick: () => {
                  setOpen(!open);
                }
              }, `${open ? "\u25BE" : "\u25B8"} ${tr("palette.paths")}`),
              editor
            );
          }
          ctx.effect(() => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
            name: "settings.general.item",
            id: "ui-experience.palette",
            order: 10.5,
            locale: "ui-experience"
          }, PaletteRow)), "ui-experience: settings row");
          ctx.effect(() => ctx.timer.interval(() => {
            void poll();
          }, POLL_MS), "ui-experience: palette polling");
          ctx.effect(() => {
            return () => {
              disposed = true;
              teardown();
            };
          }, "ui-experience: palette override");
          void poll();
        }
        return {
          inject: ["slots", "locale", "timer", "theme", "remote"],
          async apply(ctx) {
            const theme = ctx.get("theme");
            if (theme === void 0) {
              console.error("ui-experience: ctx.theme is unavailable; the bundle cannot apply palettes");
              return;
            }
            const unmount = await ctx.remote.$mount(uiExperienceRemoteContribution(zod));
            ctx.effect(() => () => {
              unmount().catch((error) => {
                console.error(`ui-experience: remote unmount failed: ${error.message}`);
              });
            }, "ui-experience: remote namespace");
            const gateway = ctx.get(`remote.${REMOTE_SERVICE}`);
            if (gateway === void 0) {
              console.error("ui-experience: the remote namespace was not installed after mounting the contribution");
              return;
            }
            run(ctx, gateway);
          }
        };
      }
    });
  }
  registerClient();
})();
