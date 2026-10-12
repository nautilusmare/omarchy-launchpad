/*!
 * launch-scene.js
 * Dependency-free canvas animations for the phases of a rocket launch.
 * Works in any browser and inside Qt WebEngine. No build step, no assets.
 *
 * Quick start
 *   const scene = new LaunchScene(document.getElementById('scene'));
 *   scene.setT(secondsRelativeToLiftoff);          // call about once a second, phase is derived
 *
 * Or drive it yourself
 *   scene.setPhase('ascent', { progress: 0.4 });   // you own the progress (0..1)
 *   scene.setPhase('liftoff');                     // no progress given: plays on its own timer
 *
 * Phases: idle, fueling, countdown, liftoff, ascent, landing, recap
 *
 * Events (hook sound, notifications, a result card, ...)
 *   scene.on('phase',     name => ...)
 *   scene.on('tick',      secondsLeft => ...)      // countdown, 10..1
 *   scene.on('liftoff',   () => ...)
 *   scene.on('milestone', id => ...)               // maxq, meco, sep, fairing, seco
 *   scene.on('touchdown', result => ...)           // 'success' | 'fail'
 *   scene.on('deploy',    () => ...)
 *
 * Optional
 *   scene.setDaylight(0..1)                        // 0 night, 1 day (or LaunchScene.daylightAt(date, lonDeg))
 *   scene.setLandingResult('success' | 'fail')
 *   scene.setTelemetry({ altitudeKm, speedKmh })   // shown during ascent only if you provide it
 *   scene.destroy()
 */
/* --- Quickshell/QML integration -----------------------------------------
 * Browsers hand this module `window`; inside Quickshell there is no DOM, so
 * the environment is injected here instead. The QML side calls setEnv() before
 * createScene() to install a real device pixel ratio and to collect the frame
 * callback the library asks for, then drives frames from a Canvas.
 * ---------------------------------------------------------------------- */
var LAUNCH_SCENE_ENV = {
  devicePixelRatio: 1,
  requestAnimationFrame: function (fn) {
    LAUNCH_SCENE_ENV.frameSink = fn;
    return 1;
  },
  cancelAnimationFrame: function () { LAUNCH_SCENE_ENV.frameSink = null; },
  frameSink: null
};

(function (global) {
  'use strict';

  const PHASES = ['idle', 'fueling', 'countdown', 'liftoff', 'ascent', 'landing', 'recap'];
  const PAD_PHASES = ['idle', 'fueling', 'countdown', 'liftoff'];

  // Seconds each phase plays when you do NOT feed it real progress.
  const AUTO_DURATION = { fueling: 20, countdown: 10, liftoff: 9, ascent: 26, landing: 14, recap: 10 };

  // Used by setT(): seconds relative to liftoff (negative = before). Edit to match your data.
  const SCHEDULE = { fuelingStart: -2100, countdownStart: -10, liftoffEnd: 10, ascentEnd: 500, landingEnd: 580 };

  // `at` is the fraction of the ascent at which the event fires.
  const MILESTONES = [
    { id: 'maxq', at: 0.12, label: 'Max-Q' },
    { id: 'meco', at: 0.42, label: 'Main engine cutoff' },
    { id: 'sep', at: 0.46, label: 'Stage separation' },
    { id: 'fairing', at: 0.58, label: 'Fairing deploy' },
    { id: 'seco', at: 0.92, label: 'Orbit reached' },
  ];

  const NIGHT_TOP = [6, 9, 20], NIGHT_BOT = [27, 42, 74];
  const DAY_TOP = [79, 134, 198], DAY_BOT = [214, 230, 242];
  const SPACE = [1, 2, 10];
  const FONT = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const rand = (a, b) => a + Math.random() * (b - a);
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const rgb = (c, a) =>
    a === undefined
      ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
      : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  function P(kind, x, y, vx, vy, life, size, grow, drag, g) {
    return { kind, x, y, vx, vy, life, max: life, size, grow, drag, g: g || 0 };
  }

  /* ------------------------------------------------------------------ */
  /* Rocket drawing. Origin = engine base, up is -y, h = full stack height */
  /* ------------------------------------------------------------------ */

  function bodyGrad(ctx, w) {
    const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, '#fbfcfe');
    g.addColorStop(0.55, '#dfe4ec');
    g.addColorStop(1, '#8f98a8');
    return g;
  }

  function drawBooster(ctx, h, o) {
    o = o || {};
    const w = h * 0.085;
    const legs = o.legs || 0;

    // legs behind the body
    ctx.save();
    ctx.strokeStyle = '#2b2f37';
    ctx.lineWidth = Math.max(1, h * 0.012);
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * w / 2, -0.11 * h);
      ctx.lineTo(s * (w / 2 + 0.1 * h * legs), lerp(-0.03 * h, 0.005 * h, legs));
      ctx.stroke();
    }
    ctx.restore();

    // engine bells
    ctx.fillStyle = '#23262d';
    for (const k of [-0.26, 0, 0.26]) {
      const cx = k * w;
      ctx.beginPath();
      ctx.moveTo(cx - 0.12 * w, -0.03 * h);
      ctx.lineTo(cx + 0.12 * w, -0.03 * h);
      ctx.lineTo(cx + 0.2 * w, 0);
      ctx.lineTo(cx - 0.2 * w, 0);
      ctx.closePath();
      ctx.fill();
    }

    // body
    ctx.fillStyle = bodyGrad(ctx, w);
    ctx.fillRect(-w / 2, -0.62 * h, w, 0.59 * h);
    ctx.fillStyle = '#2b2f37';
    ctx.fillRect(-w / 2, -0.09 * h, w, 0.06 * h);
    ctx.strokeStyle = 'rgba(60,70,90,0.18)';
    ctx.lineWidth = Math.max(0.5, h * 0.002);
    ctx.beginPath();
    for (let k = 1; k < 5; k++) {
      const y = -0.03 * h - 0.59 * h * k / 5;
      ctx.moveTo(-w / 2, y);
      ctx.lineTo(w / 2, y);
    }
    ctx.stroke();

    // frost from the cold propellant
    if (o.frost > 0) {
      const fh = 0.5 * h * o.frost;
      const fg = ctx.createLinearGradient(0, -0.03 * h, 0, -0.03 * h - fh);
      fg.addColorStop(0, 'rgba(170,215,245,0.6)');
      fg.addColorStop(1, 'rgba(170,215,245,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(-w / 2, -0.03 * h - fh, w, fh);
    }

    // interstage + grid fins
    ctx.fillStyle = '#1d2026';
    ctx.fillRect(-w / 2, -0.68 * h, w, 0.06 * h);
    if (o.fins > 0) {
      ctx.fillStyle = '#3a3f49';
      const len = 0.045 * h * o.fins;
      ctx.fillRect(w / 2, -0.665 * h, len, 0.016 * h);
      ctx.fillRect(-w / 2 - len, -0.665 * h, len, 0.016 * h);
    }

    // engine glow
    if (o.glow > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const r = 0.3 * h * o.glow;
      const g = ctx.createRadialGradient(0, 0.01 * h, 0, 0, 0.01 * h, r);
      g.addColorStop(0, `rgba(255,170,80,${0.45 * o.glow})`);
      g.addColorStop(1, 'rgba(255,170,80,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-r, 0.01 * h - r, r * 2, r * 2);
      ctx.restore();
    }
  }

  // Origin = base of the second stage.
  function drawUpper(ctx, h, o) {
    o = o || {};
    const w = h * 0.085;
    ctx.fillStyle = '#23262d';
    ctx.beginPath();
    ctx.moveTo(-0.12 * w, 0);
    ctx.lineTo(0.12 * w, 0);
    ctx.lineTo(0.22 * w, 0.025 * h);
    ctx.lineTo(-0.22 * w, 0.025 * h);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = bodyGrad(ctx, w);
    ctx.fillRect(-w / 2, -0.18 * h, w, 0.18 * h);

    if (o.fairing !== false) {
      const fw = w * 1.18;
      ctx.fillStyle = bodyGrad(ctx, fw);
      ctx.beginPath();
      ctx.moveTo(-fw / 2, -0.18 * h);
      ctx.lineTo(-fw / 2, -0.25 * h);
      ctx.bezierCurveTo(-fw / 2, -0.30 * h, -fw * 0.2, -0.32 * h, 0, -0.32 * h);
      ctx.bezierCurveTo(fw * 0.2, -0.32 * h, fw / 2, -0.30 * h, fw / 2, -0.25 * h);
      ctx.lineTo(fw / 2, -0.18 * h);
      ctx.closePath();
      ctx.fill();
    } else if (o.nub !== false) {
      ctx.fillStyle = '#aab0bb';
      ctx.fillRect(-0.22 * w, -0.22 * h, 0.44 * w, 0.04 * h);
    }

    if (o.glow > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const r = 0.12 * h * o.glow;
      const g = ctx.createRadialGradient(0, 0.025 * h, 0, 0, 0.025 * h, r);
      g.addColorStop(0, `rgba(150,200,255,${0.5 * o.glow})`);
      g.addColorStop(1, 'rgba(150,200,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-r, 0.025 * h - r, r * 2, r * 2);
      ctx.restore();
    }
  }

  function drawStack(ctx, h, o) {
    drawBooster(ctx, h, o);
    ctx.save();
    ctx.translate(0, -0.68 * h);
    drawUpper(ctx, h, Object.assign({}, o, { glow: 0 }));
    ctx.restore();
  }

  function drawFairingHalf(ctx, h, side) {
    const w = h * 0.085, fw = w * 1.18;
    ctx.save();
    ctx.translate(0, 0.25 * h);
    ctx.scale(side, 1);
    ctx.fillStyle = bodyGrad(ctx, fw);
    ctx.beginPath();
    ctx.moveTo(0, -0.18 * h);
    ctx.lineTo(fw / 2, -0.18 * h);
    ctx.lineTo(fw / 2, -0.25 * h);
    ctx.bezierCurveTo(fw / 2, -0.30 * h, fw * 0.2, -0.32 * h, 0, -0.32 * h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* Scene                                                               */
  /* ------------------------------------------------------------------ */

  class LaunchScene {
    constructor(container, opts) {
      opts = opts || {};
      this.container = container;
      this.opts = opts;
      // Particle budget. Browsers can afford the full plume; Quickshell's
      // software canvas draws every one of these on the GUI thread, so the
      // host passes a much smaller cap.
      this.maxParticles = opts.maxParticles || 1200;
      const mq = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
      this.reducedMotion = opts.reducedMotion !== undefined ? !!opts.reducedMotion : !!(mq && mq.matches);

      // Quickshell has no DOM: the caller may hand us a live canvas context
      // and the size it should draw into instead.
      if (opts.ctx) {
        this.ctx = opts.ctx;
        this.canvas = { width: (opts.width || 400) | 0, height: (opts.height || 240) | 0 };
        this.container = {
          getBoundingClientRect: function () {
            return { width: opts.width || 400, height: opts.height || 240 };
          }
        };
      } else {
        this.canvas = global.document.createElement('canvas');
        this.canvas.style.cssText = 'display:block;width:100%;height:100%';
        container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');
      }

      this.phase = 'idle';
      this.progress = 0;
      this.externalProgress = false;
      this.autoDuration = 0;
      this.phaseTime = 0;
      this.t = 0;
      this.flash = 0;
      this.ring = 0;
      this.lastTick = null;
      this.result = 'success';
      this.telemetry = null;
      this.daylight = this.dayTarget = opts.daylight !== undefined ? opts.daylight : 0;
      this.particles = [];
      this.debris = [];
      this.pops = [];
      this.passed = new Set();
      this.listeners = {};
      this._prevCam = 0;
      this._last = 0;

      this.stars = Array.from({ length: 150 }, () => ({
        x: Math.random(), y: Math.random(), r: rand(0.6, 1.8), tw: rand(0, 6.28),
      }));
      this.clouds = Array.from({ length: 6 }, () => ({
        x: Math.random(), y: rand(0.15, 0.65), s: rand(0.6, 1.5), v: rand(0.004, 0.01),
      }));

      this._resize();
      if (global.ResizeObserver) {
        this._ro = new global.ResizeObserver(() => this._resize());
        this._ro.observe(container);
      } else if (global.addEventListener) {
        this._onResize = () => this._resize();
        global.addEventListener('resize', this._onResize);
      }

      this._frame = (ts) => {
        const dt = this._last ? Math.min(0.05, (ts - this._last) / 1000) : 0.016;
        this._last = ts;
        this.t += dt;
        this.phaseTime += dt;
        this._update(dt);
        this._draw();
        this._raf = global.requestAnimationFrame(this._frame);
      };
      this._raf = global.requestAnimationFrame(this._frame);
    }

    /* ---------------- public API ---------------- */

    on(name, fn) {
      (this.listeners[name] = this.listeners[name] || []).push(fn);
      return this;
    }

    setPhase(name, o) {
      o = o || {};
      if (PHASES.indexOf(name) < 0) throw new Error('Unknown phase: ' + name);
      const kind = (n) => (PAD_PHASES.indexOf(n) >= 0 ? 'pad' : n);
      const switchedScene = kind(name) !== kind(this.phase);
      const changed = name !== this.phase;

      this.phase = name;
      this.phaseTime = 0;
      this.passed.clear();
      this.debris.length = 0;
      this.pops.length = 0;
      this.lastTick = null;
      this.externalProgress = o.progress !== undefined;
      this.progress = o.progress !== undefined ? clamp(o.progress) : 0;
      this.autoDuration = o.duration !== undefined ? o.duration : (AUTO_DURATION[name] || 0);

      if (name === 'ascent' || name === 'landing' || name === 'recap') this.particles.length = 0;
      if (switchedScene) this.flash = 1;
      if (changed) this._emit('phase', name);
      if (name === 'liftoff') {
        this._emit('liftoff');
        this._rumble(6);
      }
    }

    setProgress(p) {
      this.progress = clamp(p);
      this.externalProgress = true;
    }

    // Seconds relative to liftoff. Derives phase and progress from SCHEDULE.
    setT(t) {
      const S = SCHEDULE;
      if (t < S.fuelingStart) return this._feed('idle', 0);
      if (t < S.countdownStart) return this._feed('fueling', (t - S.fuelingStart) / (S.countdownStart - S.fuelingStart));
      if (t < 0) return this._feed('countdown', (t - S.countdownStart) / -S.countdownStart);
      if (t < S.liftoffEnd) return this._feed('liftoff', t / S.liftoffEnd);
      if (t < S.ascentEnd) return this._feed('ascent', (t - S.liftoffEnd) / (S.ascentEnd - S.liftoffEnd));
      if (t < S.landingEnd) return this._feed('landing', (t - S.ascentEnd) / (S.landingEnd - S.ascentEnd));
      return this._feed('recap', (t - S.landingEnd) / 30);
    }

    setDaylight(v) { this.dayTarget = clamp(v); }
    setLandingResult(r) { this.result = r === 'fail' ? 'fail' : 'success'; }
    setTelemetry(t) { this.telemetry = t || null; }

    // Public entry point for _resize(), so a QML host can re-read its size
    // after a layout change without reaching into internals.
    resize() { this._resize(); }

    destroy() {
      global.cancelAnimationFrame(this._raf);
      if (this._ro) this._ro.disconnect();
      if (this._onResize) global.removeEventListener('resize', this._onResize);
      if (this.canvas.remove) this.canvas.remove();
    }

    // Rough local daylight from a Date and a longitude in degrees (east positive).
    static daylightAt(date, lonDeg) {
      const h = (date.getUTCHours() + date.getUTCMinutes() / 60 + lonDeg / 15 + 24) % 24;
      return clamp(Math.sin((h - 6) / 12 * Math.PI) * 3 + 0.5);
    }

    /* ---------------- internals ---------------- */

    _feed(phase, p) {
      if (phase !== this.phase) this.setPhase(phase, { progress: p });
      else this.setProgress(p);
    }

    _emit(name, arg) {
      for (const fn of this.listeners[name] || []) {
        try { fn(arg); } catch (e) { if (global.console) global.console.error(e); }
      }
    }

    _resize() {
      const r = this.container.getBoundingClientRect();
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.W = Math.max(1, r.width);
      this.H = Math.max(1, r.height);
      this.dpr = dpr;
      this.canvas.width = (this.W * dpr) | 0;
      this.canvas.height = (this.H * dpr) | 0;
    }

    _n(rate, dt) {
      return Math.floor(rate * dt * 60 * (this.reducedMotion ? 0.5 : 1) + Math.random());
    }

    _spawn(p) {
      if (this.particles.length < this.maxParticles) this.particles.push(p);
    }

    _beep(freq, dur) {
      if (!this.opts.sound) return;
      try {
        const A = this._actx || (this._actx = new (global.AudioContext || global.webkitAudioContext)());
        const o = A.createOscillator(), g = A.createGain();
        o.frequency.value = freq;
        g.gain.value = 0.04;
        o.connect(g); g.connect(A.destination);
        g.gain.exponentialRampToValueAtTime(0.0001, A.currentTime + dur);
        o.start(); o.stop(A.currentTime + dur);
      } catch (e) { /* audio is optional */ }
    }

    _rumble(sec) {
      if (!this.opts.sound) return;
      try {
        const A = this._actx || (this._actx = new (global.AudioContext || global.webkitAudioContext)());
        const buf = A.createBuffer(1, A.sampleRate * sec, A.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = A.createBufferSource(), lp = A.createBiquadFilter(), g = A.createGain();
        src.buffer = buf;
        lp.type = 'lowpass'; lp.frequency.value = 160;
        g.gain.setValueAtTime(0.0001, A.currentTime);
        g.gain.exponentialRampToValueAtTime(0.5, A.currentTime + 1);
        g.gain.exponentialRampToValueAtTime(0.0001, A.currentTime + sec);
        src.connect(lp); lp.connect(g); g.connect(A.destination);
        src.start();
      } catch (e) { /* audio is optional */ }
    }

    /* ---------------- geometry ---------------- */

    _padGeom() {
      const W = this.W, H = this.H, u = H / 100;
      // Pad close-up. At a 200px hero the 0.36H rocket read small and far
      // away, so the pad world renders larger around the rocket's centre:
      // RH grows, the ground drops by half the growth to keep the body
      // framed, and u scales so line weights, text and particles stay
      // consistent. Idle and fueling go closest; countdown keeps air around
      // the T-10 ring; liftoff stays wider for the spreading plume. Sky,
      // stars and clouds are distant and intentionally unscaled.
      // Ascent/landing/recap keep their own framing.
      const Z = this.phase === 'countdown' ? 1.4 : this.phase === 'liftoff' ? 1.3 : 1.6;
      const RH0 = H * 0.36;
      const groundY = H * 0.82 + RH0 * (Z - 1) / 2, RH = RH0 * Z, rx = W * 0.56;
      let lift = 0;
      if (this.phase === 'liftoff') {
        const q = clamp((this.progress - 0.18) / 0.82);
        lift = Math.pow(q, 2.3) * H * 1.35;
      }
      const camY = Math.max(0, lift - H * 0.16);
      return { W, H, u: u * Z, groundY, RH, rx, lift, camY, alt: clamp(lift / (H * 1.6)), baseY: groundY - lift + camY };
    }

    _thrust() {
      const p = this.progress;
      if (this.phase === 'countdown') return p > 0.7 ? (p - 0.7) / 0.3 * 0.55 : 0;
      if (this.phase === 'liftoff') return Math.min(1, 0.55 + p * 4);
      return 0;
    }

    _path(t) {
      const W = this.W, H = this.H;
      const p0 = [0.08 * W, 0.82 * H], c1 = [0.16 * W, 0.20 * H], c2 = [0.55 * W, 0.18 * H], p3 = [0.93 * W, 0.40 * H];
      const m = 1 - t, a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
      const x = a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0];
      const y = a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1];
      const dx = 3 * m * m * (c1[0] - p0[0]) + 6 * m * t * (c2[0] - c1[0]) + 3 * t * t * (p3[0] - c2[0]);
      const dy = 3 * m * m * (c1[1] - p0[1]) + 6 * m * t * (c2[1] - c1[1]) + 3 * t * t * (p3[1] - c2[1]);
      return { x, y, ang: Math.atan2(dy, dx) };
    }

    _pathT(p) { return Math.pow(clamp(p), 1.4); }

    _ascGeom() {
      const h = this.H * 0.16;
      const pt = this._path(this._pathT(this.progress));
      const dx = Math.cos(pt.ang), dy = Math.sin(pt.ang);
      return {
        h, x: pt.x, y: pt.y, dx, dy, rot: pt.ang + Math.PI / 2,
        sbx: pt.x - dx * h * 0.5, sby: pt.y - dy * h * 0.5,     // base of the full stack
        ubx: pt.x + dx * h * 0.18, uby: pt.y + dy * h * 0.18,   // base of the second stage
      };
    }

    _landGeom() {
      const W = this.W, H = this.H, u = H / 100, p = this.progress, h = H * 0.40;
      const fail = this.result === 'fail';
      const deckY = H * 0.80 + Math.sin(this.t * 1.1) * 0.5 * u, shipX = W * 0.5;
      const touchY = deckY - 0.8 * u - 0.005 * h;
      const d = clamp(p / 0.88);
      const e = 1 - Math.pow(1 - d, 1.25), ex = 1 - Math.pow(1 - d, 1.2);
      let y = lerp(H * 0.04, touchY, e);
      const x = lerp(W * 0.74, shipX, ex);
      const s = clamp((p - 0.9) / 0.1);
      if (!fail) y += Math.sin(Math.min(1, s * 2.5) * Math.PI) * (1 - s) * 1.8 * u;
      let rot = (1 - smooth(clamp(p / 0.3))) * 1.4 + Math.sin(this.t * 2.3) * 0.01;
      if (fail) rot += 0.5 * smooth(clamp((p - 0.7) / 0.18));
      const lit = p >= 0.52 && p < (fail ? 0.88 : 0.9);
      return {
        W, H, u, h, x, y, rot, deckY, shipX,
        fins: clamp((p - 0.15) / 0.08),
        legs: clamp((p - 0.74) / 0.08),
        thrust: lit ? 0.5 + 0.5 * clamp((p - 0.52) / 0.1) : 0,
        hidden: fail && p >= 0.88,
      };
    }

    /* ---------------- update ---------------- */

    _update(dt) {
      const ph = this.phase;
      if (!this.externalProgress && this.autoDuration) {
        this.progress = clamp(this.phaseTime / this.autoDuration);
      }
      this.flash = Math.max(0, this.flash - dt * 1.8);
      this.ring = Math.max(0, this.ring - dt * 2.4);
      this.daylight += (this.dayTarget - this.daylight) * Math.min(1, dt * 2.5);

      let camDelta = 0;
      if (PAD_PHASES.indexOf(ph) >= 0) {
        const g = this._padGeom();
        camDelta = g.camY - this._prevCam;
        this._prevCam = g.camY;
        this._updatePad(dt, g);
      } else {
        this._prevCam = 0;
        if (ph === 'ascent') this._updateAscent(dt);
        else if (ph === 'landing') this._updateLanding(dt);
        else if (ph === 'recap') this._updateRecap();
      }

      for (let i = this.particles.length - 1; i >= 0; i--) {
        const q = this.particles[i];
        q.life -= dt;
        if (q.life <= 0) {
          this.particles[i] = this.particles[this.particles.length - 1];
          this.particles.pop();
          continue;
        }
        const d = Math.max(0, 1 - q.drag * dt);
        q.vx *= d; q.vy *= d;
        q.vy += q.g * dt;
        q.x += q.vx * dt;
        q.y += q.vy * dt + camDelta;
        q.size += q.grow * dt;
      }
    }

    _flame(x, y, dx, dy, s, scale, dt, blue) {
      const u = this.H / 100 * scale, px = -dy, py = dx;
      for (let i = this._n(2.6 * s, dt); i > 0; i--) {
        const sp = rand(26, 56) * u * (0.6 + 0.4 * s), j = rand(-1, 1);
        this._spawn(P(blue ? 'fireblue' : 'fire',
          x + px * j * 1.4 * u, y + py * j * 1.4 * u,
          dx * sp + px * j * 3 * u, dy * sp + py * j * 3 * u,
          rand(0.2, 0.45), rand(1.1, 2.1) * u, -1.2 * u, 1.6, 0));
      }
      if (!blue) {
        for (let i = this._n(1.6 * s, dt); i > 0; i--) {
          const sp = rand(8, 18) * u;
          this._spawn(P('smoke', x, y, dx * sp + rand(-3, 3) * u, dy * sp + rand(-3, 3) * u,
            rand(1.4, 2.8), rand(1.5, 3) * u, 2.5 * u, 0.8, 0));
        }
      }
    }

    _updatePad(dt, g) {
      const ph = this.phase, p = this.progress, u = g.u;

      if (ph === 'countdown') {
        const n = Math.max(1, Math.ceil((1 - p) * 10));
        if (n !== this.lastTick) {
          this.lastTick = n;
          this.ring = 1;
          this._emit('tick', n);
          this._beep(n <= 3 ? 1320 : 880, 0.08);
        }
      }

      // venting vapor off the cold booster
      let rate = 0;
      if (ph === 'idle') rate = 0.02;
      else if (ph === 'fueling') rate = 0.08 + 0.25 * p;
      else if (ph === 'countdown') rate = p < 0.7 ? 0.3 : 0.12;
      for (let i = this._n(rate, dt); i > 0; i--) {
        const s = Math.random() < 0.5 ? -1 : 1;
        this._spawn(P('vapor', g.rx + s * g.RH * 0.045, g.baseY - g.RH * rand(0.08, 0.6),
          s * rand(5, 14) * u, -rand(6, 16) * u, rand(2, 3.6), rand(0.8, 1.6) * u, 1.2 * u, 0.25, 0));
      }

      const th = this._thrust();
      if (th > 0) {
        this._flame(g.rx, g.baseY, 0, 1, th, 1, dt, false);
        if (g.lift < g.H * 0.4) {
          for (let i = this._n(1.2 * th, dt); i > 0; i--) {
            const s = Math.random() < 0.5 ? -1 : 1;
            this._spawn(P('dust', g.rx + s * rand(0, 6) * u, g.groundY + g.camY - 0.4 * u,
              s * rand(12, 42) * u, -rand(0, 5) * u, rand(2.5, 4), rand(1.5, 3) * u, 2.5 * u, 0.5, 0));
          }
        }
      }
    }

    _updateAscent(dt) {
      const g = this._ascGeom(), p = this.progress, u = this.H / 100, sc = g.h / (this.H * 0.36);

      for (const m of MILESTONES) {
        const has = this.passed.has(m.id);
        if (p >= m.at && !has) {
          this.passed.add(m.id);
          this._hit(m, g);
        } else if (p < m.at && has) {
          this.passed.delete(m.id);
          if (m.id === 'sep') this.debris = this.debris.filter((d) => d.kind !== 'booster');
          if (m.id === 'fairing') this.debris = this.debris.filter((d) => d.kind !== 'fairing');
        }
      }

      if (p < MILESTONES[1].at) {
        this._flame(g.sbx, g.sby, -g.dx, -g.dy, 1, sc, dt, false);
      } else if (p >= MILESTONES[2].at && p < MILESTONES[4].at) {
        this._flame(g.ubx, g.uby, -g.dx, -g.dy, 0.7, sc * 0.8, dt, true);
      }

      for (const d of this.debris) {
        d.age += dt; d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.vr * dt;
      }
      this.debris = this.debris.filter((d) => d.age < 8);
      for (const q of this.pops) q.age += dt;
      this.pops = this.pops.filter((q) => q.age < 3.4);
    }

    _hit(m, g) {
      const u = this.H / 100;
      const q = this._path(this._pathT(m.at));
      this.pops.push({ text: m.label, x: q.x, y: q.y, age: 0 });
      this._emit('milestone', m.id);

      if (m.id === 'sep') {
        this.debris.push({ kind: 'booster', h: g.h, x: g.sbx, y: g.sby, rot: g.rot, vx: g.dx * 4 * u, vy: g.dy * 4 * u, vr: 0.5, age: 0 });
        for (let i = 0; i < 18; i++) {
          const a = rand(0, 6.283), s = rand(10, 25) * u;
          this._spawn(P('spark', g.ubx, g.uby, Math.cos(a) * s, Math.sin(a) * s, rand(0.5, 0.9), 0.9 * u, 0, 1.5, 0));
        }
      }
      if (m.id === 'fairing') {
        const tx = g.ubx + g.dx * g.h * 0.25, ty = g.uby + g.dy * g.h * 0.25;
        const nx = -g.dy, ny = g.dx;
        for (const s of [-1, 1]) {
          this.debris.push({
            kind: 'fairing', side: s, h: g.h, x: tx, y: ty, rot: g.rot,
            vx: g.dx * 6 * u + nx * s * 9 * u, vy: g.dy * 6 * u + ny * s * 9 * u, vr: s * 0.9, age: 0,
          });
        }
      }
    }

    _updateLanding(dt) {
      const L = this._landGeom(), p = this.progress, u = L.u, fail = this.result === 'fail';

      if (L.thrust > 0 && !L.hidden) {
        this._flame(L.x, L.y, -Math.sin(L.rot), Math.cos(L.rot), L.thrust, L.h / (this.H * 0.36), dt, false);
      }
      // cold-gas puffs while flipping
      if (p < 0.3 && Math.random() < dt * 14) {
        const nx = L.x + Math.sin(L.rot) * L.h * 0.68, ny = L.y - Math.cos(L.rot) * L.h * 0.68;
        this._spawn(P('vapor', nx, ny, rand(-6, 6) * u, rand(-6, 6) * u, rand(0.6, 1.2), rand(1, 2) * u, 3 * u, 1, 0));
      }

      if (p < 0.88) this.passed.delete('boom');
      if (p < 0.9) this.passed.delete('td');
      if (fail && p >= 0.88 && !this.passed.has('boom')) {
        this.passed.add('boom');
        this._explode(L.x, L.y, u);
        this._emit('touchdown', 'fail');
      }
      if (!fail && p >= 0.9 && !this.passed.has('td')) {
        this.passed.add('td');
        this._emit('touchdown', 'success');
      }
      if (!fail && p >= 0.9 && p < 0.98) {
        for (let i = this._n(1.6, dt); i > 0; i--) {
          const s = Math.random() < 0.5 ? -1 : 1;
          this._spawn(P('vapor', L.shipX + s * rand(0, 4) * u, L.deckY - 1 * u, s * rand(8, 26) * u, -rand(2, 8) * u,
            rand(2, 3), rand(1.5, 3) * u, 2.5 * u, 0.6, 0));
        }
      }
    }

    _explode(x, y, u) {
      for (let i = 0; i < 110; i++) {
        const a = rand(0, 6.283), s = rand(4, 40) * u;
        this._spawn(P('fire', x, y, Math.cos(a) * s, Math.sin(a) * s * 0.8 - 8 * u, rand(0.4, 1.2), rand(2, 5) * u, 2 * u, 1.2, 10 * u));
      }
      for (let i = 0; i < 50; i++) {
        const a = rand(0, 6.283), s = rand(2, 18) * u;
        this._spawn(P('smoke', x, y, Math.cos(a) * s, Math.sin(a) * s - 4 * u, rand(2, 4), rand(2, 4) * u, 3 * u, 0.7, 0));
      }
      for (let i = 0; i < 30; i++) {
        const a = rand(-3.4, -0.2), s = rand(15, 45) * u;
        this._spawn(P('spark', x, y, Math.cos(a) * s, Math.sin(a) * s, rand(0.8, 1.6), 0.9 * u, 0, 0.3, 40 * u));
      }
    }

    _updateRecap() {
      if (this.progress >= 0.05 && !this.passed.has('deploy')) {
        this.passed.add('deploy');
        this._emit('deploy');
      } else if (this.progress < 0.05) {
        this.passed.delete('deploy');
      }
    }

    /* ---------------- drawing ---------------- */

    _draw() {
      const ctx = this.ctx, W = this.W, H = this.H;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      switch (this.phase) {
        case 'ascent': this._drawAscent(ctx); break;
        case 'landing': this._drawLanding(ctx); break;
        case 'recap': this._drawRecap(ctx); break;
        default: this._drawPad(ctx);
      }
      if (this.flash > 0) {
        ctx.fillStyle = `rgba(3,5,12,${clamp(this.flash)})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    _text(ctx, s, x, y, size, alpha, align, color, weight) {
      ctx.save();
      ctx.globalAlpha = clamp(alpha);
      ctx.font = `${weight || 500} ${size}px ${FONT}`;
      ctx.textAlign = align || 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = color || '#eaf0fa';
      ctx.fillText(s, x, y);
      ctx.restore();
    }

    _sky(ctx, spaceMix, horizonY) {
      const d = this.daylight;
      let top = mix(NIGHT_TOP, DAY_TOP, d), bot = mix(NIGHT_BOT, DAY_BOT, d);
      top = mix(top, SPACE, spaceMix);
      bot = mix(bot, SPACE, spaceMix);
      const g = ctx.createLinearGradient(0, 0, 0, horizonY || this.H);
      g.addColorStop(0, rgb(top));
      g.addColorStop(1, rgb(bot));
      ctx.fillStyle = g;
      ctx.fillRect(-12, -12, this.W + 24, this.H + 24);
    }

    _stars(ctx, alpha, maxY) {
      if (alpha < 0.02) return;
      // Quickshell perf: batch by alpha bucket — one fillStyle parse + one
      // batched fill per bucket instead of a string parse + fillRect per
      // star (150+ of each per frame). Twinkle is quantized to 4 steps,
      // invisible at 1-2px star sizes.
      const buckets = [[], [], [], []];
      for (const s of this.stars) {
        const tw = this.reducedMotion ? 1 : 0.6 + 0.4 * Math.sin(this.t * 1.3 + s.tw);
        let b = ((alpha * tw * 0.9) * 4) | 0;
        if (b > 3) b = 3;
        if (b < 0) b = 0;
        buckets[b].push(s);
      }
      const W = this.W;
      for (let b = 0; b < 4; b++) {
        const list = buckets[b];
        if (!list.length) continue;
        ctx.fillStyle = `rgba(255,255,255,${(b + 0.5) / 4})`;
        ctx.beginPath();
        for (const s of list) ctx.rect(s.x * W, s.y * maxY, s.r, s.r);
        ctx.fill();
      }
    }

    _clouds(ctx, camY, vis) {
      if (vis < 0.02) return;
      const col = mix([170, 190, 225], [255, 255, 255], this.daylight);
      for (const c of this.clouds) {
        const x = ((c.x + this.t * c.v) % 1.3 - 0.15) * this.W;
        const y = c.y * this.H * 0.55 + camY * 0.5;
        const w = c.s * this.W * 0.13;
        ctx.fillStyle = rgb(col, 0.11 * vis);
        for (const k of [-0.5, 0, 0.45]) {
          ctx.beginPath();
          ctx.ellipse(x + k * w, y - (k === 0 ? 0.1 : 0) * w * 0.2, w * 0.5, w * 0.14, 0, 0, 6.283);
          ctx.fill();
        }
      }
    }

    _earth(ctx) {
      const W = this.W, H = this.H, u = H / 100;
      const R = Math.max(W, H) * 0.95, cx = W / 2, cy = H * 0.86 + R;
      const g = ctx.createLinearGradient(0, cy - R, 0, cy - R + H * 0.4);
      g.addColorStop(0, rgb(mix([10, 29, 68], [31, 95, 168], this.daylight)));
      g.addColorStop(1, '#030814');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, 6.283);
      ctx.fill();
      // Atmosphere glow. The browser version used ctx.shadowBlur, but
      // Qt's software canvas re-rasterizes the blur on every single frame,
      // which pegs a core. Two strokes — a wide faint one under a thin
      // bright one — read the same at this size for ~no cost.
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(120,180,255,0.16)';
      ctx.lineWidth = Math.max(2, 1.1 * u);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(140,200,255,0.55)';
      ctx.lineWidth = Math.max(1, 0.25 * u);
      ctx.stroke();
      ctx.restore();
    }

    // Plume colour for one particle kind at life fraction k (0 fresh .. 1
    // spent). Factored out so _drawParticles can batch arcs by colour
    // instead of parsing a string per particle.
    _particleColor(kind, k) {
      switch (kind) {
        case 'fire': return `rgba(255,${(110 + 140 * k * k) | 0},${(30 + 170 * k * k * k) | 0},${0.5 * k})`;
        case 'fireblue': return `rgba(${(140 + 80 * k) | 0},${(180 + 60 * k) | 0},255,${0.8 * k})`;
        case 'spark': return `rgba(255,${(180 + 60 * k) | 0},90,${k})`;
        case 'smoke': { const v = (90 + 80 * k) | 0; return `rgba(${v},${v},${v + 6},${0.16 * k})`; }
        case 'dust': return `rgba(${(150 + 60 * k) | 0},${(130 + 40 * k) | 0},${(110 + 20 * k) | 0},${0.2 * k})`;
        default: return `rgba(235,244,255,${0.2 * Math.sin(Math.PI * (1 - k))})`; // vapor
      }
    }

    _drawParticles(ctx) {
      // Quickshell perf: batch arcs by (blend, kind, life-bucket) — one
      // fillStyle parse + one fill per bucket instead of per particle.
      // Life is quantized to 4 steps; invisible at few-pixel sizes.
      for (const additive of [false, true]) {
        ctx.save();
        ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
        const batches = new Map();
        for (const q of this.particles) {
          const k = q.life / q.max;
          const isAdd = q.kind === 'fire' || q.kind === 'fireblue' || q.kind === 'spark';
          if (isAdd !== additive) continue;
          const b = Math.max(0, Math.min(3, (k * 4) | 0));
          const key = q.kind + b;
          let arr = batches.get(key);
          if (!arr) { arr = []; batches.set(key, arr); }
          arr.push(q);
        }
        for (const [key, arr] of batches) {
          const b = key.charCodeAt(key.length - 1) - 48;
          const kind = key.slice(0, -1);
          ctx.fillStyle = this._particleColor(kind, (b + 0.5) / 4);
          ctx.beginPath();
          for (const q of arr) {
            const r = Math.max(0.3, q.size);
            ctx.moveTo(q.x + r, q.y);
            ctx.arc(q.x, q.y, r, 0, 6.283);
          }
          ctx.fill();
        }
        ctx.restore();
      }
    }

    _drawPad(ctx) {
      const g = this._padGeom();
      const { W, H, u, groundY, RH, rx, lift, camY, alt, baseY } = g;
      const p = this.progress, ph = this.phase, day = this.daylight;
      const spaceMix = clamp((alt - 0.12) / 0.65);
      const gy = groundY + camY;
      const th = this._thrust();

      ctx.save();
      let amp = 0;
      if (!this.reducedMotion) {
        if (ph === 'countdown') amp = Math.max(0, p - 0.8) * 5;
        else if (ph === 'liftoff') amp = Math.max(0, 1 - p / 0.75) * 3.2;
      }
      if (amp > 0) ctx.translate((Math.random() - 0.5) * amp * 2, (Math.random() - 0.5) * amp * 2);

      this._sky(ctx, spaceMix, gy);
      this._stars(ctx, clamp((1 - day) * 0.85 + spaceMix), gy);
      this._clouds(ctx, camY, 1 - spaceMix);

      // floodlights
      const fa = 0.22 * (1 - day) * (1 - spaceMix);
      if (fa > 0.01 && gy < H + RH) {
        const fg = ctx.createRadialGradient(rx, gy - 0.3 * RH, 0, rx, gy - 0.3 * RH, RH * 0.9);
        fg.addColorStop(0, `rgba(255,196,120,${fa})`);
        fg.addColorStop(1, 'rgba(255,196,120,0)');
        ctx.fillStyle = fg;
        ctx.fillRect(0, 0, W, H);
      }

      // ground, pad slab, tower
      if (gy < H + 12) {
        ctx.fillStyle = rgb(mix([13, 17, 25], [72, 88, 70], day));
        ctx.fillRect(-12, gy, W + 24, H - gy + 12 + RH);
        ctx.fillStyle = rgb(mix([40, 46, 58], [110, 116, 120], day));
        ctx.fillRect(rx - 0.32 * RH, gy, 0.64 * RH, 0.03 * RH);

        const tx = rx - 0.17 * RH, tw = 0.045 * RH, tH = 0.84 * RH;
        ctx.strokeStyle = rgb(mix([74, 84, 104], [90, 96, 108], day));
        ctx.lineWidth = Math.max(1, 0.006 * RH);
        ctx.beginPath();
        ctx.moveTo(tx, gy); ctx.lineTo(tx, gy - tH);
        ctx.moveTo(tx + tw, gy); ctx.lineTo(tx + tw, gy - tH);
        const step = 0.05 * RH;
        for (let yy = 0; yy < tH; yy += step) {
          const y2 = Math.min(yy + step, tH);
          ctx.moveTo(tx, gy - yy); ctx.lineTo(tx + tw, gy - y2);
          ctx.moveTo(tx + tw, gy - yy); ctx.lineTo(tx, gy - y2);
        }
        ctx.stroke();

        let arm = 1;
        if (ph === 'countdown') arm = clamp(1 - (p - 0.45) * 6);
        else if (ph === 'liftoff') arm = 0;
        if (arm > 0) {
          const ay = gy - 0.6 * RH, ax = tx + tw;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax + (rx - 0.0425 * RH - ax) * arm, ay);
          ctx.stroke();
        }
        if (Math.sin(this.t * 2.4) > 0.5) {
          ctx.fillStyle = '#ff4d3d';
          ctx.beginPath();
          ctx.arc(tx + tw / 2, gy - tH - 0.012 * RH, Math.max(1.5, 0.01 * RH), 0, 6.283);
          ctx.fill();
        }
      }

      // exhaust glow on the pad
      if (th > 0 && lift < H * 0.4) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const r = RH * 0.6 * th;
        const eg = ctx.createRadialGradient(rx, gy, 0, rx, gy, r);
        eg.addColorStop(0, `rgba(255,170,90,${0.5 * th})`);
        eg.addColorStop(1, 'rgba(255,170,90,0)');
        ctx.fillStyle = eg;
        ctx.fillRect(rx - r, gy - r, r * 2, r * 2);
        ctx.restore();
      }

      // rocket
      let frost = 0;
      if (ph === 'fueling') frost = p;
      else if (ph === 'countdown') frost = 1;
      else if (ph === 'liftoff') frost = 1 - clamp(p * 3);
      ctx.save();
      ctx.translate(rx, baseY);
      drawStack(ctx, RH, { frost, glow: th });
      ctx.restore();

      this._drawParticles(ctx);

      // HUD
      if (ph === 'fueling') {
        const gx = rx + RH * 0.22, gw = Math.max(4, 1.6 * u), gh = RH * 0.5, gb = groundY - 0.1 * RH;
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fillRect(gx, gb - gh, gw, gh);
        ctx.fillStyle = '#9fd8ff';
        ctx.fillRect(gx, gb - gh * p, gw, gh * p);
        this._text(ctx, `${Math.round(p * 100)}%`, gx + gw / 2, gb - gh - 2.2 * u, 3.2 * u, 0.9);
        this._text(ctx, 'Fueling', gx + gw / 2, gb + 4.2 * u, 2.6 * u, 0.6);
      }
      if (ph === 'countdown') {
        const cx = rx, cy = baseY - RH * 0.5, r = RH * 0.66 * (1 + 0.05 * this.ring);
        ctx.save();
        ctx.lineWidth = Math.max(1.5, 0.5 * u);
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.283); ctx.stroke();
        ctx.strokeStyle = `rgba(255,184,77,${0.55 + 0.45 * this.ring})`;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p); ctx.stroke();
        ctx.restore();
        const n = Math.max(1, Math.ceil((1 - p) * 10));
        this._text(ctx, `T\u2212${n}`, cx, cy - r - 3 * u, 8 * u * (1 + 0.12 * this.ring), 1, 'center', '#ffe2b0', 600);
      }
      if (ph === 'liftoff' && p > 0.04) {
        this._text(ctx, 'Liftoff', W / 2, H * 0.16, 7 * u, clamp(p / 0.05) * clamp(1 - (p - 0.25) / 0.3), 'center', '#ffe2b0', 600);
      }
      ctx.restore();
    }

    _drawAscent(ctx) {
      const W = this.W, H = this.H, u = H / 100, p = this.progress;
      // Sky and stars are effectively at infinity: the translating camera
      // leaves them fixed, which is physically correct and needs no extra
      // starfield coverage.
      this._sky(ctx, 1, H);
      this._stars(ctx, 1, H);
      const g = this._ascGeom();
      const pt = this._pathT(p);

      // Follow-cam. Exact lock on the rocket through a ramp shared by centre
      // and zoom: at p=0 both are identity (seamless handoff from liftoff),
      // then the view glides onto the rocket and holds. Pure function of
      // progress — smooth playback glides, scrubbing snaps. No easing state.
      const e = smooth(clamp(p / 0.15));
      const cam = { x: lerp(W / 2, g.x, e), y: lerp(H / 2, g.y, e), z: 1 + 0.7 * e };
      const w2sX = (wx) => (wx - cam.x) * cam.z + W / 2;
      const w2sY = (wy) => (wy - cam.y) * cam.z + H / 2;

      const strokePath = (t0, t1, segs) => {
        const N = segs === undefined ? 36 : segs;
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
          const q = this._path(lerp(t0, t1, i / N));
          if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
      };

      // World under the camera: earth slides past, trail/rocket/debris ride
      // along. Line widths and radii scale with the zoom — uniformly richer.
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.z, cam.z);
      ctx.translate(-cam.x, -cam.y);
      this._earth(ctx);

      // path ahead, dashed
      ctx.save();
      ctx.setLineDash([0.6 * u, 1.2 * u]);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = Math.max(1, 0.25 * u);
      strokePath(pt, 1, 36);
      ctx.restore();

      // trail behind the rocket. Quickshell perf: 16 strokes x 18 segments
      // instead of 40 x 36 — the gradient still reads smooth at this size,
      // at ~1/5th the path ops.
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.5, 0.45 * u);
      const N = 16;
      for (let i = 0; i < N; i++) {
        ctx.strokeStyle = `rgba(255,214,160,${0.08 + 0.7 * (i / N)})`;
        strokePath(pt * i / N, pt * (i + 1) / N, 18);
      }
      ctx.restore();

      // milestone markers
      for (const m of MILESTONES) {
        const q = this._path(this._pathT(m.at));
        ctx.beginPath();
        ctx.arc(q.x, q.y, Math.max(2, 0.7 * u), 0, 6.283);
        if (this.passed.has(m.id)) {
          ctx.fillStyle = '#ffd9a0'; ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1; ctx.stroke();
        }
      }

      this._drawParticles(ctx);

      for (const d of this.debris) {
        ctx.save();
        ctx.globalAlpha = 1 - clamp((d.age - 5) / 3);
        ctx.translate(d.x, d.y);
        ctx.rotate(d.rot);
        if (d.kind === 'booster') drawBooster(ctx, d.h, { fins: 1 });
        else drawFairingHalf(ctx, d.h, d.side);
        ctx.restore();
      }

      const sep = this.passed.has('sep'), fairingGone = this.passed.has('fairing');
      ctx.save();
      if (!sep) {
        ctx.translate(g.sbx, g.sby);
        ctx.rotate(g.rot);
        drawStack(ctx, g.h, { fairing: !fairingGone, glow: p < MILESTONES[1].at ? 0.8 : 0 });
      } else {
        ctx.translate(g.ubx, g.uby);
        ctx.rotate(g.rot);
        drawUpper(ctx, g.h, { fairing: !fairingGone, glow: p < MILESTONES[4].at ? 0.8 : 0 });
      }
      ctx.restore();
      ctx.restore(); // follow-cam

      // milestone pops in screen space: the rings ride the zoom, the labels
      // must not scale, so both are projected manually after the restore.
      for (const q of this.pops) {
        const a = 1 - clamp((q.age - 2) / 1.2);
        const sx = w2sX(q.x), sy = w2sY(q.y);
        ctx.strokeStyle = `rgba(255,217,160,${clamp(1 - q.age) * 0.8})`;
        ctx.lineWidth = Math.max(1, 0.2 * u * cam.z);
        ctx.beginPath();
        ctx.arc(sx, sy, (1.5 * u + q.age * 14 * u) * cam.z, 0, 6.283);
        ctx.stroke();
        this._text(ctx, q.text, sx + 2.5 * u, sy - 3 * u, 3.1 * u, a, 'left', '#ffe2b0', 600);
      }

      if (this.telemetry) {
        const t = this.telemetry;
        if (t.altitudeKm !== undefined) this._text(ctx, `Altitude ${Math.round(t.altitudeKm).toLocaleString()} km`, 3 * u, 6 * u, 3 * u, 0.85, 'left');
        if (t.speedKmh !== undefined) this._text(ctx, `Speed ${Math.round(t.speedKmh).toLocaleString()} km/h`, 3 * u, 10 * u, 3 * u, 0.85, 'left');
      }
    }

    _drawLanding(ctx) {
      const W = this.W, H = this.H, p = this.progress, day = this.daylight;
      const L = this._landGeom(), u = L.u, horizon = H * 0.78;

      this._sky(ctx, 0, horizon);
      this._stars(ctx, (1 - day) * 0.8, horizon);
      this._clouds(ctx, 0, 1);

      // Slow push-in on a fixed region: deterministic in progress (scrubs
      // snap, playback glides), identity at p=0 for a seamless handoff from
      // ascent. Sky/stars/clouds stay infinite and fixed; ocean, ship and
      // booster ride the zoom.
      const e = smooth(clamp(p / 0.2));
      const cam = { x: W * 0.5, y: lerp(H / 2, lerp(H * 0.30, H * 0.55, smooth(clamp(p))), e), z: 1 + 0.5 * e };
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.z, cam.z);
      ctx.translate(-cam.x, -cam.y);

      const og = ctx.createLinearGradient(0, horizon, 0, H);
      og.addColorStop(0, rgb(mix([14, 28, 48], [40, 96, 130], day)));
      og.addColorStop(1, rgb(mix([4, 9, 18], [16, 48, 76], day)));
      ctx.fillStyle = og;
      ctx.fillRect(-12, horizon, W + 24, H - horizon + 12);
      for (let i = 0; i < 7; i++) {
        const y = horizon + (i + 1) * (H - horizon) / 8;
        ctx.beginPath();
        for (let x = -10; x <= W + 10; x += 16) {
          const yy = y + Math.sin(x * 0.02 + this.t * (0.8 + i * 0.1) + i) * (0.3 + i * 0.12) * u;
          if (x === -10) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
        }
        ctx.strokeStyle = `rgba(255,255,255,${0.03 + i * 0.012})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // drone ship
      const sw = Math.min(W * 0.34, H * 0.8), sx = L.shipX, dy = L.deckY;
      ctx.fillStyle = '#151a22';
      ctx.beginPath();
      ctx.moveTo(sx - sw / 2, dy);
      ctx.lineTo(sx + sw / 2, dy);
      ctx.lineTo(sx + sw / 2 - 1.5 * u, dy + 3.2 * u);
      ctx.lineTo(sx - sw / 2 + 1.5 * u, dy + 3.2 * u);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#2a313d';
      ctx.fillRect(sx - sw / 2, dy - 0.8 * u, sw, 0.8 * u);
      ctx.fillStyle = '#1b2029';
      ctx.fillRect(sx + sw / 2 - 3.5 * u, dy - 3.2 * u, 3.5 * u, 2.4 * u);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = Math.max(1, 0.2 * u);
      ctx.beginPath();
      ctx.ellipse(sx, dy - 0.4 * u, sw * 0.14, 0.28 * u, 0, 0, 6.283);
      ctx.moveTo(sx - sw * 0.05, dy - 0.65 * u); ctx.lineTo(sx + sw * 0.05, dy - 0.15 * u);
      ctx.moveTo(sx + sw * 0.05, dy - 0.65 * u); ctx.lineTo(sx - sw * 0.05, dy - 0.15 * u);
      ctx.stroke();

      if (!L.hidden) {
        ctx.save();
        ctx.translate(L.x, L.y);
        ctx.rotate(L.rot);
        drawBooster(ctx, L.h, { fins: L.fins, legs: L.legs, glow: L.thrust });
        ctx.restore();
      }

      this._drawParticles(ctx);

      ctx.restore(); // landing push-in (titles below stay screen-fixed)

      if (this.result === 'fail') {
        this._text(ctx, 'Landing failed', W / 2, H * 0.16, 7 * u, smooth(clamp((p - 0.9) / 0.06)), 'center', '#c9d3e6', 600);
      } else {
        this._text(ctx, 'Landing confirmed', W / 2, H * 0.16, 7 * u, smooth(clamp((p - 0.93) / 0.06)), 'center', '#ffe2b0', 600);
      }
    }

    _drawRecap(ctx) {
      const W = this.W, H = this.H, u = H / 100, p = this.progress;
      this._sky(ctx, 1, H);
      this._stars(ctx, 1, H);
      this._earth(ctx);

      const h = H * 0.85, bx = W * 0.2 - p * W * 0.02, by = H * 0.44;
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(Math.PI / 2);
      drawUpper(ctx, h, { fairing: false, nub: false });
      ctx.restore();

      const su = H * 0.03;
      const sx0 = bx + 0.18 * h + su * 1.4;
      const sx = lerp(sx0, sx0 + W * 0.3, smooth(clamp(p / 0.7)));
      const sy = by + Math.sin(this.t * 0.8) * 0.4 * u;
      const unfold = smooth(clamp((p - 0.3) / 0.4)), pl = unfold * 3.2 * su;

      ctx.fillStyle = '#1f3f7a';
      ctx.strokeStyle = 'rgba(140,180,255,0.5)';
      ctx.lineWidth = 1;
      if (pl > 1) {
        for (const s of [-1, 1]) {
          const y0 = s < 0 ? sy - 0.7 * su - pl : sy + 0.7 * su;
          ctx.fillRect(sx - 0.35 * su, y0, 0.7 * su, pl);
          ctx.strokeRect(sx - 0.35 * su, y0, 0.7 * su, pl);
        }
      }
      ctx.fillStyle = '#c9ced8';
      ctx.fillRect(sx - su, sy - 0.7 * su, 2 * su, 1.4 * su);
      ctx.fillStyle = '#7d8696';
      ctx.fillRect(sx - su, sy - 0.15 * su, 2 * su, 0.3 * su);

      if (p > 0.75) {
        const a = Math.max(0, Math.sin(this.t * 3)) * 0.9;
        ctx.strokeStyle = `rgba(255,255,255,${a})`;
        ctx.lineWidth = Math.max(1, 0.2 * u);
        const cx = sx + 0.5 * su, cy = sy - 0.4 * su, r = 1.6 * u;
        ctx.beginPath();
        ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
        ctx.stroke();
      }

      this._text(ctx, 'Payload deployed', W / 2, H * 0.16, 7 * u, smooth(clamp((p - 0.4) / 0.2)), 'center', '#ffe2b0', 600);
    }
  }

  LaunchScene.PHASES = PHASES;
  LaunchScene.SCHEDULE = SCHEDULE;
  LaunchScene.MILESTONES = MILESTONES;

  global.LaunchScene = LaunchScene;
  if (typeof module !== 'undefined' && module.exports) module.exports = LaunchScene;
})(LAUNCH_SCENE_ENV);

/* --- Quickshell/QML integration ----------------------------------------- */

// The class's first argument is the DOM container; the second is the options.
// Quickshell has no DOM container, so that argument is deliberately null and
// the context is handed in through opts instead.
function createScene(opts) {
  return new LAUNCH_SCENE_ENV.LaunchScene(null, opts || {});
}

function setEnv(key, value) {
  LAUNCH_SCENE_ENV[key] = value;
}

function frameSink() {
  return LAUNCH_SCENE_ENV.frameSink;
}
