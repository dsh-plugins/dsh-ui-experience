"use strict";
(() => {
  // src/shared.ts
  var REMOTE_SERVICE = "uiExperience";

  // src/client.ts
  var SOURCE = "@local/dsh-ui-experience";
  var POLL_MS = 2e3;
  function uiExperienceRemoteContribution(zod) {
    const argCodec = (name, schema) => ({
      mode: "strict",
      typeSymbol: `${SOURCE}/shared#${name}`,
      create: schema
    });
    const resultCodec = (name) => ({
      mode: "strict",
      typeSymbol: `${SOURCE}/shared#${name}`,
      create: () => zod.object({})
    });
    const descriptor = (method) => {
      const name = method === "poll" ? "PollArgs" : "SetActiveArgs";
      const field = method === "poll" ? { known: zod.number().optional() } : { active: zod.boolean().optional() };
      return {
        id: `${SOURCE}#${REMOTE_SERVICE}/${method}`,
        service: REMOTE_SERVICE,
        namespace: REMOTE_SERVICE,
        method,
        invocation: { kind: "direct" },
        parameters: [{
          name: "args",
          wire: "args",
          source: "json",
          codec: argCodec(name, () => zod.object(field)),
          strictCodec: argCodec(name, () => zod.strictObject(field))
        }],
        result: resultCodec(method === "poll" ? "PollResult" : "SetActiveResult")
      };
    };
    return { package: SOURCE, descriptors: [descriptor("poll"), descriptor("setActive")] };
  }
  var DICTS = {
    zh: {
      "palette.title": "Matugen \u914D\u8272\u8DDF\u968F",
      "palette.description": "\u5C06\u7CFB\u7EDF matugen \u751F\u6210\u7684 Material You \u914D\u8272\u53E0\u52A0\u5728\u5F53\u524D\u4E3B\u9898\u4E0A",
      "palette.unavailable": "\u672A\u627E\u5230 matugen \u989C\u8272\u6587\u4EF6",
      "palette.persist-failed": "\u5F00\u5173\u72B6\u6001\u4FDD\u5B58\u5931\u8D25"
    },
    en: {
      "palette.title": "Matugen palette sync",
      "palette.description": "Overlay the system matugen Material You palette on the current theme",
      "palette.unavailable": "matugen colors file not found",
      "palette.persist-failed": "Failed to persist the switch state"
    }
  };
  var CSS = `
.dsh-uix-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dsh-uix-title{font-size:14px;line-height:20px}
.dsh-uix-desc{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-uix-error{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
`;
  function registerClient() {
    window.__ModuleLoader__.load({
      id: SOURCE,
      factory(require2) {
        const React = require2("react");
        const zod = require2("zod");
        const primitives = require2("@deepseek-ai/dsh-client-ui-primitives");
        const h = React.createElement;
        function run(registry, ctx, gateway) {
          ctx.effect(() => ctx.locale.register("ui-experience", DICTS), "ui-experience: dictionaries");
          ctx.effect(() => {
            const sheet = document.createElement("style");
            sheet.textContent = CSS;
            document.head.appendChild(sheet);
            return () => {
              sheet.remove();
            };
          }, "ui-experience: row styles");
          const t = ctx.locale.bind("ui-experience");
          let known = -1;
          let on = false;
          let borderWidth = "";
          let disposeOverride;
          let borderSheet;
          const listeners = /* @__PURE__ */ new Set();
          const setOn = (next) => {
            if (on === next) return;
            on = next;
            for (const listener of listeners) listener(next);
          };
          const toOverrides = (modes) => {
            const out = {};
            for (const token of Object.keys(modes.dark)) {
              const dark = modes.dark[token];
              const light = modes.light[token] ?? dark;
              if (dark === void 0 || light === void 0) continue;
              out[token] = { light, dark };
            }
            return out;
          };
          const applyBorder = (width) => {
            if (width === borderWidth) return;
            borderWidth = width;
            borderSheet?.remove();
            borderSheet = document.createElement("style");
            borderSheet.textContent = `body *{border-width:${width} !important}`;
            document.head.appendChild(borderSheet);
          };
          const applyPalette = (answer) => {
            disposeOverride?.();
            disposeOverride = registry.overrideTokens(SOURCE, toOverrides(answer.tokens));
            applyBorder(answer.borderWidth);
          };
          const teardown = () => {
            disposeOverride?.();
            disposeOverride = void 0;
            borderWidth = "";
            borderSheet?.remove();
            borderSheet = void 0;
          };
          const unwrap = (raw) => {
            const envelope = raw;
            if (envelope.ok === false) throw new Error(envelope.error?.message ?? "remote call failed");
            return envelope.value;
          };
          let bootstrapped = false;
          let lastProblem;
          const poll = async () => {
            let answer;
            try {
              answer = unwrap(await gateway.poll({ known }));
            } catch (error) {
              console.error(`ui-experience: poll RPC failed: ${error.message}`);
              return;
            }
            if (!bootstrapped) {
              bootstrapped = true;
              setOn(answer.active === true);
            } else if (on && answer.active !== true) {
              setOn(false);
              teardown();
            }
            if ("error" in answer || "missing" in answer) {
              const problem = "error" in answer ? answer.error : "matugen colors file missing";
              if (problem !== lastProblem) {
                lastProblem = problem;
                console.error(`ui-experience: palette unavailable: ${problem}`);
              }
              return;
            }
            lastProblem = void 0;
            if (answer.changed === true) {
              known = answer.version;
              if (on) applyPalette(answer);
            } else if (on) {
              applyBorder(answer.borderWidth);
            }
          };
          ctx.effect(() => ctx.timer.interval(() => {
            void poll();
          }, POLL_MS), "ui-experience: palette polling");
          ctx.effect(() => teardown, "ui-experience: palette override");
          void poll();
          let toggling = false;
          function PaletteRow() {
            const [enabled, setEnabled] = React.useState(on);
            const [busy, setBusy] = React.useState(false);
            const [error, setError] = React.useState(null);
            React.useEffect(() => {
              listeners.add(setEnabled);
              return () => {
                listeners.delete(setEnabled);
              };
            }, []);
            const toggle = () => {
              if (toggling) return;
              toggling = true;
              setBusy(true);
              void (async () => {
                try {
                  if (on) {
                    setOn(false);
                    teardown();
                    setError(null);
                    try {
                      unwrap(await gateway.setActive({ active: false }));
                    } catch (rpcError) {
                      console.error(`ui-experience: failed to persist deactivation: ${rpcError.message}`);
                      setError(`${t("palette.persist-failed")}: ${rpcError.message}`);
                    }
                    return;
                  }
                  let answer;
                  try {
                    answer = unwrap(await gateway.poll({ known: -1 }));
                  } catch (rpcError) {
                    console.error(`ui-experience: activation poll failed: ${rpcError.message}`);
                    setError(`${t("palette.unavailable")}: ${rpcError.message}`);
                    return;
                  }
                  if ("error" in answer || "missing" in answer || answer.changed !== true) {
                    setError(t("palette.unavailable"));
                    return;
                  }
                  setError(null);
                  known = answer.version;
                  bootstrapped = true;
                  setOn(true);
                  applyPalette(answer);
                  try {
                    unwrap(await gateway.setActive({ active: true }));
                  } catch (rpcError) {
                    console.error(`ui-experience: failed to persist activation: ${rpcError.message}`);
                    setError(`${t("palette.persist-failed")}: ${rpcError.message}`);
                  }
                } finally {
                  toggling = false;
                  setBusy(false);
                }
              })();
            };
            return h(
              "div",
              { className: "dsh-uix-row" },
              h(
                "div",
                null,
                h("div", { className: "dsh-uix-title" }, t("palette.title")),
                h("div", { className: "dsh-uix-desc" }, t("palette.description")),
                error !== null ? h("div", { className: "dsh-uix-error", role: "alert" }, error) : null
              ),
              h(primitives.Switch, { checked: enabled, disabled: busy, label: t("palette.title"), onChange: () => {
                toggle();
              } })
            );
          }
          ctx.effect(() => ctx.slots.register({
            name: "settings.general.item",
            id: "ui-experience.palette",
            order: 10.5
          }, PaletteRow), "ui-experience: settings row");
        }
        return {
          inject: ["slots", "locale", "timer", "theme", "remote"],
          async apply(ctx) {
            const theme = ctx.get("theme");
            if (theme === void 0) {
              console.error("ui-experience: ctx.theme is unavailable; the bundle cannot apply palettes");
              return;
            }
            const registry = theme;
            const unmount = await ctx.remote.$mount(uiExperienceRemoteContribution(zod));
            ctx.effect(() => () => {
              void unmount();
            }, "ui-experience: remote namespace");
            const gateway = ctx.get(`remote.${REMOTE_SERVICE}`);
            if (gateway === void 0) {
              console.error("ui-experience: the remote namespace was not installed after mounting the contribution");
              return;
            }
            run(registry, ctx, gateway);
          }
        };
      }
    });
  }
  registerClient();
})();
