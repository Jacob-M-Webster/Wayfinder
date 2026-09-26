/*
  SignalOverlay: floating signal heads for a three.js scene player.

  Each signal head shows what the CAR BELIEVES the light is (not just the truth):
    - lamps light up with the decided phase (red lamp blinks for an all-way stop)
    - a badge above it shows a confidence ring (with a tick at the commit threshold),
      the phase, where the decision came from (Beacon / Model / Fallback), and the actual light

  One head per direction, plus a bigger "Your light" head on the Waymo car's own lane
  (that lane's direction is replaced by it, so nothing is shown twice).

  Decision logic (this is the arbiter, in the same order as the planning doc):
    1. beacon alive and it knows the light  -> Beacon
    2. model committed (confidence >= threshold) -> Model
    3. otherwise -> all-way stop (Fallback)

  Usage:
    <script src="three.min.js"></script>
    <script src="signal_overlay.js"></script>
    const overlay = new SignalOverlay(THREE, threeScene, sceneJson, { toWorld, showTruth: true });
    overlay.update(step, beaconAlive);   // whenever the step or beacon state changes
    overlay.animate(performance.now());  // every frame (drives the blink)
    overlay.decisions                    // { ego: {...}, N: {...}, ... } for your own HUD

  Options: showTruth (true), fixedSize (true: badges stay the same size on screen),
  badgeSize (0.13 = fraction of screen height), poleHeight (5.5 m), font.

  toWorld(x, y, height) maps scene.json meters (+x east, +y north) to your three.js space.
  Default: new THREE.Vector3(x, height, -y)  (y-up, north = -z). Pass your own if your
  player maps coordinates differently. Headings use rotation.y = heading, which matches
  that default; if you flip axes, flip the heading sign too (opts.headingSign = -1).

  ES-module projects: add `export` in front of `class SignalOverlay` or import window.SignalOverlay.
*/
(function () {
  const KNOWN = new Set(["STOP", "GO", "CAUTION"]);
  const COLOR = {
    STOP: "#ff4438", CAUTION: "#ffb000", GO: "#19d3a2",   // LED-style signal colors
    UNKNOWN: "#7d858c", BEACON: "#4aa8ff", TEXT: "#e8ebe6",
  };
  const DIM = { STOP: "#3a1512", CAUTION: "#3a2a0a", GO: "#0c3027" };
  const WORD = { STOP: "Stop", GO: "Go", CAUTION: "Caution", UNKNOWN: "No read", ALL_WAY_STOP: "All-way stop" };
  const DIR_NAME = { N: "Northbound", E: "Eastbound", S: "Southbound", W: "Westbound" };

  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  const circMean = a => Math.atan2(avg(a.map(Math.sin)), avg(a.map(Math.cos)));

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Shrink the font until the text fits the badge's text column.
  function fitText(ctx, text, x, y, maxW, size, weight, family) {
    let s = size;
    ctx.font = `${weight} ${s}px ${family}`;
    while (s > 16 && ctx.measureText(text).width > maxW) { s -= 2; ctx.font = `${weight} ${s}px ${family}`; }
    ctx.fillText(text, x, y);
    return ctx.measureText(text).width;
  }

  class SignalOverlay {
    constructor(THREE, scene, data, opts = {}) {
      this.T = THREE;
      this.scene = scene;
      this.data = data;
      this.toWorld = opts.toWorld || ((x, y, h = 0) => new THREE.Vector3(x, h, -y));
      this.headingSign = opts.headingSign ?? 1;
      this.showTruth = opts.showTruth ?? true;
      this.font = opts.font || "'Barlow Condensed', 'Arial Narrow', sans-serif";
      this.poleHeight = opts.poleHeight ?? 5.5;
      // Badges keep a constant on-screen size (readable from any zoom) unless you turn this off.
      this.fixedSize = opts.fixedSize ?? true;
      this.badgeSize = opts.badgeSize ?? 0.13;  // fraction of screen height when fixedSize
      this.threshold = data.model?.threshold ?? 0.8;
      this.group = new THREE.Group();
      scene.add(this.group);
      this.decisions = {};
      this._blinkOn = true;
      this.lights = this._buildLights();
      if (typeof document !== "undefined" && document.fonts?.ready) {
        document.fonts.ready.then(() => this._redrawAll());
      }
    }

    // ---------- public ----------
    update(step, beaconAlive) {
      this._step = step;
      this._beacon = beaconAlive;
      for (const L of this.lights) {
        const st = this._decide(L.spec, step, beaconAlive);
        L.state = st;
        this.decisions[L.spec.kind === "ego" ? "ego" : L.spec.dir] = st;
        this._setLamps(L);
        const key = [st.phase, Math.round(st.conf * 100), st.source, st.truth, st.guess, this.showTruth].join("|");
        if (key !== L.key) { L.key = key; this._drawBadge(L); }
      }
    }

    animate(now) {
      const on = Math.floor(now / 500) % 2 === 0;
      if (on === this._blinkOn) return;
      this._blinkOn = on;
      for (const L of this.lights) if (L.state?.phase === "ALL_WAY_STOP") this._setLamps(L);
    }

    setShowTruth(v) { this.showTruth = v; this._redrawAll(); }

    dispose() {
      this.scene.remove(this.group);
      this.group.traverse(o => {
        o.geometry?.dispose?.();
        if (o.material) { o.material.map?.dispose?.(); o.material.dispose?.(); }
      });
    }

    // ---------- decision (arbiter) ----------
    _decide(spec, step, beaconAlive) {
      const d = this.data, m = d.model;
      const truth = spec.kind === "ego"
        ? ((d.truth.lane[step] || {})[String(spec.lane)] || "UNKNOWN")
        : ((d.truth.approach[step] || {})[spec.dir] || "UNKNOWN");

      // The beacon replays the real signal timeline, so while it's alive it reports the truth.
      if (beaconAlive && KNOWN.has(truth)) return { phase: truth, conf: 1, source: "BEACON", truth };

      let pred = null;
      if (m) pred = spec.kind === "ego" ? (m.ego ? m.ego[step] : null) : (m.approach[step] || {})[spec.dir];
      const [phase, conf, committed] = pred || ["UNKNOWN", 0, false];
      if (committed) return { phase, conf, source: "MODEL", truth };
      return { phase: "ALL_WAY_STOP", conf, guess: phase, source: "FALLBACK", truth };
    }

    // ---------- building ----------
    _buildLights() {
      const d = this.data, byDir = {};
      for (const s of d.signals) (byDir[s.approach] = byDir[s.approach] || []).push(s);
      const egoLane = d.ego_lane ?? d.model?.ego_lane ?? null;
      const egoSig = egoLane != null ? d.signals.find(s => s.lane_id === egoLane) : null;
      const lights = [];
      for (const [dir, sigs] of Object.entries(byDir)) {
        if (egoSig && dir === egoSig.approach) continue;
        lights.push(this._makeLight({
          kind: "approach", dir,
          x: avg(sigs.map(s => s.stop[0])), y: avg(sigs.map(s => s.stop[1])),
          heading: circMean(sigs.map(s => s.heading)), scale: 1,
        }));
      }
      if (egoSig) {
        lights.push(this._makeLight({
          kind: "ego", dir: egoSig.approach, lane: egoLane,
          x: egoSig.stop[0], y: egoSig.stop[1], heading: egoSig.heading, scale: 1.45,
        }));
      }
      return lights;
    }

    _makeLight(spec) {
      const T = this.T, s = spec.scale;
      const root = new T.Group();
      root.position.copy(this.toWorld(spec.x, spec.y, 0));
      root.rotation.y = this.headingSign * spec.heading;

      const pole = new T.Mesh(
        new T.CylinderGeometry(0.06 * s, 0.06 * s, this.poleHeight * s, 8),
        new T.MeshBasicMaterial({ color: "#4a5058" }));
      pole.position.y = (this.poleHeight * s) / 2;
      root.add(pole);

      // Housing: local +x is the direction of travel, so lamps sit on the -x face,
      // facing the cars that are approaching this stop line.
      const head = new T.Group();
      head.position.y = this.poleHeight * s + 0.8 * s;
      head.add(new T.Mesh(new T.BoxGeometry(0.5 * s, 1.55 * s, 0.55 * s),
                          new T.MeshBasicMaterial({ color: "#1f2327" })));
      const lamps = {};
      [["STOP", 0.47], ["CAUTION", 0], ["GO", -0.47]].forEach(([k, yy]) => {
        const lamp = new T.Mesh(new T.SphereGeometry(0.19 * s, 16, 12),
                                new T.MeshBasicMaterial({ color: DIM[k] }));
        lamp.position.set(-0.26 * s, yy * s, 0);
        head.add(lamp);
        lamps[k] = lamp;
      });
      root.add(head);

      const canvas = document.createElement("canvas");
      canvas.width = 512; canvas.height = 256;
      const tex = new T.CanvasTexture(canvas);
      if ("colorSpace" in tex) tex.colorSpace = T.SRGBColorSpace;
      const sprite = new T.Sprite(new T.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, sizeAttenuation: !this.fixedSize }));
      sprite.renderOrder = 10;
      if (this.fixedSize) {
        const h = this.badgeSize * (spec.kind === "ego" ? 1.3 : 1);
        sprite.scale.set(h * 2, h, 1);
        sprite.center.set(0.5, 0);           // sit on top of the signal head, not over it
      } else {
        sprite.scale.set(4.2 * s, 2.1 * s, 1);
      }
      sprite.position.y = head.position.y + (this.fixedSize ? 1.0 * s : 2.0 * s);
      root.add(sprite);

      this.group.add(root);
      return { spec, root, lamps, canvas, ctx: canvas.getContext("2d"), tex, key: null, state: null };
    }

    // ---------- drawing ----------
    _setLamps(L) {
      const p = L.state.phase;
      const on = {
        STOP: p === "STOP" || (p === "ALL_WAY_STOP" && this._blinkOn),
        CAUTION: p === "CAUTION",
        GO: p === "GO",
      };
      for (const k of ["STOP", "CAUTION", "GO"]) L.lamps[k].material.color.set(on[k] ? COLOR[k] : DIM[k]);
    }

    _redrawAll() {
      for (const L of this.lights) if (L.state) { L.key = null; this._drawBadge(L); }
    }

    _drawBadge(L) {
      const { ctx, canvas } = L, st = L.state, W = canvas.width, H = canvas.height;
      const ego = L.spec.kind === "ego";
      const accent = st.source === "BEACON" ? COLOR.BEACON
        : st.phase === "ALL_WAY_STOP" ? COLOR.STOP
        : (COLOR[st.phase] || COLOR.UNKNOWN);

      ctx.clearRect(0, 0, W, H);
      roundRect(ctx, 6, 6, W - 12, H - 12, 30);
      ctx.fillStyle = "rgba(24, 28, 33, 0.9)";
      ctx.fill();
      ctx.lineWidth = ego ? 7 : 4;
      ctx.strokeStyle = accent;
      ctx.stroke();

      // Confidence ring. Beacon = full blue ring (it isn't guessing).
      const cx = 122, cy = H / 2, r = 80;
      ctx.lineCap = "round";
      ctx.lineWidth = 16;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      const frac = st.source === "BEACON" ? 1 : Math.max(0, Math.min(1, st.conf));
      if (frac > 0) {
        ctx.strokeStyle = st.source === "FALLBACK" ? COLOR.UNKNOWN : accent;
        ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
      }
      if (st.source !== "BEACON") {            // tick = commit threshold
        const a = -Math.PI / 2 + this.threshold * Math.PI * 2;
        ctx.lineCap = "butt"; ctx.lineWidth = 5; ctx.strokeStyle = COLOR.TEXT;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * (r - 15), cy + Math.sin(a) * (r - 15));
        ctx.lineTo(cx + Math.cos(a) * (r + 15), cy + Math.sin(a) * (r + 15));
        ctx.stroke();
      }
      ctx.fillStyle = COLOR.TEXT;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `600 46px ${this.font}`;
      ctx.fillText(st.source === "BEACON" ? "Live" : `${Math.round(st.conf * 100)}%`, cx, cy + 2);

      // Text column
      const tx = 230, maxW = W - tx - 26, f = this.font;
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "rgba(232, 235, 230, 0.6)";
      fitText(ctx, ego ? "Your light" : (DIR_NAME[L.spec.dir] || L.spec.dir), tx, 54, maxW, 30, 500, f);

      ctx.fillStyle = accent;
      fitText(ctx, WORD[st.phase] || st.phase, tx, 112, maxW, 64, 700, f);

      ctx.fillStyle = COLOR.TEXT;
      const src = st.source === "BEACON" ? "From beacon"
        : st.source === "MODEL" ? "Read from traffic"
        : (st.guess && st.guess !== "UNKNOWN" ? "Model unsure" : "No traffic to read");
      fitText(ctx, src, tx, 156, maxW, 32, 500, f);

      if (this.showTruth) {
        const known = KNOWN.has(st.truth);
        const mark = known && st.source !== "FALLBACK" ? (st.phase === st.truth ? " \u2713" : " \u2717") : "";
        const label = known ? `Actual: ${WORD[st.truth].toLowerCase()}` : "Actual: not visible to car";
        ctx.fillStyle = "rgba(232, 235, 230, 0.6)";
        const w = fitText(ctx, label, tx, 200, maxW - (mark ? 30 : 0), 30, 500, f);
        if (mark) {
          ctx.fillStyle = mark.includes("\u2713") ? COLOR.GO : COLOR.CAUTION;
          ctx.fillText(mark, tx + w, 200);
        }
      }
      L.tex.needsUpdate = true;
    }
  }

  if (typeof window !== "undefined") window.SignalOverlay = SignalOverlay;
  if (typeof module !== "undefined") module.exports = SignalOverlay;
})();
