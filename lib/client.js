"use strict";
(() => {
  // src/shared.ts
  var REMOTE_SERVICE = "uiExperience";
  var BOOT_ATTRIBUTE = "data-dsh-uix-matugen";
  var MOTION_ATTRIBUTE = "data-dsh-uix-motion";
  var DEFAULT_COLORS_PATH = "~/.local/state/quickshell/user/generated/colors.json";
  var DEFAULT_TOKENS_PATH = "~/.local/state/quickshell/user/generated/dsh-tokens.json";
  var MOTION_OFF = {
    mode: "off",
    durationScale: 1,
    spatialSplit: true,
    quantize: false,
    reduced: "system",
    scroll: false,
    stream: true,
    followScroll: true,
    streamRevealMinMs: 250,
    streamRevealMaxMs: 1200,
    streamEnterMs: 220,
    streamRollMs: 260
  };

  // src/motion-plan.ts
  var SPATIAL_PROPERTIES = /* @__PURE__ */ new Set([
    "transform",
    "translate",
    "rotate",
    "scale",
    "offset-distance",
    "offset-path",
    "left",
    "right",
    "top",
    "bottom",
    "inset",
    "inset-inline",
    "inset-block",
    "inset-inline-start",
    "inset-inline-end",
    "inset-block-start",
    "inset-block-end",
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "inline-size",
    "block-size",
    "min-inline-size",
    "min-block-size",
    "max-inline-size",
    "max-block-size",
    "flex-basis",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "margin-inline",
    "margin-block",
    "margin-inline-start",
    "margin-inline-end",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "padding-inline",
    "padding-block",
    "padding-inline-start",
    "padding-inline-end",
    "gap",
    "row-gap",
    "column-gap",
    "grid-template-columns",
    "grid-template-rows",
    "grid-auto-columns",
    "grid-auto-rows",
    "border-radius",
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-left-radius",
    "border-bottom-right-radius"
  ]);
  var POINTS_M3_SPATIAL = [0.05, 0.7, 0.1, 1];
  var POINTS_M3_EFFECTS = [0.2, 0, 0, 1];
  var POINTS_M3E_SPATIAL_FAST = [0.42, 1.67, 0.21, 0.9];
  var POINTS_M3E_SPATIAL = [0.38, 1.21, 0.22, 1];
  var POINTS_M3E_EFFECTS = [0.34, 0.8, 0.34, 1];
  var CURVE_M3_SPATIAL = `cubic-bezier(${POINTS_M3_SPATIAL.join(", ")})`;
  var CURVE_M3_EFFECTS = `cubic-bezier(${POINTS_M3_EFFECTS.join(", ")})`;
  var CURVE_M3E_SPATIAL_FAST = `cubic-bezier(${POINTS_M3E_SPATIAL_FAST.join(", ")})`;
  var CURVE_M3E_SPATIAL = `cubic-bezier(${POINTS_M3E_SPATIAL.join(", ")})`;
  var CURVE_M3E_EFFECTS = `cubic-bezier(${POINTS_M3E_EFFECTS.join(", ")})`;
  function effectCurvePoints(mode) {
    return mode === "m3" ? POINTS_M3_EFFECTS : POINTS_M3E_EFFECTS;
  }
  function easeCurve(points, x) {
    const [x1, y1, x2, y2] = points;
    const clamped = Math.min(1, Math.max(0, x));
    let low = 0;
    let high = 1;
    let t = clamped;
    for (let step = 0; step < 24; step += 1) {
      const inverse2 = 1 - t;
      const value = 3 * inverse2 * inverse2 * t * x1 + 3 * inverse2 * t * t * x2 + t * t * t;
      if (Math.abs(value - clamped) < 1e-5) break;
      if (value < clamped) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    const inverse = 1 - t;
    return 3 * inverse * inverse * t * y1 + 3 * inverse * t * t * y2 + t * t * t;
  }
  var FAST_SPATIAL_MAX_MS = 200;
  var MATERIAL_DURATIONS_MS = [
    50,
    100,
    150,
    200,
    250,
    300,
    350,
    400,
    450,
    500,
    550,
    600,
    700,
    800,
    900,
    1e3
  ];
  function splitList(value) {
    if (value.trim() === "") return [];
    const out = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === "(") depth += 1;
      else if (character === ")") depth = Math.max(0, depth - 1);
      else if (character === "," && depth === 0) {
        out.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
    out.push(value.slice(start).trim());
    return out;
  }
  function entryAt(entries, index) {
    if (entries.length === 0) return void 0;
    return entries[index % entries.length];
  }
  var DURATION = /^([0-9]*\.?[0-9]+)(ms|s)$/;
  function parseDurationMs(value) {
    const match = DURATION.exec(value.trim());
    if (match === null) return void 0;
    const amount = Number(match[1]);
    return match[2] === "s" ? amount * 1e3 : amount;
  }
  function quantizeMs(ms) {
    let best = MATERIAL_DURATIONS_MS[0] ?? 50;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const step of MATERIAL_DURATIONS_MS) {
      const distance = Math.abs(step - ms);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = step;
      }
    }
    return best;
  }
  var MAX_DURATION_MS = 1e4;
  var NEGLIGIBLE_MS = 1;
  function retime(value, scale, quantize) {
    if (scale === 1 && !quantize) return void 0;
    const original = parseDurationMs(value);
    if (original === void 0 || original <= NEGLIGIBLE_MS) return void 0;
    const scaled = Math.round(original * scale);
    const target = Math.min(MAX_DURATION_MS, Math.max(NEGLIGIBLE_MS, quantize ? quantizeMs(scaled) : scaled));
    if (target === original) return void 0;
    return `${target}ms`;
  }
  function isDiscrete(value) {
    return /^(?:steps?\(|step-start$|step-end$)/.test(value.trim());
  }
  function classify(property) {
    const name = property.trim().toLowerCase();
    return SPATIAL_PROPERTIES.has(name) ? "spatial" : "effects";
  }
  function classifyAll(properties) {
    for (const property of properties) {
      if (classify(property) === "spatial") return "spatial";
    }
    return "effects";
  }
  function curveFor(mode, domain, spatialSplit, originalMs) {
    if (mode === "m3") {
      return spatialSplit && domain === "spatial" ? CURVE_M3_SPATIAL : CURVE_M3_EFFECTS;
    }
    if (mode === "m3e" && spatialSplit && domain === "spatial") {
      return originalMs !== void 0 && originalMs <= FAST_SPATIAL_MAX_MS ? CURVE_M3E_SPATIAL_FAST : CURVE_M3E_SPATIAL;
    }
    return CURVE_M3E_EFFECTS;
  }

  // src/motion.ts
  var KEYFRAMES_RULE = 7;
  var TRANSITIONS = {
    selector: "transition-property",
    duration: "transition-duration",
    timing: "transition-timing-function"
  };
  var ANIMATIONS = {
    selector: "animation-name",
    duration: "animation-duration",
    timing: "animation-timing-function",
    iterations: "animation-iteration-count",
    timeline: "animation-timeline"
  };
  var DURATION_TOKENS = [
    "--ds-transition-duration",
    "--ds-transition-duration-fast",
    "--ds-transition-duration-slow"
  ];
  function createMotion() {
    const patches = /* @__PURE__ */ new Map();
    const unreadable = /* @__PURE__ */ new Set();
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let settings;
    let reducedSheet;
    let reducedActive = false;
    let observer;
    let mediaListener;
    let refreshPending = false;
    function walk(rules, visit) {
      for (let index = 0; index < rules.length; index += 1) {
        const rule = rules[index];
        if (rule === void 0) continue;
        visit(rule);
        if (rule.cssRules !== void 0) walk(rule.cssRules, visit);
      }
    }
    function readableSheets() {
      const out = [];
      const collect = (sheet) => {
        if (sheet === void 0) return;
        try {
          const rules = sheet.cssRules;
          if (rules === void 0) return;
          out.push(sheet);
        } catch (error) {
          const key = sheet.href ?? "(inline)";
          if (unreadable.has(key)) return;
          unreadable.add(key);
          console.error(`ui-experience: motion cannot read stylesheet ${key}: ${error.message}`);
        }
      };
      for (let index = 0; index < document.styleSheets.length; index += 1) {
        collect(document.styleSheets[index]);
      }
      for (const sheet of document.adoptedStyleSheets ?? []) collect(sheet);
      return out;
    }
    function keyframeProperties(sheets) {
      const frames = /* @__PURE__ */ new Map();
      for (const sheet of sheets) {
        walk(sheet.cssRules, (rule) => {
          if (rule.type !== KEYFRAMES_RULE || rule.name === void 0 || rule.cssRules === void 0) return;
          const properties = frames.get(rule.name) ?? [];
          walk(rule.cssRules, (frame) => {
            const declaration = frame.style;
            if (declaration === void 0) return;
            for (let index = 0; index < declaration.length; index += 1) {
              const name = declaration.item(index);
              if (name !== "" && !properties.includes(name)) properties.push(name);
            }
          });
          frames.set(rule.name, properties);
        });
      }
      return frames;
    }
    function rewriteFamily(declaration, family, frames, active) {
      const selectors = splitList(declaration.getPropertyValue(family.selector));
      const durations = splitList(declaration.getPropertyValue(family.duration));
      const timings = splitList(declaration.getPropertyValue(family.timing));
      const iterations = family.iterations === void 0 ? [] : splitList(declaration.getPropertyValue(family.iterations));
      const timelines = family.timeline === void 0 ? [] : splitList(declaration.getPropertyValue(family.timeline));
      if (selectors.length === 0 && durations.length === 0 && timings.length === 0) return false;
      const count = Math.max(selectors.length, durations.length, timings.length, timelines.length, 1);
      const nextTimings = [];
      const nextDurations = [];
      let timingChanged = false;
      let durationChanged = false;
      for (let index = 0; index < count; index += 1) {
        const selector = entryAt(selectors, index) ?? "all";
        const originalTiming = entryAt(timings, index);
        const originalDuration = entryAt(durations, index);
        const originalMs = originalDuration === void 0 ? void 0 : parseDurationMs(originalDuration);
        const infinite = entryAt(iterations, index) === "infinite";
        const timeline = entryAt(timelines, index);
        const scrollDriven = timeline !== void 0 && timeline !== "auto" && timeline !== "none";
        if (selector === "none" || scrollDriven) {
          if (originalTiming !== void 0) nextTimings.push(originalTiming);
          if (originalDuration !== void 0) nextDurations.push(originalDuration);
          continue;
        }
        const keepTiming = originalTiming !== void 0 && (isDiscrete(originalTiming) || infinite && originalTiming === "linear" || originalMs === 0);
        const domain = infinite ? "effects" : family.selector === "transition-property" ? classify(selector) : classifyAll(frames.get(selector) ?? ["opacity"]);
        const curve = keepTiming && originalTiming !== void 0 ? originalTiming : curveFor(active.mode, domain, active.spatialSplit, originalMs);
        nextTimings.push(curve);
        if (curve !== originalTiming) timingChanged = true;
        if (originalDuration === void 0) continue;
        const retimed = infinite ? void 0 : retime(originalDuration, active.durationScale, active.quantize);
        nextDurations.push(retimed ?? originalDuration);
        if (retimed !== void 0) durationChanged = true;
      }
      let changed = false;
      if (timingChanged) {
        declaration.setProperty(family.timing, nextTimings.join(", "));
        changed = true;
      }
      if (durationChanged) {
        declaration.setProperty(family.duration, nextDurations.join(", "));
        changed = true;
      }
      return changed;
    }
    function scan() {
      if (wantsReduced()) return;
      const active = settings;
      if (active === void 0 || active.mode === "off") return;
      const sheets = readableSheets();
      const frames = keyframeProperties(sheets);
      for (const sheet of sheets) {
        walk(sheet.cssRules, (rule) => {
          const declaration = rule.style;
          if (declaration === void 0 || patches.has(rule)) return;
          const before = declaration.cssText;
          const movedTransition = rewriteFamily(declaration, TRANSITIONS, frames, active);
          const movedAnimation = rewriteFamily(declaration, ANIMATIONS, frames, active);
          if (!movedTransition && !movedAnimation) return;
          patches.set(rule, { declaration, before, after: declaration.cssText });
        });
      }
    }
    function applyDurationTokens() {
      const active = settings;
      if (active === void 0 || active.durationScale === 1) return;
      const root = document.documentElement;
      const computed = window.getComputedStyle(root);
      for (const token of DURATION_TOKENS) {
        const base = parseDurationMs(computed.getPropertyValue(token).trim());
        if (base === void 0) {
          console.error(`ui-experience: motion cannot read ${token}; durations using it keep their shipped value`);
          continue;
        }
        root.style.setProperty(token, `${Math.round(base * active.durationScale)}ms`);
      }
    }
    function clearDurationTokens() {
      for (const token of DURATION_TOKENS) document.documentElement.style.removeProperty(token);
    }
    function wantsReduced() {
      const active = settings;
      if (active === void 0) return false;
      if (active.reduced === "always") return true;
      return active.reduced === "system" && media.matches;
    }
    function setReducedSheet(want) {
      if (want === reducedActive) return;
      reducedActive = want;
      reducedSheet?.remove();
      reducedSheet = void 0;
      if (!want) return;
      const sheet = document.createElement("style");
      sheet.textContent = "*,*::before,*::after{transition-duration:1ms !important;animation-duration:1ms !important;animation-iteration-count:1 !important;scroll-behavior:auto !important}";
      document.head.appendChild(sheet);
      reducedSheet = sheet;
    }
    function realize() {
      const active = settings;
      if (active === void 0 || active.mode === "off") return;
      if (wantsReduced()) {
        observer?.disconnect();
        observer = void 0;
        setReducedSheet(true);
        restoreDeclarations();
        clearDurationTokens();
        return;
      }
      setReducedSheet(false);
      applyDurationTokens();
      scan();
      observer ??= observeDocument();
    }
    function refresh() {
      if (refreshPending) return;
      refreshPending = true;
      queueMicrotask(() => {
        refreshPending = false;
        scan();
      });
    }
    function bringsStylesheet(node) {
      if (node === void 0) return false;
      const name = node.nodeName?.toUpperCase();
      return name === "STYLE" || name === "LINK";
    }
    function observeDocument() {
      const instance = new MutationObserver((records) => {
        for (const record of records) {
          for (let index = 0; index < record.addedNodes.length; index += 1) {
            if (bringsStylesheet(record.addedNodes[index])) {
              refresh();
              return;
            }
          }
        }
      });
      instance.observe(document.head, { childList: true, subtree: true });
      instance.observe(document.body, { childList: true });
      return { disconnect: () => {
        instance.disconnect();
      } };
    }
    function unwatchPreference() {
      if (mediaListener === void 0) return;
      media.removeEventListener("change", mediaListener);
      mediaListener = void 0;
    }
    function watchPreference() {
      if (mediaListener !== void 0) return;
      mediaListener = () => {
        realize();
      };
      media.addEventListener("change", mediaListener);
    }
    function restoreDeclarations() {
      for (const patch of patches.values()) {
        if (patch.declaration.cssText !== patch.after) {
          console.error("ui-experience: motion restore overwrote a declaration that changed after this layer wrote it");
        }
        patch.declaration.cssText = patch.before;
      }
      patches.clear();
    }
    function restore() {
      restoreDeclarations();
      clearDurationTokens();
      setReducedSheet(false);
      unwatchPreference();
      observer?.disconnect();
      observer = void 0;
      settings = void 0;
      document.documentElement.removeAttribute(MOTION_ATTRIBUTE);
    }
    return {
      apply(next) {
        restore();
        settings = next;
        if (next.mode === "off") return;
        watchPreference();
        document.documentElement.setAttribute(MOTION_ATTRIBUTE, next.mode);
        realize();
      },
      restore
    };
  }

  // src/scroll.ts
  var MIN_MS = 180;
  var MAX_MS = 460;
  var FREE_PX = 240;
  var GROWTH_MS_PER_PX = 0.2;
  var MOTION_EPSILON = 0.5;
  var FOREIGN_TOLERANCE = 1;
  var SCROLL_KEYS = /* @__PURE__ */ new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    " "
  ]);
  var EDITABLE = [
    "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=file]):not([type=range])",
    "textarea",
    "select",
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]'
  ].join(", ");
  var JUMP_ANIMATE_MIN = 24;
  var WHEEL_SETTLE_PX = 0.5;
  var PIXELS_PER_LINE = 40;
  var PAGE_FRACTION = 0.875;
  var PAGE_OVERLAP = 40;
  var WHEEL_MAX_MS = 900;
  function scrollDistance(legs) {
    let distance = 0;
    for (const leg of legs) {
      distance = Math.max(distance, Math.abs(leg.toTop - leg.fromTop), Math.abs(leg.toLeft - leg.fromLeft));
    }
    return distance;
  }
  function scrollDurationMs(distance, settings) {
    const grown = MIN_MS + Math.max(0, distance - FREE_PX) * GROWTH_MS_PER_PX;
    const scaled = Math.min(MAX_MS, grown) * settings.durationScale;
    return settings.quantize ? quantizeMs(scaled) : scaled;
  }
  function maxima(element) {
    return {
      top: Math.max(0, element.scrollHeight - element.clientHeight),
      left: Math.max(0, element.scrollWidth - element.clientWidth)
    };
  }
  function containers(element) {
    const out = [];
    let node = element.parentElement;
    while (node !== null) {
      const max = maxima(node);
      if (max.top > 0 || max.left > 0) out.push(node);
      node = node.parentElement;
    }
    return out;
  }
  function createScrollMotion() {
    const shipped = {
      scrollTo: Element.prototype.scrollTo,
      scrollBy: Element.prototype.scrollBy,
      scrollIntoView: Element.prototype.scrollIntoView
    };
    const topAxis = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    const leftAxis = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
    let settings;
    let run;
    let wheel;
    let installed = false;
    let writing = 0;
    const shadowed = /* @__PURE__ */ new WeakMap();
    let dispatching = false;
    const END_GRACE_MS = 400;
    const graceful = /* @__PURE__ */ new Set();
    function writeAxis(element, axis, value) {
      const accessor = axis === "top" ? topAxis : leftAxis;
      if (accessor !== void 0) {
        writing += 1;
        try {
          accessor.set.call(element, value);
        } finally {
          writing -= 1;
        }
        return;
      }
      if (axis === "top") element.scrollTop = value;
      else element.scrollLeft = value;
    }
    function clearGrace() {
      for (const element of graceful) shadowed.delete(element);
      graceful.clear();
    }
    function hold(element) {
      shadowed.set(element, { until: Number.POSITIVE_INFINITY, top: 0, left: 0 });
    }
    function release(element, notify) {
      if (!shadowed.has(element)) return;
      shadowed.set(element, {
        until: performance.now() + END_GRACE_MS,
        top: element.scrollTop,
        left: element.scrollLeft
      });
      graceful.add(element);
      if (!notify) return;
      queueMicrotask(() => {
        if (shadowed.get(element)?.until === Number.POSITIVE_INFINITY) return;
        dispatching = true;
        try {
          element.dispatchEvent(new Event("scrollend"));
        } finally {
          dispatching = false;
        }
      });
    }
    function cancel(notify = true) {
      stopWheel();
      const active = run;
      if (active === void 0) return;
      window.cancelAnimationFrame(active.frame);
      run = void 0;
      for (const leg of active.legs) release(leg.element, notify);
      for (const settle of active.done) settle();
    }
    function step(now) {
      const active = run;
      if (active === void 0) return;
      const elapsed = now - active.started;
      const progress = active.duration <= 0 ? 1 : Math.min(1, elapsed / active.duration);
      const eased = easeCurve(effectCurvePoints(settings.mode), progress);
      for (let index = 0; index < active.legs.length; index += 1) {
        const leg = active.legs[index];
        const written = active.written[index];
        if (leg === void 0 || written === void 0) continue;
        if (Math.abs(leg.element.scrollTop - written.top) > FOREIGN_TOLERANCE || Math.abs(leg.element.scrollLeft - written.left) > FOREIGN_TOLERANCE) {
          cancel();
          return;
        }
      }
      for (const leg of active.legs) {
        const top = progress >= 1 ? leg.toTop : leg.fromTop + (leg.toTop - leg.fromTop) * eased;
        const left = progress >= 1 ? leg.toLeft : leg.fromLeft + (leg.toLeft - leg.fromLeft) * eased;
        if (leg.element.scrollTop !== top) writeAxis(leg.element, "top", top);
        if (leg.element.scrollLeft !== left) writeAxis(leg.element, "left", left);
      }
      for (let index = 0; index < active.legs.length; index += 1) {
        const leg = active.legs[index];
        const written = active.written[index];
        if (leg === void 0 || written === void 0) continue;
        written.top = leg.element.scrollTop;
        written.left = leg.element.scrollLeft;
      }
      if (progress >= 1) {
        run = void 0;
        for (const leg of active.legs) release(leg.element, true);
        for (const settle of active.done) settle();
        return;
      }
      active.frame = window.requestAnimationFrame(step);
    }
    function start(legs, done) {
      cancel();
      const active = settings;
      for (const leg of legs) hold(leg.element);
      run = {
        legs: [...legs],
        started: performance.now(),
        duration: scrollDurationMs(scrollDistance(legs), active),
        written: legs.map((leg) => ({ top: leg.element.scrollTop, left: leg.element.scrollLeft })),
        frame: window.requestAnimationFrame(step),
        done: [done]
      };
    }
    function merge(legs, done) {
      const active = run;
      if (active === void 0) return false;
      if (active.legs.length !== legs.length) return false;
      for (let index = 0; index < legs.length; index += 1) {
        if (active.legs[index]?.element !== legs[index]?.element) return false;
      }
      active.legs = [...legs];
      active.started = performance.now();
      active.duration = scrollDurationMs(scrollDistance(legs), settings);
      active.written = legs.map((leg) => ({ top: leg.element.scrollTop, left: leg.element.scrollLeft }));
      active.done.push(done);
      return true;
    }
    function wantsInstant() {
      const active = settings;
      if (active.reduced === "always") return true;
      return active.reduced === "system" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    const glides = /* @__PURE__ */ new Map();
    const lastWrite = /* @__PURE__ */ new WeakMap();
    const GLIDE_MIN_PX = 4;
    const GLIDE_MAX_PX = 600;
    const GLIDE_MIN_MS = 90;
    const GLIDE_MAX_MS = 300;
    const GLIDE_PX_PER_MS = 1.8;
    const GLIDE_FRAME_GAP_MS = 32;
    const GLIDE_MAX_LAG_PX = 40;
    function shouldGlide(element, value, now) {
      const active = settings;
      if (active === void 0 || !active.followScroll) return false;
      if (wantsInstant()) return false;
      const max = maxima(element);
      if (max.top <= 0) return false;
      const delta = value - topAxis.get.call(element);
      const size = Math.abs(delta);
      if (size < GLIDE_MIN_PX || size > GLIDE_MAX_PX) return false;
      if (delta > 0 && Math.abs(value - max.top) > 4) return false;
      if (max.top - topAxis.get.call(element) > GLIDE_MAX_LAG_PX) return false;
      const previous = lastWrite.get(element);
      lastWrite.set(element, now);
      if (previous !== void 0 && now - previous < GLIDE_FRAME_GAP_MS) return false;
      return true;
    }
    function startGlide(element, target) {
      const active = settings;
      const existing = glides.get(element);
      if (existing !== void 0) window.cancelAnimationFrame(existing.frame);
      else hold(element);
      const from = topAxis.get.call(element);
      const raw = Math.abs(target - from) / GLIDE_PX_PER_MS;
      const duration = Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, raw)) * active.durationScale;
      const glide = {
        target,
        from,
        started: performance.now(),
        duration: active.quantize ? quantizeMs(duration) : duration,
        frame: 0,
        written: from
      };
      glides.set(element, glide);
      const mode = active.mode;
      const step2 = (now) => {
        const live = glides.get(element);
        if (live !== glide) return;
        if (Math.abs(topAxis.get.call(element) - glide.written) > 1) {
          finishGlide(element, false);
          return;
        }
        const progress = Math.min(1, (now - glide.started) / Math.max(1, glide.duration));
        const eased = easeCurve(effectCurvePoints(mode), progress);
        writeAxis(element, "top", glide.from + (glide.target - glide.from) * eased);
        glide.written = topAxis.get.call(element);
        if (progress >= 1) {
          finishGlide(element, true);
          return;
        }
        glide.frame = window.requestAnimationFrame(step2);
      };
      glide.frame = window.requestAnimationFrame(step2);
    }
    function finishGlide(element, landed) {
      const glide = glides.get(element);
      if (glide === void 0) return;
      window.cancelAnimationFrame(glide.frame);
      glides.delete(element);
      if (landed) writeAxis(element, "top", glide.target);
      release(element, true);
    }
    function finishGlides() {
      for (const [element] of glides) finishGlide(element, true);
    }
    function stopWheel() {
      const active = wheel;
      if (active === void 0) return;
      window.cancelAnimationFrame(active.frame);
      wheel = void 0;
      release(active.element, true);
    }
    function wheelStep(now) {
      const active = wheel;
      if (active === void 0) return;
      const element = active.element;
      const progress = active.duration <= 0 ? 1 : Math.min(1, (now - active.started) / active.duration);
      const eased = easeCurve(effectCurvePoints(settings.mode), progress);
      if (progress >= 1) {
        writeAxis(element, "top", active.top);
        writeAxis(element, "left", active.left);
        wheel = void 0;
        release(element, true);
        return;
      }
      writeAxis(element, "top", active.fromTop + (active.top - active.fromTop) * eased);
      writeAxis(element, "left", active.fromLeft + (active.left - active.fromLeft) * eased);
      active.frame = window.requestAnimationFrame(wheelStep);
    }
    function onWheel(event) {
      const active = settings;
      if (active === void 0) return false;
      if (event.ctrlKey || event.metaKey) return false;
      if (wantsInstant()) return false;
      const target = event.target;
      if (target === null) return false;
      if (target instanceof Element && target.closest(EDITABLE) !== null) return false;
      if (event.deltaX === 0 && event.deltaY === 0) return false;
      const element = scrollportOf(target, {
        top: event.deltaY !== 0,
        left: event.deltaX !== 0
      });
      if (element === null) return false;
      const max = maxima(element);
      const delta = pixelDelta(event, element);
      const base = wheel?.element === element ? wheel : void 0;
      const fromTop = element.scrollTop;
      const fromLeft = element.scrollLeft;
      const top = Math.min(max.top, Math.max(0, (base?.top ?? fromTop) + delta.y));
      const left = Math.min(max.left, Math.max(0, (base?.left ?? fromLeft) + delta.x));
      if (Math.abs(top - fromTop) < WHEEL_SETTLE_PX && Math.abs(left - fromLeft) < WHEEL_SETTLE_PX) return false;
      event.preventDefault();
      const stopped = run;
      if (stopped !== void 0) {
        window.cancelAnimationFrame(stopped.frame);
        run = void 0;
        for (const leg of stopped.legs) release(leg.element, true);
        for (const settle of stopped.done) settle();
      }
      if (base === void 0) hold(element);
      else window.cancelAnimationFrame(base.frame);
      const travelled = Math.max(Math.abs(top - fromTop), Math.abs(left - fromLeft));
      const segment = {
        element,
        top,
        left,
        fromTop,
        fromLeft,
        started: performance.now(),
        duration: Math.min(WHEEL_MAX_MS, scrollDurationMs(travelled, active)),
        frame: 0
      };
      wheel = segment;
      segment.frame = window.requestAnimationFrame(wheelStep);
      return true;
    }
    function scrollportOf(node, axis) {
      let current = node;
      while (current !== null) {
        const max = maxima(current);
        if (axis.top && max.top > 0 || axis.left && max.left > 0) return current;
        current = current.parentElement;
      }
      return null;
    }
    function pageStep(length) {
      return Math.max(1, Math.max(length * PAGE_FRACTION, length - PAGE_OVERLAP));
    }
    function pixelDelta(event, element) {
      if (event.deltaMode === 0) return { x: event.deltaX, y: event.deltaY };
      const unitY = event.deltaMode === 1 ? PIXELS_PER_LINE : pageStep(element.clientHeight);
      const unitX = event.deltaMode === 1 ? PIXELS_PER_LINE : pageStep(element.clientWidth);
      return { x: event.deltaX * unitX, y: event.deltaY * unitY };
    }
    function animates(behavior, distance) {
      return behavior === "instant" && Math.max(distance.top, distance.left) >= JUMP_ANIMATE_MIN;
    }
    function scrollIntoView(...args) {
      const options = args[0];
      const requested = typeof options === "object" && options !== null ? options : void 0;
      const active = settings;
      if (active === void 0 || requested?.behavior !== "smooth") return shipped.scrollIntoView.apply(this, args);
      const jump = { ...requested, behavior: "instant" };
      if (wantsInstant()) return shipped.scrollIntoView.call(this, jump);
      const tracked = containers(this);
      for (const element of tracked) hold(element);
      const before = tracked.map((element) => ({ top: element.scrollTop, left: element.scrollLeft }));
      shipped.scrollIntoView.call(this, jump);
      const legs = [];
      for (let index = 0; index < tracked.length; index += 1) {
        const element = tracked[index];
        const origin = before[index];
        if (element === void 0 || origin === void 0) continue;
        const landed = { top: element.scrollTop, left: element.scrollLeft };
        writeAxis(element, "top", origin.top);
        writeAxis(element, "left", origin.left);
        const moved = Math.abs(landed.top - origin.top) > MOTION_EPSILON || Math.abs(landed.left - origin.left) > MOTION_EPSILON;
        if (!moved) {
          if (run?.legs.some((leg) => leg.element === element)) continue;
          release(element, false);
          continue;
        }
        legs.push({ element, fromTop: origin.top, fromLeft: origin.left, toTop: landed.top, toLeft: landed.left });
      }
      if (legs.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        if (!merge(legs, resolve)) start(legs, resolve);
      });
    }
    function readOffsets(options, base) {
      return {
        left: options.left === void 0 ? void 0 : base.left + options.left,
        top: options.top === void 0 ? void 0 : base.top + options.top
      };
    }
    function legFor(element, top, left) {
      const max = maxima(element);
      const toTop = top === void 0 ? element.scrollTop : Math.min(max.top, Math.max(0, top));
      const toLeft = left === void 0 ? element.scrollLeft : Math.min(max.left, Math.max(0, left));
      if (Math.abs(toTop - element.scrollTop) < MOTION_EPSILON && Math.abs(toLeft - element.scrollLeft) < MOTION_EPSILON) return void 0;
      return { element, fromTop: element.scrollTop, fromLeft: element.scrollLeft, toTop, toLeft };
    }
    function patchedOffset(element, args, shippedMethod, relative) {
      if (writing > 0) return shippedMethod.apply(element, args);
      const options = args[0];
      const behavior = typeof options === "object" && options !== null ? options.behavior : void 0;
      const active = settings;
      if (active === void 0 || wantsInstant()) return shippedMethod.apply(element, args);
      const base = relative ? { top: element.scrollTop, left: element.scrollLeft } : { top: 0, left: 0 };
      const request = readOffsets(options, base);
      const leg = legFor(element, request.top, request.left);
      if (leg === void 0) return Promise.resolve();
      if (behavior === "smooth") {
        return new Promise((resolve) => {
          if (!merge([leg], resolve)) start([leg], resolve);
        });
      }
      if (!animates(behavior, {
        top: Math.abs(leg.toTop - leg.fromTop),
        left: Math.abs(leg.toLeft - leg.fromLeft)
      })) {
        shippedMethod.apply(element, args);
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        start([leg], resolve);
      });
    }
    function scrollTo(...args) {
      return patchedOffset(this, args, shipped.scrollTo, false);
    }
    function scrollBy(...args) {
      return patchedOffset(this, args, shipped.scrollBy, true);
    }
    function resolveTarget(target) {
      if (target === null) return null;
      return target;
    }
    function onScrollEnd(event) {
      if (dispatching) return;
      const target = resolveTarget(event.target);
      if (target === null) return;
      const entry = shadowed.get(target);
      if (entry === void 0) return;
      if (entry.until === Number.POSITIVE_INFINITY) {
        event.stopImmediatePropagation();
        return;
      }
      const unmoved = Math.abs(target.scrollTop - entry.top) <= FOREIGN_TOLERANCE && Math.abs(target.scrollLeft - entry.left) <= FOREIGN_TOLERANCE;
      if (!unmoved || performance.now() > entry.until) {
        shadowed.delete(target);
        graceful.delete(target);
        return;
      }
      event.stopImmediatePropagation();
    }
    function onWheelBubble(event) {
      cancelIfOwned(event.target);
      if (event.defaultPrevented) return;
      onWheel(event);
    }
    function cancelIfOwned(target) {
      for (const [element] of glides) {
        if (target === null || element.contains(target)) finishGlide(element, false);
      }
      const active = run;
      if (active === void 0 || target === null) return false;
      if (!active.legs.some((leg) => leg.element.contains(target))) return false;
      cancel();
      return true;
    }
    function onTakeover(event) {
      const key = event.type === "keydown";
      if (key) {
        if (event.key === void 0 || !SCROLL_KEYS.has(event.key)) return;
        const focus = event.target;
        if (focus instanceof Element && focus.closest(EDITABLE) !== null) return;
      }
      if (run === void 0) {
        clearGrace();
        return;
      }
      if (key) cancel();
      else cancelIfOwned(event.target);
    }
    function ownsPatches() {
      const prototype = Element.prototype;
      return prototype.scrollTo === scrollTo && prototype.scrollBy === scrollBy && prototype.scrollIntoView === scrollIntoView;
    }
    function install() {
      if (installed) return;
      const current = Element.prototype;
      if (current.scrollTo !== shipped.scrollTo || current.scrollIntoView !== shipped.scrollIntoView) {
        console.error("ui-experience: scroll methods were already replaced when the motion layer started; scripted scrolling is left off until the page reloads");
        return;
      }
      installed = true;
      const prototype = Element.prototype;
      prototype.scrollTo = scrollTo;
      prototype.scrollBy = scrollBy;
      prototype.scrollIntoView = scrollIntoView;
      if (topAxis !== void 0) {
        Object.defineProperty(Element.prototype, "scrollTop", {
          configurable: true,
          enumerable: topAxis.enumerable,
          get() {
            const glide = glides.get(this);
            return glide === void 0 ? topAxis.get.call(this) : glide.target;
          },
          set(value) {
            if (writing > 0 || !shouldGlide(this, value, performance.now())) {
              topAxis.set.call(this, value);
              return;
            }
            startGlide(this, value);
          }
        });
      }
      window.addEventListener("scrollend", onScrollEnd, true);
      window.addEventListener(
        "wheel",
        onWheelBubble,
        { capture: false, passive: false }
      );
      for (const kind of ["touchstart", "keydown"]) {
        window.addEventListener(kind, onTakeover, { capture: true, passive: true });
      }
    }
    function uninstall() {
      finishGlides();
      cancel(false);
      clearGrace();
      if (!installed) return;
      installed = false;
      if (!ownsPatches()) {
        console.error("ui-experience: the scroll methods were replaced while scripted scrolling was active; leaving the current implementations in place instead of restoring stale ones");
        return;
      }
      const prototype = Element.prototype;
      prototype.scrollTo = shipped.scrollTo;
      prototype.scrollBy = shipped.scrollBy;
      prototype.scrollIntoView = shipped.scrollIntoView;
      if (topAxis !== void 0) {
        Object.defineProperty(Element.prototype, "scrollTop", {
          configurable: true,
          enumerable: topAxis.enumerable,
          get: topAxis.get,
          set: topAxis.set
        });
      }
      window.removeEventListener("scrollend", onScrollEnd, true);
      window.removeEventListener(
        "wheel",
        onWheelBubble,
        false
      );
      for (const kind of ["touchstart", "keydown"]) {
        window.removeEventListener(kind, onTakeover, true);
      }
    }
    return {
      apply(next) {
        uninstall();
        settings = next;
        if (!next.scroll || next.mode === "off") return;
        install();
      },
      restore() {
        uninstall();
        settings = void 0;
      }
    };
  }

  // src/stream.ts
  var STREAM_ATTRIBUTE = "data-dsh-uix-stream";
  var LAST_ATTRIBUTE = "data-dsh-uix-last";
  var WIDTH_ATTRIBUTE = "data-dsh-uix-width";
  var ENTER_ATTRIBUTE = "data-dsh-uix-enter";
  var ROLL_ATTRIBUTE = "data-dsh-uix-rolling";
  var ROW = "[data-chat-flow-kind], [data-chat-anchor-key], [data-submission-echo], [data-pending-steering]";
  var ENTER_FALLBACK_MS = 220;
  var LIVE = "[data-streaming], [data-process-activity] [data-shimmer]";
  var MIN_REVEAL_PX = 0.5;
  var REVEAL_EXPONENT = 0.62;
  var ONE_LINE_PX = 24;
  var FADE_BAND = 0.45;
  var SINGLE_LINE_RATIO = 1.5;
  var MIN_TILT_DEG = 15;
  var MAX_TILT_DEG = 45;
  var STREAM_CSS = `
@property --dsh-uix-reveal {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

@property --dsh-uix-edge {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

@property --dsh-uix-tilt {
  syntax: '<angle>';
  inherits: false;
  initial-value: 180deg;
}

/* The mask is a tilted reveal line with a soft trailing edge, so text arrives out
   of a gradient rather than at a hard boundary. The tilt is held inside 15deg-45deg
   off horizontal, which is what makes the edge read as a diagonal wipe; any
   shallower and it looks like a flat line across the block. */
[${STREAM_ATTRIBUTE}="reveal"] {
  --dsh-uix-reveal: 0px;
  mask-image: linear-gradient(
    var(--dsh-uix-tilt),
    #000 calc(var(--dsh-uix-reveal) - ${FADE_BAND}lh),
    transparent var(--dsh-uix-reveal)
  );
  mask-size: 100% 100%;
  mask-repeat: no-repeat;
}

/* One-line labels: a horizontal edge at the end of the text a reader has already
   seen sweeps out to the new width, so only the arriving characters are revealed.

   The edge is a registered custom property driven by a transition. Keyframing the
   gradient itself does not work: Chrome snaps between two linear-gradients instead of
   interpolating them, which reads as no animation at all.

   A TextShimmer root holds a decorative copy of its children for its own sweep, so
   its mask goes on the readable first child. The reasoning summary masks itself,
   which also replaces the static fade the application puts on it. */
[${STREAM_ATTRIBUTE}="append"][data-shimmer] > :first-child,
[${STREAM_ATTRIBUTE}="append"][data-streaming]:not([data-shimmer]) {
  --dsh-uix-edge: 100000px;
  mask-image: linear-gradient(
    to right,
    #000 calc(var(--dsh-uix-edge) - 1.2ch),
    transparent var(--dsh-uix-edge)
  );
}

/* A TextShimmer root draws a second, inert copy of its children and sweeps a band of
   light through it \u2014 the application's own idle shimmer. This layer moves a mask over
   the readable copy instead, so the two would run at once: a band of light crossing a
   line whose text is also being uncovered, which reads as two animations fighting.

   The decorative copy is always the second child, and only exists while the label is
   active, so this matches nothing on an idle one. */
[${STREAM_ATTRIBUTE}="append"][data-shimmer] > :nth-child(2),
[${STREAM_ATTRIBUTE}="append"] [data-shimmer] > :nth-child(2) {
  display: none;
}

/* A label arrives as a whole line and rises into place; only later growth is swept,
   so arrival and extension read differently. */
[${STREAM_ATTRIBUTE}="append"][data-shimmer][${ROLL_ATTRIBUTE}] > :first-child,
[${STREAM_ATTRIBUTE}="append"][data-streaming]:not([data-shimmer])[${ROLL_ATTRIBUTE}] {
  animation: dsh-uix-arrive var(--dsh-uix-roll, 260ms) var(--dsh-uix-ease, ease) both;
}

@keyframes dsh-uix-arrive {
  from { transform: translateY(0.85lh); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* A row that arrives while the transcript is following its tail rises into place.
   Only opacity and transform are animated, so the height the follow loop reads back
   right after its write is the height it asked for. */
[${ENTER_ATTRIBUTE}] {
  animation: dsh-uix-enter var(--dsh-uix-enter, 220ms) var(--dsh-uix-ease, ease) both;
}

@keyframes dsh-uix-enter {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  [${STREAM_ATTRIBUTE}="reveal"] {
    mask-image: none;
  }

  [${ENTER_ATTRIBUTE}] {
    animation: none;
  }

  [${STREAM_ATTRIBUTE}="append"][data-shimmer][${ROLL_ATTRIBUTE}] > :first-child,
  [${STREAM_ATTRIBUTE}="append"][data-streaming]:not([data-shimmer])[${ROLL_ATTRIBUTE}] {
    animation: none;
  }

  [${STREAM_ATTRIBUTE}="append"][data-shimmer] > :first-child,
  [${STREAM_ATTRIBUTE}="append"][data-streaming]:not([data-shimmer]) {
    mask-image: none;
  }
}
`;
  function createStreamMotion() {
    const reveals = /* @__PURE__ */ new Map();
    let knownRows = /* @__PURE__ */ new WeakSet();
    let following = false;
    let sheet;
    let observer;
    let settings;
    let pending = false;
    let installed = false;
    let ease = "";
    let rollMs = 260;
    let enterMs = ENTER_FALLBACK_MS;
    let revealMinMs = 250;
    let revealMaxMs = 1200;
    const generation = /* @__PURE__ */ new WeakMap();
    const sweeps = /* @__PURE__ */ new WeakMap();
    const rests = /* @__PURE__ */ new WeakMap();
    const heights = /* @__PURE__ */ new WeakMap();
    const rolls = /* @__PURE__ */ new WeakMap();
    const slots = /* @__PURE__ */ new WeakMap();
    function nextGeneration(element) {
      const next = (generation.get(element) ?? 0) + 1;
      generation.set(element, next);
      return next;
    }
    function still() {
      const active = settings;
      if (active === void 0) return true;
      if (active.reduced === "always") return true;
      return active.reduced === "system" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    function lineHeightOf(element) {
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      return Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24;
    }
    function singleLine(element) {
      return element.scrollHeight <= lineHeightOf(element) * SINGLE_LINE_RATIO;
    }
    function modeOf(element) {
      if (element.hasAttribute("data-shimmer")) return "append";
      if (window.getComputedStyle(element).whiteSpace === "nowrap") return "append";
      return singleLine(element) ? "append" : "reveal";
    }
    function tiltFor(element, lineHeight) {
      const width = element.clientWidth;
      if (width <= 0 || lineHeight <= 0) return { angle: "180deg", sin: 0, cos: 1 };
      const natural = Math.atan(lineHeight / width) * 180 / Math.PI;
      const slant = Math.min(MAX_TILT_DEG, Math.max(MIN_TILT_DEG, natural)) * Math.PI / 180;
      return {
        angle: `${180 - slant * 180 / Math.PI}deg`,
        sin: Math.sin(slant),
        cos: Math.cos(slant)
      };
    }
    function front(element, tilt, height, lineHeight) {
      return tilt.sin * Math.max(0, element.clientWidth) + tilt.cos * height + lineHeight * FADE_BAND;
    }
    function textOf(element) {
      return (element.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    function labelText(element) {
      if (!element.hasAttribute("data-shimmer")) return textOf(element);
      const content = firstChild(element);
      return content === null ? "" : textOf(content);
    }
    function contentWidth(element) {
      const root = maskTarget(element);
      if (root === null) return 0;
      const origin = root.getBoundingClientRect().left;
      const range = document.createRange();
      const walker = document.createTreeWalker(root, 4);
      let right = 0;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        if (text.trim() === "") continue;
        range.selectNodeContents(node);
        right = Math.max(right, range.getBoundingClientRect().right - origin);
      }
      return right;
    }
    function firstChild(element) {
      return element.firstElementChild ?? null;
    }
    function maskTarget(element) {
      return element.hasAttribute("data-shimmer") ? firstChild(element) : element;
    }
    function slotOf(element) {
      const parent = element.parentElement;
      if (parent === null) return null;
      const children = parent.children;
      for (let index = 0; index < children.length; index += 1) {
        if (children[index] === element) return { parent, index };
      }
      return null;
    }
    function readSlot(slot) {
      if (slot === null) return void 0;
      return slots.get(slot.parent)?.get(slot.index);
    }
    function writeSlot(slot, text, width) {
      if (slot === null) return;
      let entries = slots.get(slot.parent);
      if (entries === void 0) {
        entries = /* @__PURE__ */ new Map();
        slots.set(slot.parent, entries);
      }
      entries.set(slot.index, { text, width });
      const count = slot.parent.children.length;
      for (const index of entries.keys()) {
        if (index >= count) entries.delete(index);
      }
    }
    function enterLabel(element) {
      const run2 = (rolls.get(element) ?? 0) + 1;
      rolls.set(element, run2);
      element.removeAttribute(ROLL_ATTRIBUTE);
      void element.scrollHeight;
      element.setAttribute(ROLL_ATTRIBUTE, "");
      window.setTimeout(() => {
        if (rolls.get(element) === run2) element.removeAttribute(ROLL_ATTRIBUTE);
      }, rollMs);
    }
    function append(element, previous, previousWidth) {
      const now = labelText(element);
      const target = maskTarget(element);
      if (target === null) return;
      const full = contentWidth(element);
      element.setAttribute(WIDTH_ATTRIBUTE, String(full));
      if (full <= 1) {
        rest(element, target);
        return;
      }
      const extending = previous !== "" && now.startsWith(previous) && previousWidth > 0;
      const start = extending ? previousWidth : 0;
      const gap = Math.max(MIN_REVEAL_PX, full - start);
      const duration = revealDuration(gap);
      const run2 = nextGeneration(element);
      const continuing = extending && (sweeps.get(element) ?? 0) > performance.now();
      target.style.removeProperty("mask-image");
      if (!continuing) {
        target.style.transition = "none";
        target.style.setProperty("--dsh-uix-edge", `${start}px`);
        void element.scrollHeight;
      }
      sweeps.set(element, performance.now() + duration);
      target.style.transition = `--dsh-uix-edge ${duration}ms ${ease}`;
      target.style.setProperty("--dsh-uix-edge", `${full}px`);
      window.setTimeout(() => {
        if (!owns(element, run2)) return;
        sweeps.delete(element);
        rest(element, target);
      }, duration);
    }
    function rest(element, target) {
      target.style.setProperty("mask-image", rests.get(element) ?? "none");
      target.style.removeProperty("--dsh-uix-edge");
      target.style.removeProperty("transition");
    }
    function owns(element, run2) {
      return generation.get(element) === run2;
    }
    function revealDuration(gap) {
      const active = settings;
      const perLine = revealMinMs / Math.pow(ONE_LINE_PX, REVEAL_EXPONENT);
      const shaped = perLine * Math.pow(Math.max(ONE_LINE_PX, gap), REVEAL_EXPONENT);
      const scaled = Math.min(revealMaxMs, Math.max(revealMinMs, shaped)) * active.durationScale;
      return active.quantize ? quantizeMs(scaled) : scaled;
    }
    function advance(element, state) {
      const active = settings;
      if (active === void 0) return;
      const height = lineHeightOf(element);
      const tilt = tiltFor(element, height);
      element.style.setProperty("--dsh-uix-tilt", tilt.angle);
      state.target = front(element, tilt, element.scrollHeight, height);
      if (state.frame !== 0) return;
      run(element, state);
    }
    function run(element, state) {
      const active = settings;
      if (active === void 0) return;
      const gap = state.target - state.current;
      if (gap < MIN_REVEAL_PX) {
        state.frame = 0;
        return;
      }
      state.from = state.current;
      state.started = performance.now();
      state.duration = revealDuration(gap);
      const mode = active.mode;
      const step = (now) => {
        const live = reveals.get(element);
        if (live === void 0 || live !== state) return;
        const progress = Math.min(1, (now - state.started) / Math.max(1, state.duration));
        const eased = easeCurve(effectCurvePoints(mode), progress);
        state.current = state.from + (state.target - state.from) * eased;
        element.style.setProperty("--dsh-uix-reveal", `${state.current}px`);
        if (progress >= 1) {
          state.current = state.target;
          element.style.setProperty("--dsh-uix-reveal", `${state.target}px`);
          state.frame = 0;
          if (state.target - state.current >= MIN_REVEAL_PX) run(element, state);
          return;
        }
        state.frame = window.requestAnimationFrame(step);
      };
      state.frame = window.requestAnimationFrame(step);
    }
    function forget(element, immediately = false) {
      const state = reveals.get(element);
      reveals.delete(element);
      nextGeneration(element);
      if (state !== void 0 && !immediately) {
        element.style.setProperty("--dsh-uix-reveal", `${state.target + element.scrollHeight}px`);
      }
      element.removeAttribute(STREAM_ATTRIBUTE);
      element.removeAttribute(LAST_ATTRIBUTE);
      element.removeAttribute(WIDTH_ATTRIBUTE);
      element.removeAttribute(ROLL_ATTRIBUTE);
      rolls.delete(element);
      const target = maskTarget(element);
      const clear = () => {
        element.style.removeProperty("--dsh-uix-reveal");
        element.style.removeProperty("--dsh-uix-tilt");
        element.style.removeProperty("transition");
        target?.style.removeProperty("--dsh-uix-edge");
        target?.style.removeProperty("transition");
        target?.style.removeProperty("mask-image");
      };
      rests.delete(element);
      if (immediately || state === void 0) clear();
      else window.setTimeout(clear, revealMaxMs);
    }
    function measure() {
      pending = false;
      const active = settings;
      if (active === void 0 || active.mode === "off" || still()) return;
      const marked = document.querySelectorAll(`[${STREAM_ATTRIBUTE}]`);
      for (let index = 0; index < marked.length; index += 1) {
        const element = marked[index];
        if (element === void 0) continue;
        if (element.getAttribute(STREAM_ATTRIBUTE) !== "reveal") continue;
        const state = reveals.get(element);
        if (state === void 0) continue;
        advance(element, state);
      }
    }
    function schedule() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(measure);
    }
    function covered(element) {
      let node = element.parentElement;
      while (node !== null) {
        if (node.getAttribute(STREAM_ATTRIBUTE) === "reveal") return true;
        node = node.parentElement;
      }
      return false;
    }
    function mark() {
      const active = settings;
      if (active === void 0 || active.mode === "off" || still()) return;
      const live = document.querySelectorAll(LIVE);
      const seen = /* @__PURE__ */ new Set();
      const containers2 = /* @__PURE__ */ new Set();
      for (let index = 0; index < live.length; index += 1) {
        const element = live[index];
        if (element === void 0) continue;
        for (let node = element.parentElement; node !== null; node = node.parentElement) {
          containers2.add(node);
        }
      }
      for (let index = 0; index < live.length; index += 1) {
        const element = live[index];
        if (element === void 0) continue;
        const height = element.scrollHeight;
        const lineHeight = lineHeightOf(element);
        const before = heights.get(element);
        heights.set(element, height);
        if (covered(element)) continue;
        const mode = modeOf(element);
        if (mode === "append" && containers2.has(element)) {
          if (element.hasAttribute(STREAM_ATTRIBUTE)) forget(element, true);
          continue;
        }
        seen.add(element);
        const marked2 = element.getAttribute(STREAM_ATTRIBUTE);
        if (marked2 !== mode) {
          if (marked2 !== null) forget(element, true);
          if (mode === "reveal") {
            const tilt = tiltFor(element, lineHeight);
            const end = front(element, tilt, height, lineHeight);
            const open = before === void 0 ? end : Math.min(end, front(element, tilt, before, lineHeight));
            reveals.set(element, { current: open, from: open, target: open, frame: 0, started: 0, duration: 0 });
            element.style.setProperty("--dsh-uix-tilt", tilt.angle);
            element.style.setProperty("--dsh-uix-reveal", `${open}px`);
          } else {
            const target2 = maskTarget(element);
            if (target2 !== null) rests.set(element, window.getComputedStyle(target2).maskImage);
          }
          element.setAttribute(STREAM_ATTRIBUTE, mode);
          const target = maskTarget(element);
          if (mode === "append" && target !== null) rest(element, target);
        }
        if (mode === "reveal") continue;
        const text = labelText(element);
        const width = contentWidth(element);
        const slot = slotOf(element);
        const prior = readSlot(slot);
        const previous = prior?.text ?? element.getAttribute(LAST_ATTRIBUTE) ?? "";
        const previousWidth = prior?.width ?? Number.parseFloat(element.getAttribute(WIDTH_ATTRIBUTE) ?? "0");
        if (text === previous) continue;
        writeSlot(slot, text, width);
        element.setAttribute(LAST_ATTRIBUTE, text);
        element.setAttribute(WIDTH_ATTRIBUTE, String(width));
        const extending = previous !== "" && text.startsWith(previous) && previousWidth > 0;
        if (!extending) enterLabel(element);
        append(element, previous, Number.isFinite(previousWidth) ? previousWidth : 0);
      }
      unveil();
      const marked = document.querySelectorAll(`[${STREAM_ATTRIBUTE}]`);
      for (let index = 0; index < marked.length; index += 1) {
        const element = marked[index];
        if (element === void 0 || seen.has(element)) continue;
        forget(element);
      }
      schedule();
    }
    function atTail() {
      return document.querySelectorAll("[data-chat-following-tail]").length > 0;
    }
    function unveil() {
      const rows = document.querySelectorAll(ROW);
      if (rows.length === 0) return;
      const pinned = atTail();
      const next = /* @__PURE__ */ new WeakSet();
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (row === void 0) continue;
        next.add(row);
        if (knownRows.has(row)) continue;
        if (!pinned || !following) continue;
        row.setAttribute(ENTER_ATTRIBUTE, "");
        window.setTimeout(() => {
          row.removeAttribute(ENTER_ATTRIBUTE);
        }, enterMs);
      }
      knownRows = next;
      following = pinned;
    }
    function install() {
      if (installed) return;
      installed = true;
      sheet = document.createElement("style");
      sheet.textContent = STREAM_CSS;
      document.head.appendChild(sheet);
      observer = new MutationObserver(() => {
        mark();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-streaming", "data-shimmer"]
      });
      const existing = document.querySelectorAll(ROW);
      for (let index = 0; index < existing.length; index += 1) {
        const row = existing[index];
        if (row !== void 0) knownRows.add(row);
      }
      following = atTail();
      mark();
    }
    function uninstall() {
      observer?.disconnect();
      observer = void 0;
      sheet?.remove();
      sheet = void 0;
      installed = false;
      document.documentElement.style.removeProperty("--dsh-uix-ease");
      document.documentElement.style.removeProperty("--dsh-uix-roll");
      document.documentElement.style.removeProperty("--dsh-uix-enter");
      const entering = document.querySelectorAll(`[${ENTER_ATTRIBUTE}]`);
      for (let index = 0; index < entering.length; index += 1) {
        entering[index]?.removeAttribute(ENTER_ATTRIBUTE);
      }
      const marked = document.querySelectorAll(`[${STREAM_ATTRIBUTE}]`);
      for (let index = 0; index < marked.length; index += 1) {
        const element = marked[index];
        if (element !== void 0) forget(element, true);
      }
      reveals.clear();
    }
    return {
      apply(next) {
        uninstall();
        settings = next;
        if (next.mode === "off" || !next.stream) return;
        if (next.reduced === "system" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        ease = `cubic-bezier(${effectCurvePoints(next.mode).join(", ")})`;
        const scaled = next.streamRollMs * next.durationScale;
        rollMs = next.quantize ? quantizeMs(scaled) : scaled;
        document.documentElement.style.setProperty("--dsh-uix-ease", ease);
        document.documentElement.style.setProperty("--dsh-uix-roll", `${rollMs}ms`);
        const scaledEnter = next.streamEnterMs * next.durationScale;
        enterMs = next.quantize ? quantizeMs(scaledEnter) : scaledEnter;
        revealMinMs = next.streamRevealMinMs;
        revealMaxMs = next.streamRevealMaxMs;
        document.documentElement.style.setProperty("--dsh-uix-enter", `${enterMs}ms`);
        install();
      },
      restore: uninstall
    };
  }

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
/* Disclosure: FontSizeRow.module.css .expander \u2014 a 24px icon button whose
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
/* Input primitive: Input.module.css .wrap / .input / placeholder \u2014 the
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

/* A labelled control line: the caption column and the control that follows it,
   mirroring the settings form's label/control pairing. */
.dsh-uix-choice{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.dsh-uix-choice-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}

/* Segmented control: SegmentedControl.module.css .control / .indicator / .tab \u2014
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

/* Boolean option row: DeveloperToolsRow.module.css .row / .title / .description \u2014
   the title column takes the width, the switch sits at the inline end. The copied
   Switch above is the same control, so an option row and the row above it match. */
.dsh-uix-option{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0}
.dsh-uix-option+.dsh-uix-option{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsh-uix-option-text{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-uix-option-title{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-uix-option-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
`;

  // src/client.ts
  var REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
  function queryReduced() {
    return window.matchMedia(REDUCED_QUERY).matches;
  }
  function watchReduced(report) {
    const media = window.matchMedia(REDUCED_QUERY);
    const listener = () => {
      report(media.matches);
    };
    report(media.matches);
    media.addEventListener("change", listener);
    return () => {
      media.removeEventListener("change", listener);
    };
  }
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
        descriptor("setPaths", () => ({ colorsPath: zod.string().optional(), tokensPath: zod.string().optional() }), "SetPathsArgs"),
        descriptor("setMotion", () => ({
          mode: zod.string().optional(),
          durationScale: zod.number().optional(),
          spatialSplit: zod.boolean().optional(),
          quantize: zod.boolean().optional(),
          reduced: zod.string().optional(),
          scroll: zod.boolean().optional(),
          stream: zod.boolean().optional(),
          followScroll: zod.boolean().optional(),
          streamRevealMinMs: zod.number().optional(),
          streamRevealMaxMs: zod.number().optional(),
          streamEnterMs: zod.number().optional(),
          streamRollMs: zod.number().optional()
        }), "SetMotionArgs")
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
      "palette.paths-hint": "\u652F\u6301\u4EE5 ~ \u5F00\u5934\u7684\u8DEF\u5F84\uFF0C\u6216\u7EDD\u5BF9\u8DEF\u5F84\u3002\u989C\u8272\u6587\u4EF6\u63D0\u4F9B\u5B8C\u6574\u6620\u5C04\uFF0C\u4EE4\u724C\u6587\u4EF6\u91CC\u5217\u51FA\u7684 token \u9010\u9879\u8986\u76D6\u3002",
      "motion.title": "M3 \u52A8\u6548",
      "motion.description": "\u6309 Material 3 \u66F2\u7EBF\u6539\u5199\u6574\u4E2A\u754C\u9762\u7684\u8FC7\u6E21\u4E0E\u5173\u952E\u5E27\u52A8\u753B\uFF0C\u76F4\u63A5\u6539\u5199\u5DF2\u751F\u6548\u7684\u6837\u5F0F\u89C4\u5219",
      "motion.mode": "\u66F2\u7EBF\u65CF",
      "motion.mode-off": "\u5173\u95ED",
      "motion.mode-m3": "M3",
      "motion.mode-m3e": "M3E",
      "motion.duration": "\u65F6\u957F\u500D\u7387",
      "motion.options": "\u9AD8\u7EA7\u9009\u9879",
      "motion.spatial-split": "\u4F4D\u79FB\u4E0E\u6548\u679C\u4F7F\u7528\u4E0D\u540C\u66F2\u7EBF",
      "motion.spatial-split-hint": "\u4F4D\u79FB\u5E26\u8FC7\u51B2\uFF0C\u6548\u679C\u4E0D\u5E26\uFF1B\u5173\u95ED\u540E\u7EDF\u4E00\u7528\u6548\u679C\u66F2\u7EBF\u3002",
      "motion.quantize": "\u65F6\u957F\u5BF9\u9F50\u5230 Material \u6863\u4F4D",
      "motion.quantize-hint": "\u65F6\u957F\u5438\u9644\u5230 50 \u81F3 1000ms \u7684 Material \u6863\u4F4D\u3002",
      "motion.stream": "\u6D41\u5F0F\u6587\u672C\u6E10\u8FDB\u663E\u73B0",
      "motion.stream-hint": "\u6B63\u6587\u4E0E\u601D\u8003\u6458\u8981\u9010\u6BB5\u663E\u73B0\uFF1B\u53EA\u79FB\u52A8\u906E\u7F69\uFF0C\u4E0D\u622A\u65AD\u6587\u5B57\u3002",
      "motion.stream-timing": "\u6D41\u5F0F\u52A8\u753B\u65F6\u957F",
      "motion.follow-scroll": "\u8DDF\u968F\u5230\u5E95\u65F6\u5E73\u6ED1\u6ED1\u884C",
      "motion.follow-scroll-hint": "\u5173\u95ED\u540E\u5E95\u90E8\u8DDF\u968F\u77AC\u65F6\u8D34\u9F50\uFF0C\u53EA\u6709\u6587\u5B57\u5728\u52A8\uFF1B\u5F00\u542F\u65F6\u89C6\u53E3\u6ED1\u8FC7\u53BB\uFF0C\u89C2\u611F\u66F4\u8FDE\u7EED\u4F46\u59CB\u7EC8\u843D\u540E\u7EA6\u4E00\u884C\u3002",
      "motion.stream-reveal-min": "\u5355\u884C\u663E\u73B0\u4E0B\u9650\uFF08ms\uFF09",
      "motion.stream-reveal-max": "\u6574\u5757\u663E\u73B0\u4E0A\u9650\uFF08ms\uFF09",
      "motion.stream-enter": "\u65B0\u884C\u8FDB\u573A\uFF08ms\uFF09",
      "motion.stream-roll": "\u6458\u8981\u6362\u884C\u6EDA\u52A8\uFF08ms\uFF09",
      "motion.stream-timing-hint": "\u5355\u884C\u4E0B\u9650\u5C31\u662F\u7F13\u5B58\u7684\u53EF\u89C1\u7A97\u53E3\uFF1A\u8C03\u5927\u5B83\uFF0C\u8FB9\u754C\u540E\u65B9\u538B\u7740\u7684\u672A\u8BFB\u6587\u5B57\u66F4\u591A\u3001\u52A8\u753B\u66F4\u6162\u3002\u4E0A\u9650\u7528\u4E8E\u6574\u5757\u5185\u5BB9\u4E00\u6B21\u843D\u4E0B\u7684\u60C5\u5F62\u3002",
      "motion.scroll": "\u6EDA\u52A8\u4F7F\u7528\u540C\u4E00\u66F2\u7EBF",
      "motion.scroll-hint": "\u5E73\u6ED1\u6EDA\u52A8\u3001\u6EDA\u8F6E\u4E0E\u5B9A\u4F4D\u8DF3\u8F6C\u6539\u7528\u672C\u9875\u66F2\u7EBF\u3002",
      "motion.reduced": "\u59CB\u7EC8\u51CF\u5F31\u52A8\u6548",
      "motion.reduced-hint": "\u5FFD\u7565\u7CFB\u7EDF\u504F\u597D\uFF0C\u4E00\u5F8B\u628A\u65F6\u957F\u538B\u5230 1ms\u3002",
      "motion.system-reduced": "\u7CFB\u7EDF\u5DF2\u8BF7\u6C42\u51CF\u5F31\u52A8\u6548\uFF0C\u672C\u9875\u52A8\u753B\u6B63\u5728\u88AB\u538B\u5236\u3002",
      "motion.save-failed": "\u52A8\u6548\u8BBE\u7F6E\u4FDD\u5B58\u5931\u8D25",
      "motion.inert": "\u66F2\u7EBF\u65CF\u4E3A\u300C\u5173\u95ED\u300D\uFF0C\u4EE5\u4E0B\u9009\u9879\u4E0D\u4F1A\u751F\u6548\u3002"
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
      "palette.paths-hint": "Paths may start with ~, or be absolute. The colors file supplies the full mapping; tokens listed in the token file override it item by item.",
      "motion.title": "M3 motion",
      "motion.description": "Rewrite every transition and keyframe animation in the interface onto Material 3 curves, in place on the rules already in the cascade",
      "motion.mode": "Curve family",
      "motion.mode-off": "Off",
      "motion.mode-m3": "M3",
      "motion.mode-m3e": "M3E",
      "motion.duration": "Duration scale",
      "motion.options": "Advanced options",
      "motion.spatial-split": "Spatial and effects take different curves",
      "motion.spatial-split-hint": "Movement overshoots, effects do not; off uses the effects curve for both.",
      "motion.quantize": "Snap durations to the Material ladder",
      "motion.quantize-hint": "Snap durations onto the 50-1000 ms Material ladder.",
      "motion.stream": "Progressive streamed text",
      "motion.stream-hint": "Reveal transcript and reasoning progressively; a mask moves, no text is cut.",
      "motion.stream-timing": "Stream timing",
      "motion.follow-scroll": "Glide when following the tail",
      "motion.follow-scroll-hint": "Off keeps the tail pinned exactly and only the text moves. On eases the viewport along \u2014 smoother, but about a line behind.",
      "motion.stream-reveal-min": "Reveal floor, one line (ms)",
      "motion.stream-reveal-max": "Reveal ceiling, whole block (ms)",
      "motion.stream-enter": "New row settle (ms)",
      "motion.stream-roll": "Summary roll (ms)",
      "motion.stream-timing-hint": "The floor is the visible buffer: raise it and more unread text stays behind the boundary, so the reveal reads slower. The ceiling covers a block that lands all at once.",
      "motion.scroll": "Scroll on the same curve",
      "motion.scroll-hint": "Drive smooth scrolling, the wheel, and locating jumps on this page's curve.",
      "motion.reduced": "Always reduce motion",
      "motion.reduced-hint": "Ignore the system preference and force every duration to 1 ms.",
      "motion.system-reduced": "The system asked for reduced motion; this page is being held still.",
      "motion.save-failed": "Failed to save the motion settings",
      "motion.inert": "The curve family is Off, so these options have no effect."
    }
  };
  function registerClient() {
    window.__ModuleLoader__.load({
      id: SOURCE,
      factory(require2) {
        const React = require2("react");
        const zod = require2("zod");
        const h = React.createElement;
        function run(registry, ctx, gateway) {
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
          let motionUnsupported = false;
          let paintedWidth = "";
          let disposeOverride;
          let borderSheet;
          let view = {
            active: false,
            borderWidth: "0.5px",
            paths: { colors: DEFAULT_COLORS_PATH, tokens: DEFAULT_TOKENS_PATH },
            motion: { ...MOTION_OFF },
            streamUnsupported: false,
            problem: "",
            notice: "",
            saving: false
          };
          const listeners = /* @__PURE__ */ new Set();
          const motion = createMotion();
          const scrolling = createScrollMotion();
          const streaming = createStreamMotion();
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
          const applyMotion = (next) => {
            if (disposed) return;
            motion.apply(next);
            scrolling.apply(next);
            streaming.apply(next);
          };
          const motionDiffers = (left, right) => left.mode !== right.mode || left.durationScale !== right.durationScale || left.spatialSplit !== right.spatialSplit || left.quantize !== right.quantize || left.reduced !== right.reduced || left.scroll !== right.scroll || left.stream !== right.stream || left.followScroll !== right.followScroll || left.streamRevealMinMs !== right.streamRevealMinMs || left.streamRevealMaxMs !== right.streamRevealMaxMs || left.streamEnterMs !== right.streamEnterMs || left.streamRollMs !== right.streamRollMs;
          const clearOverride = () => {
            disposeOverride?.();
            disposeOverride = void 0;
          };
          const applyPalette = (modes) => {
            if (disposed) return;
            clearOverride();
            try {
              disposeOverride = registry.overrideTokens(SOURCE, toOverrides(modes));
            } catch (error) {
              const message = `theme override rejected: ${error.message}`;
              console.error(`ui-experience: ${message}`);
              publish({ problem: message });
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
            const reported = answer.motion;
            if (reported !== void 0 && reported.stream === void 0 && !view.streamUnsupported) {
              console.error("ui-experience: this host build predates the stream setting; progressive streamed text stays on and its switch stays hidden until DSH restarts");
              publish({ streamUnsupported: true });
            }
            const motionAnswer = reported === void 0 ? { ...MOTION_OFF } : { ...MOTION_OFF, ...reported, stream: reported.stream ?? true };
            if (answer.motion === void 0 && !motionUnsupported) {
              motionUnsupported = true;
              console.error("ui-experience: this host build predates the motion settings; the M3 motion row stays inert until DSH restarts");
            }
            if (answer.paths.colors !== view.paths.colors || answer.paths.tokens !== view.paths.tokens || answer.borderWidth !== view.borderWidth) {
              publish({ paths: answer.paths, borderWidth: answer.borderWidth });
            }
            if (motionDiffers(view.motion, motionAnswer)) {
              publish({ motion: motionAnswer });
              if (bootstrapped) applyMotion(motionAnswer);
            }
            if (!bootstrapped) {
              bootstrapped = true;
              setBootAttribute(answer.active);
              publish({ active: answer.active });
              applyMotion(motionAnswer);
            } else if (!writing && view.active !== answer.active) {
              publish({ active: answer.active });
              if (answer.active) {
                setBootAttribute(true);
                if (answer.status === "ok" && answer.tokens !== void 0) applyPalette(answer.tokens);
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
              if (view.active && answer.tokens !== void 0) applyPalette(answer.tokens);
            }
            if (view.active) applyBorder(answer.borderWidth);
          };
          const poll = async () => {
            if (disposed || inflight) return;
            if (bootstrapped && !view.active && view.motion.mode === "off") {
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
          const saveMotion = async (change) => {
            if (disposed || writing) return;
            if (view.streamUnsupported && change.stream !== void 0) {
              console.error("ui-experience: the stream setting cannot be saved on this host build; restart DSH to pick it up");
              return;
            }
            writing = true;
            publish({ saving: true, problem: "", notice: "" });
            try {
              const applied = unwrap(await gateway.setMotion(change));
              if (disposed) return;
              publish({ motion: applied, notice: t("palette.saved") });
              applyMotion(applied);
            } catch (error) {
              const message = error.message;
              console.error(`ui-experience: failed to save the motion settings: ${message}`);
              publish({ problem: `${t("motion.save-failed")}: ${message}` });
            } finally {
              writing = false;
              publish({ saving: false });
            }
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
              applyPalette(tokens);
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
              if (probe.status === "ok" && view.active && probe.tokens !== void 0) applyPalette(probe.tokens);
            } catch (error) {
              const message = error.message;
              console.error(`ui-experience: failed to save the palette paths: ${message}`);
              publish({ problem: `${t("palette.save-failed")}: ${message}` });
            } finally {
              writing = false;
              publish({ saving: false });
            }
          };
          const disclosure = (open, toggle, label) => h(
            "button",
            {
              type: "button",
              className: "dsh-uix-disclosure",
              "aria-expanded": open,
              onClick: toggle
            },
            h(
              "span",
              { className: "dsh-uix-disclosure-icon" },
              h("svg", {
                viewBox: "0 0 16 16",
                width: 14,
                height: 14,
                fill: "none",
                stroke: "currentColor",
                strokeWidth: 1,
                "aria-hidden": true
              }, h("path", { d: "M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" }))
            ),
            h("span", null, label)
          );
          const numberRow = (label, hint, value, commit, disabled) => h(
            "label",
            { className: "dsh-uix-field" },
            h("span", { className: "dsh-uix-label" }, label),
            h(
              "span",
              { className: "dsh-uix-input-wrap" },
              h("input", {
                className: "dsh-uix-input",
                type: "number",
                min: 0,
                step: 10,
                defaultValue: String(value),
                disabled,
                onChange: (event) => {
                  const parsed = event.target.valueAsNumber;
                  if (Number.isFinite(parsed) && parsed >= 0) commit(Math.round(parsed));
                }
              })
            ),
            h("p", { className: "dsh-uix-hint" }, hint)
          );
          const WALK_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
          const segmented = (id, value, segments, select, label, disabled) => {
            const selected = Math.max(0, segments.findIndex((segment) => segment.value === value));
            const walk = (key) => {
              if (segments.length === 0) return;
              const current = segments[selected];
              if (current === void 0) return;
              let next;
              if (key === "Home") next = 0;
              else if (key === "End") next = segments.length - 1;
              else {
                const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
                next = ((selected + step) % segments.length + segments.length) % segments.length;
              }
              const target = segments[next];
              if (target !== void 0 && target.value !== value) select(target.value);
            };
            return h(
              "div",
              {
                role: "tablist",
                "aria-label": label,
                className: "dsh-uix-segment",
                style: {
                  "--dsh-segment-count": String(segments.length),
                  "--dsh-segment-index": String(selected)
                }
              },
              h("span", { "aria-hidden": true, className: "dsh-uix-segment-indicator" }),
              ...segments.map((segment) => h("button", {
                key: segment.value,
                id: `${id}-${segment.value}`,
                type: "button",
                role: "tab",
                "aria-selected": segment.value === value,
                tabIndex: segment.value === value ? 0 : -1,
                disabled,
                className: "dsh-uix-segment-tab",
                onClick: () => {
                  if (segment.value !== value) select(segment.value);
                },
                onKeyDown: (event) => {
                  if (!WALK_KEYS.includes(event.key)) return;
                  event.preventDefault();
                  walk(event.key);
                }
              }, segment.label))
            );
          };
          const option = (checked, set, label, hint, disabled) => h(
            "div",
            { className: "dsh-uix-option" },
            h(
              "div",
              { className: "dsh-uix-option-text" },
              h("div", { className: "dsh-uix-option-title" }, label),
              hint === void 0 ? null : h("div", { className: "dsh-uix-option-desc" }, hint)
            ),
            h("button", {
              type: "button",
              role: "switch",
              "aria-checked": checked,
              "aria-label": label,
              disabled,
              className: "dsh-uix-switch",
              onClick: () => {
                set(!checked);
              }
            }, h("span", { className: "dsh-uix-switch-thumb", "aria-hidden": true }))
          );
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
              h(
                "span",
                { className: "dsh-uix-input-wrap" },
                h("input", {
                  className: "dsh-uix-input",
                  type: "text",
                  value,
                  placeholder,
                  spellCheck: false,
                  autoComplete: "off",
                  onChange: (event) => {
                    set(event.target.value);
                  }
                })
              ),
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
              disclosure(open, () => {
                setOpen(!open);
              }, tr("palette.paths")),
              editor
            );
          }
          function MotionRow(props) {
            const tr = props.t ?? t;
            const [state, setState] = React.useState(view);
            const [open, setOpen] = React.useState(false);
            const [systemReduced, setSystemReduced] = React.useState(queryReduced());
            React.useEffect(() => {
              const listener = () => {
                setState(view);
              };
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            }, []);
            React.useEffect(() => watchReduced(setSystemReduced), []);
            const current = state.motion;
            const locked = state.saving;
            const status = state.problem !== "" ? h("p", { className: "dsh-uix-problem", role: "alert" }, state.problem) : state.notice !== "" ? h("p", { className: "dsh-uix-notice" }, state.notice) : null;
            const modes = [
              { value: "off", label: tr("motion.mode-off") },
              { value: "m3", label: tr("motion.mode-m3") },
              { value: "m3e", label: tr("motion.mode-m3e") }
            ];
            const ladder = [0.5, 0.75, 1, 1.25, 1.5, 2];
            if (!ladder.includes(current.durationScale)) ladder.push(current.durationScale);
            ladder.sort((left, right) => left - right);
            const scales = ladder.map((value) => ({
              value: String(value),
              label: `${value}\xD7`
            }));
            const policy = open ? h(
              "div",
              { className: "dsh-uix-form" },
              option(
                current.spatialSplit,
                (next) => {
                  void saveMotion({ spatialSplit: next });
                },
                tr("motion.spatial-split"),
                tr("motion.spatial-split-hint"),
                locked
              ),
              option(
                current.quantize,
                (next) => {
                  void saveMotion({ quantize: next });
                },
                tr("motion.quantize"),
                tr("motion.quantize-hint"),
                locked
              ),
              state.streamUnsupported ? null : option(
                current.stream,
                (next) => {
                  void saveMotion({ stream: next });
                },
                tr("motion.stream"),
                tr("motion.stream-hint"),
                locked
              ),
              option(
                current.followScroll,
                (next) => {
                  void saveMotion({ followScroll: next });
                },
                tr("motion.follow-scroll"),
                tr("motion.follow-scroll-hint"),
                locked
              ),
              option(
                current.scroll,
                (next) => {
                  void saveMotion({ scroll: next });
                },
                tr("motion.scroll"),
                tr("motion.scroll-hint"),
                locked
              ),
              option(
                current.reduced === "always",
                (next) => {
                  void saveMotion({ reduced: next ? "always" : "system" });
                },
                tr("motion.reduced"),
                tr("motion.reduced-hint"),
                locked
              )
            ) : null;
            const timing = current.stream && !state.streamUnsupported && open ? h(
              "div",
              { className: "dsh-uix-form" },
              numberRow(
                tr("motion.stream-reveal-min"),
                tr("motion.stream-timing-hint"),
                current.streamRevealMinMs,
                (next) => {
                  void saveMotion({ streamRevealMinMs: next });
                },
                locked
              ),
              numberRow(
                tr("motion.stream-reveal-max"),
                "",
                current.streamRevealMaxMs,
                (next) => {
                  void saveMotion({ streamRevealMaxMs: next });
                },
                locked
              ),
              numberRow(
                tr("motion.stream-enter"),
                "",
                current.streamEnterMs,
                (next) => {
                  void saveMotion({ streamEnterMs: next });
                },
                locked
              ),
              numberRow(
                tr("motion.stream-roll"),
                "",
                current.streamRollMs,
                (next) => {
                  void saveMotion({ streamRollMs: next });
                },
                locked
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
                  h("div", { className: "dsh-uix-title" }, tr("motion.title")),
                  h("div", { className: "dsh-uix-desc" }, tr("motion.description"))
                )
              ),
              status,
              h(
                "div",
                { className: "dsh-uix-choice" },
                h("span", { className: "dsh-uix-choice-label" }, tr("motion.mode")),
                segmented(
                  "dsh-uix-motion-mode",
                  current.mode,
                  modes,
                  (next) => {
                    void saveMotion({ mode: next });
                  },
                  tr("motion.mode"),
                  locked
                )
              ),
              current.mode === "off" ? null : h(
                "div",
                { className: "dsh-uix-choice" },
                h("span", { className: "dsh-uix-choice-label" }, tr("motion.duration")),
                segmented(
                  "dsh-uix-motion-scale",
                  String(current.durationScale),
                  scales,
                  (next) => {
                    void saveMotion({ durationScale: Number(next) });
                  },
                  tr("motion.duration"),
                  locked
                )
              ),
              current.mode !== "off" && systemReduced && current.reduced === "system" ? h("p", { className: "dsh-uix-hint" }, tr("motion.system-reduced")) : null,
              current.mode === "off" ? h("p", { className: "dsh-uix-hint" }, tr("motion.inert")) : null,
              disclosure(open, () => {
                setOpen(!open);
              }, tr("motion.options")),
              policy,
              timing
            );
          }
          ctx.effect(() => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
            name: "settings.general.item",
            id: "ui-experience.palette",
            order: 10.5,
            locale: "ui-experience"
          }, PaletteRow)), "ui-experience: settings row");
          ctx.effect(() => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
            name: "settings.general.item",
            id: "ui-experience.motion",
            order: 10.6,
            locale: "ui-experience"
          }, MotionRow)), "ui-experience: motion row");
          ctx.effect(() => ctx.timer.interval(() => {
            void poll();
          }, POLL_MS), "ui-experience: palette polling");
          ctx.effect(() => {
            return () => {
              disposed = true;
              teardown();
              motion.restore();
              scrolling.restore();
              streaming.restore();
            };
          }, "ui-experience: page-level layers");
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
            run(theme, ctx, gateway);
          }
        };
      }
    });
  }
  registerClient();
})();
