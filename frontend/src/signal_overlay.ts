/*
  SignalOverlay: floating signal heads showing what the CAR BELIEVES each light is.

  - lamps light up with the decided phase (red lamp blinks for an all-way stop)
  - a badge above each head shows a confidence ring (tick = commit threshold), the phase,
    where the decision came from (Beacon / Model / Fallback), and the actual light

  One head per approach, plus a bigger "Your light" head on the Waymo car's own lane
  (that approach is replaced by it, so nothing is shown twice).

  Arbiter (same order as the planning doc):
    1. beacon alive and it knows the light       -> BEACON
    2. model committed (confidence >= threshold) -> MODEL
    3. otherwise                                 -> ALL_WAY_STOP (FALLBACK)

  Usage:
    const overlay = new SignalOverlay(threeScene, sceneJson, { zUp: true })
    overlay.update(step, beaconAlive)    // whenever the step or beacon state changes
    overlay.animate(performance.now())   // every frame (drives the blink)
    overlay.fitToView(camera, heightPx)  // every frame (badge sizing, see below)
    overlay.setVisible(on)               // toggle without rebuilding
    overlay.decisions                    // { ego: {...}, N: {...}, ... } for a HUD

  Badge size: each badge has a real-world size (badgeMeters, so it shrinks as you zoom out
  like everything else), clamped to a readable on-screen height range (badgePx, in CSS px).

  Internally the heads are built y-up (x, h, -y). With zUp the whole group is rotated so
  they land in a z-up world at (x, y, h), matching App.tsx.
  Ported from sample_data/signal_overlay.js (the standalone demo version).
*/
import * as THREE from 'three'

export type Phase = 'STOP' | 'CAUTION' | 'GO' | 'UNKNOWN' | 'ALL_WAY_STOP' | string
export type Source = 'BEACON' | 'MODEL' | 'FALLBACK'

export type Decision = {
  phase: Phase
  conf: number
  source: Source
  truth: string
  guess?: string
}

type ModelStep = [string, number, boolean]

export type OverlaySceneData = {
  ego_lane?: number | null
  signals: { lane_id: number; approach?: string; stop: [number, number]; heading: number }[]
  truth: { approach: Record<string, string>[]; lane: Record<string, string>[] }
  model?: {
    threshold: number
    ego_lane?: number | null
    approach: Record<string, ModelStep>[]
    ego: ModelStep[] | null
  }
}

export type OverlayOptions = {
  zUp?: boolean
  showTruth?: boolean
  // Badge height in meters, and its on-screen height limits in CSS px. The "Your light" badge
  // uses the ego values.
  badgeMeters?: { approach: number; ego: number }
  badgePx?: { approach: [number, number]; ego: [number, number] }
  poleHeight?: number
  font?: string
}

type LightSpec = {
  kind: 'approach' | 'ego'
  dir: string
  lane?: number
  x: number
  y: number
  heading: number
  scale: number
}

type Light = {
  spec: LightSpec
  root: THREE.Group
  lamps: Record<'STOP' | 'CAUTION' | 'GO', THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>>
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  tex: THREE.CanvasTexture
  sprite: THREE.Sprite
  key: string | null
  state: Decision | null
}

const KNOWN = new Set(['STOP', 'GO', 'CAUTION'])
const COLOR: Record<string, string> = {
  STOP: '#ff4438', CAUTION: '#ffb000', GO: '#19d3a2', // LED-style signal colors
  UNKNOWN: '#7d858c', BEACON: '#4aa8ff', TEXT: '#e8ebe6',
}
const DIM = { STOP: '#3a1512', CAUTION: '#3a2a0a', GO: '#0c3027' }
const WORD: Record<string, string> = {
  STOP: 'Stop', GO: 'Go', CAUTION: 'Caution', UNKNOWN: 'No read', ALL_WAY_STOP: 'All-way stop',
}
const DIR_NAME: Record<string, string> = { N: 'Northbound', E: 'Eastbound', S: 'Southbound', W: 'Westbound' }
const LAMP_KEYS = ['STOP', 'CAUTION', 'GO'] as const

const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
const circMean = (a: number[]) => Math.atan2(avg(a.map(Math.sin)), avg(a.map(Math.cos)))

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Shrink the font until the text fits the badge's text column.
function fitText(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
  maxW: number, size: number, weight: number, family: string,
) {
  let s = size
  ctx.font = `${weight} ${s}px ${family}`
  while (s > 16 && ctx.measureText(text).width > maxW) {
    s -= 2
    ctx.font = `${weight} ${s}px ${family}`
  }
  ctx.fillText(text, x, y)
  return ctx.measureText(text).width
}

/*
  The arbiter for one light. `target` is an approach ("N"/"E"/"S"/"W") or, for the car's own
  light, { lane } (uses the ego lane truth and model.ego).
*/
export function arbitrate(
  data: OverlaySceneData, target: string | { lane: number }, step: number, beaconAlive: boolean,
): Decision {
  const m = data.model
  const ego = typeof target !== 'string'
  const truth = ego
    ? (data.truth.lane[step] ?? {})[String(target.lane)] ?? 'UNKNOWN'
    : (data.truth.approach[step] ?? {})[target] ?? 'UNKNOWN'

  // The beacon replays the real signal timeline, so while it's alive it reports the truth.
  if (beaconAlive && KNOWN.has(truth)) return { phase: truth, conf: 1, source: 'BEACON', truth }

  let pred: ModelStep | null | undefined = null
  if (m) pred = ego ? m.ego?.[step] : (m.approach[step] ?? {})[target]
  const [phase, conf, committed] = pred ?? ['UNKNOWN', 0, false]
  if (committed) return { phase, conf, source: 'MODEL', truth }
  return { phase: 'ALL_WAY_STOP', conf, guess: phase, source: 'FALLBACK', truth }
}

/** The Waymo car's own light, or null if the scene has no ego lane. */
export function egoDecision(data: OverlaySceneData, step: number, beaconAlive: boolean): Decision | null {
  const lane = data.ego_lane ?? data.model?.ego_lane ?? null
  return lane == null ? null : arbitrate(data, { lane }, step, beaconAlive)
}

export class SignalOverlay {
  readonly group = new THREE.Group()
  decisions: Record<string, Decision> = {}

  private scene: THREE.Scene
  private data: OverlaySceneData
  private showTruth: boolean
  private font: string
  private poleHeight: number
  private badgeMeters: NonNullable<OverlayOptions['badgeMeters']>
  private badgePx: NonNullable<OverlayOptions['badgePx']>
  private threshold: number
  private blinkOn = true
  private lights: Light[]

  constructor(scene: THREE.Scene, data: OverlaySceneData, opts: OverlayOptions = {}) {
    this.scene = scene
    this.data = data
    this.showTruth = opts.showTruth ?? true
    this.font = opts.font ?? "'Barlow Condensed', 'Arial Narrow', sans-serif"
    this.poleHeight = opts.poleHeight ?? 5.5
    this.badgeMeters = opts.badgeMeters ?? { approach: 3, ego: 4 }
    this.badgePx = opts.badgePx ?? { approach: [90, 150], ego: [110, 190] }
    this.threshold = data.model?.threshold ?? 0.8
    // y-up internals -> z-up world: (x, h, -y) rotated +90deg about x becomes (x, y, h).
    if (opts.zUp) this.group.rotation.x = Math.PI / 2
    this.group.name = 'signal-overlay'
    scene.add(this.group)
    this.lights = this.buildLights()
    document.fonts?.ready.then(() => this.redrawAll())
  }

  // ---------- public ----------
  update(step: number, beaconAlive: boolean) {
    for (const L of this.lights) {
      const st = this.decide(L.spec, step, beaconAlive)
      L.state = st
      this.decisions[L.spec.kind === 'ego' ? 'ego' : L.spec.dir] = st
      this.setLamps(L)
      const key = [st.phase, Math.round(st.conf * 100), st.source, st.truth, st.guess, this.showTruth].join('|')
      if (key !== L.key) {
        L.key = key
        this.drawBadge(L)
      }
    }
  }

  animate(now: number) {
    const on = Math.floor(now / 500) % 2 === 0
    if (on === this.blinkOn) return
    this.blinkOn = on
    for (const L of this.lights) if (L.state?.phase === 'ALL_WAY_STOP') this.setLamps(L)
  }

  // Size each badge from its distance to the camera: real-world size, clamped to badgePx.
  // Sprites use sizeAttenuation=false, so scale is in view units at depth 1 (camera.zoom applies).
  fitToView(camera: THREE.PerspectiveCamera, viewportHeightPx: number) {
    if (!this.group.visible || viewportHeightPx <= 0) return
    const viewUnitsPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / (camera.zoom * viewportHeightPx)
    const p = new THREE.Vector3()
    for (const L of this.lights) {
      const ego = L.spec.kind === 'ego'
      const [minPx, maxPx] = ego ? this.badgePx.ego : this.badgePx.approach
      const depth = Math.max(0.1, -L.sprite.getWorldPosition(p).applyMatrix4(camera.matrixWorldInverse).z)
      const px = (ego ? this.badgeMeters.ego : this.badgeMeters.approach) / (depth * viewUnitsPerPx)
      const h = THREE.MathUtils.clamp(px, minPx, maxPx) * viewUnitsPerPx
      L.sprite.scale.set(h * 2, h, 1)
    }
  }

  get visible() {
    return this.group.visible
  }

  setVisible(v: boolean) {
    this.group.visible = v
  }

  setShowTruth(v: boolean) {
    this.showTruth = v
    this.redrawAll()
  }

  dispose() {
    this.scene.remove(this.group)
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry.dispose()
        const m = o.material as THREE.Material & { map?: THREE.Texture | null }
        m.map?.dispose()
        m.dispose()
      }
    })
  }

  // ---------- decision (arbiter) ----------
  private decide(spec: LightSpec, step: number, beaconAlive: boolean): Decision {
    const target = spec.kind === 'ego' && spec.lane != null ? { lane: spec.lane } : spec.dir
    return arbitrate(this.data, target, step, beaconAlive)
  }

  // ---------- building ----------
  private buildLights() {
    const d = this.data
    const byDir: Record<string, OverlaySceneData['signals']> = {}
    for (const s of d.signals) {
      if (!s.approach) continue
      ;(byDir[s.approach] ??= []).push(s)
    }
    const egoLane = d.ego_lane ?? d.model?.ego_lane ?? null
    const egoSig = egoLane != null ? d.signals.find((s) => s.lane_id === egoLane) : undefined
    const lights: Light[] = []
    for (const [dir, sigs] of Object.entries(byDir)) {
      if (egoSig && dir === egoSig.approach) continue
      lights.push(this.makeLight({
        kind: 'approach', dir,
        x: avg(sigs.map((s) => s.stop[0])), y: avg(sigs.map((s) => s.stop[1])),
        heading: circMean(sigs.map((s) => s.heading)), scale: 1,
      }))
    }
    if (egoSig && egoLane != null) {
      lights.push(this.makeLight({
        kind: 'ego', dir: egoSig.approach ?? '', lane: egoLane,
        x: egoSig.stop[0], y: egoSig.stop[1], heading: egoSig.heading, scale: 1.45,
      }))
    }
    return lights
  }

  private makeLight(spec: LightSpec): Light {
    const s = spec.scale
    const root = new THREE.Group()
    root.position.set(spec.x, 0, -spec.y)
    root.rotation.y = spec.heading

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06 * s, 0.06 * s, this.poleHeight * s, 8),
      new THREE.MeshBasicMaterial({ color: '#4a5058' }),
    )
    pole.position.y = (this.poleHeight * s) / 2
    root.add(pole)

    // Housing: local +x is the direction of travel, so lamps sit on the -x face,
    // facing the cars that are approaching this stop line.
    const head = new THREE.Group()
    head.position.y = this.poleHeight * s + 0.8 * s
    head.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.5 * s, 1.55 * s, 0.55 * s),
      new THREE.MeshBasicMaterial({ color: '#1f2327' }),
    ))
    const lampY = { STOP: 0.47, CAUTION: 0, GO: -0.47 }
    const lamps = {} as Light['lamps']
    for (const k of LAMP_KEYS) {
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.19 * s, 16, 12),
        new THREE.MeshBasicMaterial({ color: DIM[k] }),
      )
      lamp.position.set(-0.26 * s, lampY[k] * s, 0)
      head.add(lamp)
      lamps[k] = lamp
    }
    root.add(head)

    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 256
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, sizeAttenuation: false,
    }))
    sprite.renderOrder = 40
    sprite.scale.set(0.2, 0.1, 1) // placeholder until the first fitToView
    sprite.center.set(0.5, 0) // sit on top of the signal head, not over it
    sprite.position.y = head.position.y + 1.0 * s
    root.add(sprite)

    this.group.add(root)
    return { spec, root, lamps, canvas, ctx: canvas.getContext('2d')!, tex, sprite, key: null, state: null }
  }

  // ---------- drawing ----------
  private setLamps(L: Light) {
    const p = L.state?.phase
    const on = {
      STOP: p === 'STOP' || (p === 'ALL_WAY_STOP' && this.blinkOn),
      CAUTION: p === 'CAUTION',
      GO: p === 'GO',
    }
    for (const k of LAMP_KEYS) L.lamps[k].material.color.set(on[k] ? COLOR[k] : DIM[k])
  }

  private redrawAll() {
    for (const L of this.lights) {
      if (L.state) {
        L.key = null
        this.drawBadge(L)
      }
    }
  }

  private drawBadge(L: Light) {
    const { ctx, canvas } = L
    const st = L.state
    if (!st) return
    const W = canvas.width
    const H = canvas.height
    const ego = L.spec.kind === 'ego'
    const accent = st.source === 'BEACON' ? COLOR.BEACON
      : st.phase === 'ALL_WAY_STOP' ? COLOR.STOP
      : COLOR[st.phase] ?? COLOR.UNKNOWN

    ctx.clearRect(0, 0, W, H)
    roundRect(ctx, 6, 6, W - 12, H - 12, 30)
    ctx.fillStyle = 'rgba(24, 28, 33, 0.9)'
    ctx.fill()
    ctx.lineWidth = ego ? 7 : 4
    ctx.strokeStyle = accent
    ctx.stroke()

    // Confidence ring. Beacon = full blue ring (it isn't guessing).
    const cx = 122
    const cy = H / 2
    const r = 80
    ctx.lineCap = 'round'
    ctx.lineWidth = 16
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
    const frac = st.source === 'BEACON' ? 1 : Math.max(0, Math.min(1, st.conf))
    if (frac > 0) {
      ctx.strokeStyle = st.source === 'FALLBACK' ? COLOR.UNKNOWN : accent
      ctx.beginPath()
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2)
      ctx.stroke()
    }
    if (st.source !== 'BEACON') { // tick = commit threshold
      const a = -Math.PI / 2 + this.threshold * Math.PI * 2
      ctx.lineCap = 'butt'
      ctx.lineWidth = 5
      ctx.strokeStyle = COLOR.TEXT
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * (r - 15), cy + Math.sin(a) * (r - 15))
      ctx.lineTo(cx + Math.cos(a) * (r + 15), cy + Math.sin(a) * (r + 15))
      ctx.stroke()
    }
    ctx.fillStyle = COLOR.TEXT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `600 46px ${this.font}`
    ctx.fillText(st.source === 'BEACON' ? 'Live' : `${Math.round(st.conf * 100)}%`, cx, cy + 2)

    // Text column
    const tx = 230
    const maxW = W - tx - 26
    const f = this.font
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = 'rgba(232, 235, 230, 0.6)'
    fitText(ctx, ego ? 'Your light' : DIR_NAME[L.spec.dir] ?? L.spec.dir, tx, 54, maxW, 30, 500, f)

    ctx.fillStyle = accent
    fitText(ctx, WORD[st.phase] ?? st.phase, tx, 112, maxW, 64, 700, f)

    ctx.fillStyle = COLOR.TEXT
    const src = st.source === 'BEACON' ? 'From beacon'
      : st.source === 'MODEL' ? 'Read from traffic'
      : st.guess && st.guess !== 'UNKNOWN' ? 'Model unsure' : 'No traffic to read'
    fitText(ctx, src, tx, 156, maxW, 32, 500, f)

    if (this.showTruth) {
      const known = KNOWN.has(st.truth)
      const mark = known && st.source !== 'FALLBACK' ? (st.phase === st.truth ? ' ✓' : ' ✗') : ''
      const label = known ? `Actual: ${WORD[st.truth].toLowerCase()}` : 'Actual: not visible to car'
      ctx.fillStyle = 'rgba(232, 235, 230, 0.6)'
      const w = fitText(ctx, label, tx, 200, maxW - (mark ? 30 : 0), 30, 500, f)
      if (mark) {
        ctx.fillStyle = mark.includes('✓') ? COLOR.GO : COLOR.CAUTION
        ctx.fillText(mark, tx + w, 200)
      }
    }
    L.tex.needsUpdate = true
  }
}
