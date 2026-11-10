/**
 * Neon 5cm/s (霓虹秒速五厘米) — browser half.
 *
 * Migrated from the `dsh-anime-theme` monkey-patch script, which edited the
 * official `@deepseek-ai/dsh-client-ui-theme` bundle in place. This package
 * never touches another package: it is an ordinary DSH bundle whose Host half
 * only holds the Loader row, and whose browser half uses the documented Client
 * extension points:
 *
 *   - `theme.register({ id, colorScheme, tokens })` / `theme.setTheme(id)` on
 *     the Client `theme` service for the palette itself. The stock theme plugin
 *     owns the registry; registering a third-party id needs no patch there.
 *   - `ctx.on('theme/change')` to keep the plugin-owned body attribute in sync
 *     with whichever theme is actually active.
 *   - One plugin-owned `<style>` element for the surfaces a token cannot
 *     express (the violet glow, the sakura send button) and one `ctx.effect`
 *     for the interactive petal canvas. Both are removed when the bundle is
 *     switched off, so the plugin leaves no trace behind.
 *
 * On/off is the official one: the Plugins page switches this bundle (and its
 * single row) on and off. Switching it off unloads this module, the disposers
 * below restore the persisted light/dark/system preference, and the global
 * stylesheet/canvas go away. Switching it on loads this module again and the
 * theme activates on boot.
 *
 * Stable DOM contracts (never CSS-module hashes, which are re-hashed on every
 * official UI build):
 *   - `[data-composer-seat]`     the composer seat, ancestor of the send button
 *   - `button[aria-busy]:not([aria-haspopup])`
 *                                the primary send button inside that seat
 *                                (the model selector also carries `aria-busy`,
 *                                so `[aria-haspopup]` keeps it out)
 *   - `button[aria-busy] svg rect` its stop state (generation running)
 *   - `button[aria-busy] svg circle` its sending spinner state
 *   - `[data-composer-input]`    the composer's contenteditable (Enter to send)
 *
 * Contract: see README.md in this package.
 */
window.__ModuleLoader__.load({
  id: '@local/neon-5cms-theme',
  factory() {
    /** Third-party theme id; the previous bundle patch used the same id. */
    const THEME_ID = 'anime';
    /** Body attribute gating every plugin-owned style and the petal rain. */
    const ACTIVE_ATTRIBUTE = 'data-anime-theme';
    /** Package id, used for the owning `<style>` element. */
    const PLUGIN_ID = '@local/neon-5cms-theme';
    /** Loader row id of the stock theme plugin; its settings status gates activation. */
    const THEME_SETTINGS_ENTRY_ID = 'ui-theme';
    /** How long after activation the theme re-asserts itself against late settings adoption. */
    const SETTLE_MS = 2500;
    /** Activation delay once the settings document has settled (one paint). */
    const ACTIVATE_DELAY_MS = 80;
    /** Activation fallback when the settings status cannot be observed. */
    const SETTINGS_FALLBACK_MS = 800;

    /**
     * Alias-layer overrides for the theme registry. Values are the palette the
     * monkey-patch script carried: violet-night neutral scale, sakura-pink
     * brand scale, re-tinted alias surfaces, and the glow gradient token the
     * plugin stylesheet consumes.
     */
    const ANIME_TOKENS = Object.freeze({
      /* purple-night bluish scale */
      "--dsw-static-neutral-bluish-00": "#ffffff",
      "--dsw-static-neutral-bluish-50": "#f4eefb",
      "--dsw-static-neutral-bluish-60": "#efe8f8",
      "--dsw-static-neutral-bluish-75": "#e7ddf4",
      "--dsw-static-neutral-bluish-100": "#e0d3f0",
      "--dsw-static-neutral-bluish-150": "#d3c2e8",
      "--dsw-static-neutral-bluish-200": "#c2ade0",
      "--dsw-static-neutral-bluish-300": "#a58bcc",
      "--dsw-static-neutral-bluish-400": "#8a6fb5",
      "--dsw-static-neutral-bluish-500": "#6f569e",
      "--dsw-static-neutral-bluish-600": "#584383",
      "--dsw-static-neutral-bluish-700": "#453269",
      "--dsw-static-neutral-bluish-750": "#372754",
      "--dsw-static-neutral-bluish-800": "#2c1f46",
      "--dsw-static-neutral-bluish-850": "#251a3b",
      "--dsw-static-neutral-bluish-875": "#1f1632",
      "--dsw-static-neutral-bluish-900": "#1a122b",
      "--dsw-static-neutral-bluish-950": "#150e24",
      "--dsw-static-neutral-bluish-1000": "#0d0916",
      /* sakura-pink "deepseek" scale */
      "--dsw-static-deepseek-50": "#fff0f5",
      "--dsw-static-deepseek-100": "#ffe3ee",
      "--dsw-static-deepseek-200": "#ffc6db",
      "--dsw-static-deepseek-300": "#ff9fc2",
      "--dsw-static-deepseek-400": "#ff7eae",
      "--dsw-static-deepseek-450": "#ff6a9f",
      "--dsw-static-deepseek-500": "#f9538c",
      "--dsw-static-deepseek-600": "#d63a74",
      "--dsw-static-deepseek-700-delete": "#b02b5e",
      "--dsw-static-deepseek-800": "#861f49",
      "--dsw-static-deepseek-900": "#591430",
      /* keep deepseek blue, slightly brightened */
      "--dsw-static-blue-400": "#8fb0fa",
      "--dsw-static-blue-450": "#7ba0f8",
      "--dsw-static-blue-500": "#5b84f2",
      "--dsw-static-blue-600": "#4a6fe0",
      "--dsw-static-blue-800": "#3150b6",
      "--dsw-static-blue-900": "#22347f",
      "--dsw-static-blue-950": "#1b2349",
      /* alias surfaces */
      "--dsw-alias-bg-base": "#150e24",
      "--dsw-alias-bg-layer-1": "#1a122b",
      "--dsw-alias-bg-layer-2": "#1f1632",
      "--dsw-alias-bg-layer-3": "#251a3b",
      "--dsw-alias-bg-module-platform": "#1f1632",
      "--dsw-alias-bg-multi-select": "#1f1632",
      "--dsw-alias-bg-overlay": "#372754",
      "--dsw-alias-bg-mask-drop": "rgba(30, 20, 52, 0.7)",
      "--dsw-alias-bg-skeleton": "rgba(255, 255, 255, 0.08)",
      "--dsw-alias-border-l1": "rgba(255, 255, 255, 0.06)",
      "--dsw-alias-border-l2": "rgba(255, 255, 255, 0.11)",
      "--dsw-alias-border-l2-darkmode-thin": "rgba(255, 255, 255, 0.06)",
      "--dsw-alias-border-l3": "rgba(255, 255, 255, 0.15)",
      "--dsw-alias-border-l4": "rgba(255, 255, 255, 0.19)",
      "--dsw-alias-border-inverted": "rgba(0, 0, 0, 0.4)",
      "--dsw-alias-border-inverted2": "rgba(0, 0, 0, 0.3)",
      /* brand & buttons */
      "--dsw-alias-brand-primary": "#ff6a9f",
      "--dsw-alias-brand-primary-invert": "#ffffff",
      "--dsw-alias-brand-primary-new-colorprimary-new-color": "#ff6a9f",
      "--dsw-alias-brand-text": "#ffd6e6",
      "--dsw-alias-button-contrast-fill": "#0d0916",
      "--dsw-alias-button-elevated-fill": "#251a3b",
      "--dsw-alias-button-floating-fill": "#2c1f46",
      "--dsw-alias-button-floating-hover": "#372754",
      "--dsw-alias-button-ghost-active-border": "#a58bcc",
      "--dsw-alias-button-ghost-active-fill": "#2c1f46",
      "--dsw-alias-button-ghost-active-hover": "#372754",
      "--dsw-alias-button-info-fill": "#ff6a9f",
      "--dsw-alias-button-info-hover": "#ff85b4",
      "--dsw-alias-button-primary-dimmed": "#3a2a52",
      "--dsw-alias-button-primary-fill": "#ff6a9f",
      "--dsw-alias-button-primary-hover": "#ff85b4",
      /* interactive */
      "--dsw-alias-interactive-bg-active": "rgba(255, 122, 168, 0.16)",
      "--dsw-alias-interactive-bg-hover": "rgba(255, 255, 255, 0.07)",
      "--dsw-alias-interactive-bg-hover-accent": "rgba(255, 122, 168, 0.2)",
      "--dsw-alias-interactive-bg-hover-solid": "#2c1f46",
      "--dsw-alias-interactive-bg-hover-danger": "rgba(242, 90, 90, 0.15)",
      /* labels */
      "--dsw-alias-label-caption": "#8a6fb5",
      "--dsw-alias-label-dimmed": "#6f569e",
      "--dsw-alias-label-primary": "#f6effc",
      "--dsw-alias-label-primary-bluish": "#ffc9de",
      "--dsw-alias-label-primary-dimmed": "#e0d3f0",
      "--dsw-alias-label-primary-foreground": "#ffffff",
      "--dsw-alias-label-primary-inverted": "#2c1f46",
      "--dsw-alias-label-secondary": "#c2ade0",
      "--dsw-alias-label-tertiary": "#a58bcc",
      /* markdown surfaces */
      "--dsw-alias-markdown-citation": "#2c1f46",
      "--dsw-alias-markdown-code-block": "#1a122b",
      "--dsw-alias-markdown-code-block-banner": "#251a3b",
      "--dsw-alias-markdown-code-segment-selected": "#2c1f46",
      "--dsw-alias-markdown-code-segment-unselected": "#1a122b",
      "--dsw-alias-markdown-inline-code": "#372754",
      "--dsw-alias-markdown-placeholder": "#251a3b",
      "--dsw-alias-markdown-tag": "#2c1f46",
      /* scrollbars */
      "--dsw-alias-scrollbar-bg-l1": "#372754",
      "--dsw-alias-scrollbar-bg-l2": "#453269",
      "--dsw-alias-scrollbar-hover-l1": "#584383",
      "--dsw-alias-scrollbar-hover-l2": "#6f569e",
      /* status */
      "--dsw-alias-state-business-primary": "#ff6a9f",
      "--dsw-alias-state-business-tertiary": "#861f49",
      "--dsw-alias-state-error-primary": "#f87171",
      "--dsw-alias-state-error-secondary": "#f87171",
      "--dsw-alias-state-success-primary": "#4ade80",
      "--dsw-alias-state-success-secondary": "#86efac",
      "--dsw-alias-state-success-tertiary": "#14532d",
      "--dsw-alias-state-warn-label": "#fbbf24",
      "--dsw-alias-state-warn-primary": "#f59e0b",
      "--dsw-alias-state-warn-secondary": "#fbbf24",
      "--dsw-alias-state-warn-tertiary": "#451a03",
      /* toast & tooltip */
      "--dsw-alias-toast-bg": "#372754",
      "--dsw-alias-tooltip-bg": "#453269",
      /* specific surfaces */
      "--dsw-specific-bubble": "#3a2138",
      "--dsw-specific-bubble-highlight": "#4a2b46",
      "--dsw-specific-input-major": "#1f1632",
      "--dsw-specific-login-input": "#1a122b",
      "--dsw-specific-menu": "#251a3b",
      "--dsw-specific-selector": "#251a3b",
      "--dsw-specific-sidebar-fill": "#120c1e",
      "--dsw-specific-sidebar-nav-item-active": "#2c1f46",
      "--dsw-specific-sidebar-nav-item-active-accent": "#462a44",
      "--dsw-specific-tip": "#251a3b",
      /* thinking fade + anime glow */
      "--dsw-linear-gradient-think": "linear-gradient(180deg, #1f1632 20.19%, rgba(31, 22, 50, 0) 100%)",
      "--dsw-linear-think-select": "linear-gradient(180deg, #251a3b 20.19%, rgba(37, 26, 59, 0) 100%)",
      "--dsw-anime-bg-glow": "radial-gradient(1200px 640px at 88% -12%, rgba(255, 106, 159, 0.1), transparent 62%), radial-gradient(1000px 560px at -12% 112%, rgba(123, 160, 248, 0.09), transparent 62%)",

      /* surfaces the 0.2.x client introduced after this palette was written */
      "--dsw-menu-surface-fill": "rgba(37, 26, 59, 0.72)",
      "--dsw-alias-menu-group-header-fill": "rgba(37, 26, 59, 0.94)",
      "--dsw-alias-button-tool-bar-fill": "rgba(37, 26, 59, 0.5)",
      "--dsw-alias-button-tool-bar-fill-invisible": "rgba(21, 14, 36, 0.36)",
      "--dsw-alias-button-tool-bar-hover": "rgba(55, 39, 84, 0.62)",
      "--dsw-alias-state-idle-primary": "#6f569e",
    });

    /**
     * Plugin-owned stylesheet. Every rule is gated on `body[data-anime-theme]`
     * so it is inert whenever another theme is active (including the moment
     * before activation and after a switch back to light/dark/system).
     */
    const STYLES = `
body[data-anime-theme]{background-image:var(--dsw-anime-bg-glow,none);background-attachment:fixed}
body[data-anime-theme] [data-composer-seat] button[aria-busy]:not([aria-haspopup]){background:linear-gradient(135deg,#ffc9de 0%,#ff7eae 48%,#f94f8c 100%);box-shadow:0 3px 12px rgba(255,106,159,.4),0 0 0 3px rgba(255,255,255,.08);transition:background-color .1s,box-shadow .15s,transform .1s}
body[data-anime-theme] [data-composer-seat] button[aria-busy]:not([aria-haspopup]):hover:not(:disabled){background:linear-gradient(135deg,#ffd4e3 0%,#ff8fb8 48%,#ff5f96 100%);box-shadow:0 4px 16px rgba(255,106,159,.55),0 0 0 3px rgba(255,122,168,.25)}
body[data-anime-theme] [data-composer-seat] button[aria-busy]:not([aria-haspopup]):active:not(:disabled){transform:translateY(-2px) scale(.94)}
body[data-anime-theme] [data-composer-seat] button[aria-busy]:not([aria-haspopup]):not(:has(svg rect)):not(:has(svg circle)) svg{display:none}
body[data-anime-theme] [data-composer-seat] button[aria-busy]:not([aria-haspopup]):not(:has(svg rect)):not(:has(svg circle))::before{content:"";width:19px;height:19px;background:url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%3E%3Cg%20fill%3D%27%23fff7fa%27%3E%3Cellipse%20cx%3D%2712%27%20cy%3D%276%27%20rx%3D%273.6%27%20ry%3D%274.8%27%2F%3E%3Cellipse%20cx%3D%2712%27%20cy%3D%276%27%20rx%3D%273.6%27%20ry%3D%274.8%27%20transform%3D%27rotate%2872%2012%2012%29%27%2F%3E%3Cellipse%20cx%3D%2712%27%20cy%3D%276%27%20rx%3D%273.6%27%20ry%3D%274.8%27%20transform%3D%27rotate%28144%2012%2012%29%27%2F%3E%3Cellipse%20cx%3D%2712%27%20cy%3D%276%27%20rx%3D%273.6%27%20ry%3D%274.8%27%20transform%3D%27rotate%28216%2012%2012%29%27%2F%3E%3Cellipse%20cx%3D%2712%27%20cy%3D%276%27%20rx%3D%273.6%27%20ry%3D%274.8%27%20transform%3D%27rotate%28288%2012%2012%29%27%2F%3E%3Ccircle%20cx%3D%2712%27%20cy%3D%2712%27%20r%3D%272.4%27%20fill%3D%27%23ff9fc2%27%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E") center/contain no-repeat;display:block}
`;

    /** 9×11 pixel petal: V-shaped split tips narrowing into the base. */
    const PETAL_MAP = [
      '...X.X...',
      '..XXXXX..',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '..XXXXX..',
      '..XXXXX..',
      '...XXX...',
      '...XXX...',
      '....X....',
    ];
    /** White highlight pixels: left edge plus the two split tips. */
    const PETAL_LIGHT = [
      '...L.L...',
      '..LLL....',
      '.LLLL....',
      '.LLL.....',
      '.LL......',
      '.LL......',
      '..LL.....',
      '..L......',
      '.........',
      '.........',
      '.........',
    ];
    /** Petal fills sampled from the sakura scale. */
    const PETAL_COLORS = ['#ffb3cd', '#ff9fc2', '#ffd9e8', '#fff0f6', '#ff7eae'];
    /** Canvas is rendered at one third of the viewport for chunky pixels. */
    const CANVAS_SCALE = 3;
    /** Petal fragments kept alive at once. */
    const SHARD_LIMIT = 250;
    /** Idle frames after generation ends before the petals start fading. */
    const IDLE_FRAMES = 20;

    /** Whether the user asked the platform for reduced motion. */
    function prefersReducedMotion() {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /**
     * Mount the plugin-owned stylesheet.
     * @param ctx - owning client context.
     */
    function installStyles(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined' || document.head === null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = `${PLUGIN_ID}/neon-5cms.css`;
        tag.textContent = STYLES;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'neon-5cms: plugin stylesheet');
    }

    /**
     * Register the theme and make it the active preference.
     *
     * Activation waits for the stock theme plugin's settings document to settle,
     * otherwise its durable light/dark/system preference is adopted after this
     * plugin sets `anime` and the UI flips back. While a short settle window is
     * open the plugin re-asserts its preference (a late adoption is the only
     * thing it can be racing); afterwards the user's Appearance choice wins for
     * the session, exactly like the stock Appearance row behaves.
     *
     * @param theme - the Client `theme` service.
     * @param ctx - the injected scope (owns timer/listener disposal).
     * @returns disposer restoring the previous state.
     */
    function activateTheme(theme, ctx) {
      let disposeRegistration;
      let previousPreference;
      let settleDeadline = 0;
      let disposed = false;
      let started = false;
      let activateTimer;
      let subscribeTimer;
      let unsubscribeSettings;

      /** Mirror the active theme id onto the gating body attribute. */
      const paintActive = () => {
        if (typeof document === 'undefined' || document.body === null) return;
        let active = false;
        try {
          active = theme.getTheme().active.id === THEME_ID;
        } catch (error) {
          active = false;
        }
        if (active) document.body.setAttribute(ACTIVE_ATTRIBUTE, '');
        else document.body.removeAttribute(ACTIVE_ATTRIBUTE);
      };

      /** Re-assert the theme while the settings adoption race window is open. */
      const settle = () => {
        if (disposed || Date.now() > settleDeadline) return;
        try {
          if (theme.getTheme().preference !== THEME_ID) theme.setTheme(THEME_ID);
        } catch (error) {
          /* the registry changed under us: the next paint picks it up */
        }
      };

      const activate = () => {
        if (disposed) return;
        let snapshot;
        try {
          snapshot = theme.getTheme();
        } catch (error) {
          return;
        }
        if (snapshot.preference === THEME_ID) {
          paintActive();
          return;
        }
        previousPreference = snapshot.preference;
        settleDeadline = Date.now() + SETTLE_MS;
        try {
          disposeRegistration = theme.register({ id: THEME_ID, colorScheme: 'dark', tokens: ANIME_TOKENS });
        } catch (error) {
          /* A previous fiber may still own the id during a hot reload. Setting the
           * preference still applies that registration, so only log unexpected errors. */
          if (!/already registered/i.test(String((error && error.message) || error))) {
            console.warn('[neon-5cms] theme registration failed:', error);
          }
        }
        try {
          theme.setTheme(THEME_ID);
        } catch (error) {
          console.warn('[neon-5cms] theme activation failed:', error);
        }
        if (typeof document !== 'undefined' && document.body !== null) paintActive();
      };

      /** One-time activation, after the settings document has settled. */
      const start = () => {
        if (started || disposed) return;
        started = true;
        if (unsubscribeSettings) {
          unsubscribeSettings();
          unsubscribeSettings = undefined;
        }
        activateTimer = setTimeout(() => {
          activate();
        }, ACTIVATE_DELAY_MS);
      };

      /** Observe the stock theme plugin's settings status; fall back to a timer. */
      const gateOnSettings = () => {
        let form;
        try {
          const forms = ctx.get('configForms');
          form = forms && typeof forms.get === 'function' ? forms.get(THEME_SETTINGS_ENTRY_ID) : undefined;
        } catch (error) {
          form = undefined;
        }
        const status = () => {
          try {
            const snapshot = form && form.getSnapshot();
            return snapshot && snapshot.status;
          } catch (error) {
            return undefined;
          }
        };
        const initial = status();
        if (initial === undefined || initial === 'ready' || initial === 'unavailable') {
          start();
          return;
        }
        try {
          unsubscribeSettings = form.subscribe(() => {
            const next = status();
            if (next !== undefined && next !== 'loading') start();
          });
        } catch (error) {
          unsubscribeSettings = undefined;
        }
        subscribeTimer = setTimeout(start, SETTINGS_FALLBACK_MS);
      };

      const onThemeChange = () => {
        settle();
        paintActive();
      };
      ctx.on('theme/change', onThemeChange);
      gateOnSettings();

      return () => {
        disposed = true;
        clearTimeout(activateTimer);
        clearTimeout(subscribeTimer);
        if (unsubscribeSettings) unsubscribeSettings();
        if (typeof document !== 'undefined' && document.body !== null) {
          document.body.removeAttribute(ACTIVE_ATTRIBUTE);
        }
        if (disposeRegistration) {
          try {
            if (previousPreference && previousPreference !== THEME_ID) theme.setTheme(previousPreference);
          } catch (error) {
            /* the persisted preference is adopted again by the stock plugin */
          }
          try {
            disposeRegistration();
          } catch (error) {
            /* the registry is already gone with the composition */
          }
        }
      };
    }

    /**
     * Mount the interactive pixel petal rain.
     *
     * A send (click on the composer's primary button or Enter in the composer)
     * starts a 1/3-resolution canvas of 9×11 pixel petals. Moving the cursor
     * across a petal slices it along the cursor path into two halves that drift,
     * rotate and fade. When generation ends (the stop square disappears from the
     * composer) the petals fade out; switching the theme or bundle off stops the
     * effect immediately through the body attribute gate.
     *
     * @returns disposer removing listeners and the canvas.
     */
    function mountPetalRain() {
      if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return () => {};
      if (prefersReducedMotion()) return () => {};

      const state = {
        started: false,
        raf: 0,
        canvas: null,
        petals: [],
        shards: [],
        resize: null,
        idle: 0,
        fade: 1,
        seen: false,
        mouse: null,
      };

      /** The composer seat, or null when no conversation composer is mounted. */
      const seat = () => document.querySelector('[data-composer-seat]');

      /** Whether the plugin's theme is the active one. */
      const gate = () =>
        document.body !== null && document.body.hasAttribute(ACTIVE_ATTRIBUTE);

      /** Whether a generation is running: the composer shows its stop square. */
      const isGenerating = () => {
        const root = seat();
        return root !== null && root.querySelector('button svg rect') !== null;
      };

      const spawn = (petal, canvas) => {
        petal.x = Math.random() * canvas.width;
        petal.y = -8 - Math.random() * canvas.height * 0.3;
        petal.speed = 0.05 + Math.random() * 0.1;
        petal.sway = 0.6 + Math.random() * 1.4;
        petal.swaySpeed = 0.003 + Math.random() * 0.01;
        petal.phase = Math.random() * Math.PI * 2;
        petal.rot = Math.random() * Math.PI * 2;
        petal.rotSpeed = (Math.random() - 0.5) * 0.02;
        petal.color = PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)];
        petal.size = Math.random() < 0.65 ? 1 : 2;
        petal.flip = Math.random() < 0.5 ? 1 : -1;
        petal.alpha = petal.size === 2 ? 0.55 : 0.7 + Math.random() * 0.25;
      };

      const stop = () => {
        if (state.raf) cancelAnimationFrame(state.raf);
        state.raf = 0;
        if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
        if (state.resize) removeEventListener('resize', state.resize);
        state.canvas = null;
        state.resize = null;
        state.started = false;
        state.idle = 0;
        state.fade = 1;
        state.seen = false;
        state.petals = [];
        state.shards = [];
        state.mouse = null;
      };

      /** Slice one petal along the cursor path into two drifting halves. */
      const slicePetal = (petal) => {
        let dirX = state.mouse.x - state.mouse.lx;
        let dirY = state.mouse.y - state.mouse.ly;
        const length = Math.hypot(dirX, dirY);
        if (length < 0.001) return;
        dirX /= length;
        dirY /= length;
        const cosR = Math.cos(petal.rot);
        const sinR = Math.sin(petal.rot);
        const left = [];
        const right = [];
        for (let row = 0; row < PETAL_MAP.length; row++) {
          for (let column = 0; column < PETAL_MAP[row].length; column++) {
            if (PETAL_MAP[row][column] !== 'X') continue;
            const localX = petal.flip * (column - 4);
            const localY = row - 5;
            const worldX = petal.x + (localX * cosR - localY * sinR) * petal.size;
            const worldY = petal.y + (localX * sinR + localY * cosR) * petal.size;
            const distance = (worldX - petal.x) * dirY - (worldY - petal.y) * dirX;
            const color = PETAL_LIGHT[row][column] === 'L' ? '#ffffff' : petal.color;
            if (distance < 0) left.push([localX, localY, color]);
            else right.push([localX, localY, color]);
          }
        }
        if (left.length === 0 || right.length === 0) return;
        const index = state.petals.indexOf(petal);
        if (index >= 0) state.petals.splice(index, 1);
        const perpX = -dirY;
        const perpY = dirX;
        const push = 0.3 + Math.random() * 0.3;
        state.shards.push({
          pixels: left,
          x: petal.x,
          y: petal.y,
          vx: -perpX * push * petal.size,
          vy: -perpY * push * petal.size + petal.speed * 0.5,
          rot: petal.rot,
          vrot: petal.rotSpeed + (Math.random() - 0.5) * 0.04,
          size: petal.size,
          alpha: petal.alpha,
          fade: 1,
          fadeSpeed: 0.015,
        });
        state.shards.push({
          pixels: right,
          x: petal.x,
          y: petal.y,
          vx: perpX * push * petal.size,
          vy: perpY * push * petal.size + petal.speed * 0.5,
          rot: petal.rot,
          vrot: petal.rotSpeed + (Math.random() - 0.5) * 0.04,
          size: petal.size,
          alpha: petal.alpha,
          fade: 1,
          fadeSpeed: 0.015,
        });
        /* one white slash of light where the cursor crossed the petal */
        state.shards.push({
          pixels: [[0, 0, '#ffffff']],
          x: petal.x,
          y: petal.y,
          vx: 0,
          vy: 0,
          rot: 0,
          vrot: 0,
          size: 1,
          alpha: 0.95,
          fade: 1,
          fadeSpeed: 0.08,
        });
        if (state.shards.length > SHARD_LIMIT) state.shards.splice(0, state.shards.length - SHARD_LIMIT);
        /* the sliced petal is replaced from the top of the screen */
        const replacement = {};
        spawn(replacement, state.canvas);
        state.petals.push(replacement);
      };

      const frame = () => {
        if (!gate() || !state.canvas) {
          stop();
          return;
        }
        if (isGenerating()) {
          state.idle = 0;
          state.seen = true;
          if (state.fade < 1) state.fade = Math.min(1, state.fade + 0.1);
        } else if (state.seen) {
          state.idle += 1;
          if (state.idle > IDLE_FRAMES) state.fade -= 0.05;
        }
        if (state.fade <= 0) {
          stop();
          return;
        }
        const surface = state.canvas.getContext('2d');
        surface.clearRect(0, 0, state.canvas.width, state.canvas.height);
        surface.imageSmoothingEnabled = false;
        for (const petal of state.petals) {
          petal.y += petal.speed;
          petal.phase += petal.swaySpeed;
          petal.rot += petal.rotSpeed;
          const x = petal.x + Math.sin(petal.phase) * petal.sway * 2;
          if (petal.y > state.canvas.height + 10) spawn(petal, state.canvas);
          surface.save();
          surface.globalAlpha = petal.alpha * state.fade;
          surface.translate(x, petal.y);
          surface.rotate(petal.rot);
          surface.scale(petal.flip * petal.size, petal.size);
          for (let row = 0; row < PETAL_MAP.length; row++) {
            for (let column = 0; column < PETAL_MAP[row].length; column++) {
              if (PETAL_MAP[row][column] === 'X') {
                surface.fillStyle = petal.color;
                surface.fillRect(column - 4, row - 5, 1, 1);
              } else if (PETAL_LIGHT[row][column] === 'L') {
                surface.fillStyle = '#ffffff';
                surface.fillRect(column - 4, row - 5, 1, 1);
              }
            }
          }
          surface.restore();
        }
        for (let index = state.shards.length - 1; index >= 0; index--) {
          const shard = state.shards[index];
          shard.fade -= shard.fadeSpeed;
          if (shard.fade <= 0) {
            state.shards.splice(index, 1);
            continue;
          }
          shard.vy += 0.0015;
          shard.x += shard.vx;
          shard.y += shard.vy;
          shard.rot += shard.vrot;
          surface.save();
          surface.globalAlpha = shard.alpha * shard.fade * state.fade;
          surface.translate(shard.x, shard.y);
          surface.rotate(shard.rot);
          surface.scale(shard.size, shard.size);
          for (const pixel of shard.pixels) {
            surface.fillStyle = pixel[2];
            surface.fillRect(pixel[0], pixel[1], 1, 1);
          }
          surface.restore();
        }
        state.raf = requestAnimationFrame(frame);
      };

      const start = () => {
        if (state.started || !gate()) return;
        state.started = true;
        state.idle = 0;
        state.fade = 1;
        state.seen = false;
        state.shards = [];
        state.mouse = null;
        const canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.position = 'fixed';
        canvas.style.inset = '0';
        canvas.style.width = '100vw';
        canvas.style.height = '100vh';
        canvas.style.zIndex = '9999';
        canvas.style.pointerEvents = 'none';
        canvas.style.imageRendering = 'pixelated';
        const resize = () => {
          canvas.width = Math.max(1, Math.floor(innerWidth / CANVAS_SCALE));
          canvas.height = Math.max(1, Math.floor(innerHeight / CANVAS_SCALE));
        };
        resize();
        addEventListener('resize', resize);
        state.canvas = canvas;
        state.resize = resize;
        document.body.appendChild(canvas);
        for (let i = 0; i < 30; i++) {
          const petal = {};
          spawn(petal, canvas);
          petal.y = Math.random() * canvas.height;
          state.petals.push(petal);
        }
        state.raf = requestAnimationFrame(frame);
      };

      /** The composer's primary button was clicked: start the rain. */
      const onDocumentClick = (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest('[data-composer-seat] button[aria-busy]:not([aria-haspopup])');
        if (button === null || button.querySelector('svg rect') !== null) return;
        start();
      };

      /** Enter in the composer submits: start the rain. */
      const onDocumentKeyDown = (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('[data-composer-input]') === null) return;
        if (isGenerating()) return;
        start();
      };

      /** Slice any petal the cursor segment crosses. */
      const onDocumentMouseMove = (event) => {
        if (!state.started || !state.canvas) return;
        const x = event.clientX / CANVAS_SCALE;
        const y = event.clientY / CANVAS_SCALE;
        if (state.mouse === null) {
          state.mouse = { x, y, lx: x, ly: y };
          return;
        }
        const fromX = state.mouse.lx;
        const fromY = state.mouse.ly;
        state.mouse.lx = state.mouse.x;
        state.mouse.ly = state.mouse.y;
        state.mouse.x = x;
        state.mouse.y = y;
        const segmentX = x - fromX;
        const segmentY = y - fromY;
        const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
        if (segmentLengthSquared < 1) return;
        for (let index = state.petals.length - 1; index >= 0; index--) {
          const petal = state.petals[index];
          const t = Math.max(
            0,
            Math.min(1, ((petal.x - fromX) * segmentX + (petal.y - fromY) * segmentY) / segmentLengthSquared),
          );
          const nearestX = fromX + segmentX * t;
          const nearestY = fromY + segmentY * t;
          const dx = petal.x - nearestX;
          const dy = petal.y - nearestY;
          if (dx * dx + dy * dy < 36 * petal.size * petal.size) slicePetal(petal);
        }
      };

      document.addEventListener('click', onDocumentClick, true);
      document.addEventListener('keydown', onDocumentKeyDown, true);
      document.addEventListener('mousemove', onDocumentMouseMove);

      return () => {
        document.removeEventListener('click', onDocumentClick, true);
        document.removeEventListener('keydown', onDocumentKeyDown, true);
        document.removeEventListener('mousemove', onDocumentMouseMove);
        stop();
      };
    }

    return {
      inject: [],
      /**
       * Mount the stylesheet, the theme registration and the petal rain.
       * @param ctx - client root context of this plugin's fiber.
       */
      apply(ctx) {
        installStyles(ctx);
        ctx.inject(['theme'], (scope) => {
          scope.effect(() => activateTheme(scope.get('theme'), scope), 'neon-5cms: theme activation');
        });
        ctx.effect(() => mountPetalRain(), 'neon-5cms: pixel petal rain');
      },
    };
  },
});
