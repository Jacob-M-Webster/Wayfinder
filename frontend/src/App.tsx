import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ChangeEvent } from 'react'
import {
  Bike,
  Box,
  CarFront,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  FileJson,
  FolderOpen,
  Footprints,
  LoaderCircle,
  MouseLeft,
  MouseRight,
  Upload,
  X,
  ZoomIn,
} from 'lucide'
import type { IconNode } from 'lucide'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import scene55Url from '../../demo_data/scene_55.json?url'
import scene116Url from '../../demo_data/scene_116.json?url'
import scene117Url from '../../demo_data/scene_117.json?url'
import './App.css'
import { SignalOverlay } from './signal_overlay'
import type { OverlaySceneData } from './signal_overlay'

type Point = [number, number]
type AgentState = [number, number, number] | null

type Lane = {
  id: number
  points: Point[]
  controlled: boolean
}

type SceneData = {
  scenario_id: string
  hz: number
  num_steps: number
  units: string
  approach_order: string[]
  map: {
    lanes: Lane[]
    road_edges: { points: Point[] }[]
    crosswalks: { points: Point[] }[]
  }
  signals: {
    lane_id: number
    approach?: string
    stop: Point
    heading: number
  }[]
  agents: {
    id: number
    type: 'vehicle' | 'pedestrian' | 'cyclist' | string
    is_sdc?: boolean
    length: number
    width: number
    states: AgentState[]
  }[]
  truth: {
    approach: Record<string, string>[]
    lane: Record<string, string>[]
  }
  // Added by predict_scene.py; absent in older scene files.
  ego_lane?: number | null
  ego_approach?: string | null
  model?: OverlaySceneData['model']
}

type Bounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

type EdgeFade = Bounds & {
  fadeDistance: number
}

type ThreeRefs = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  staticGroup: THREE.Group
  dynamicGroup: THREE.Group
  dynamicState: DynamicSceneState | null
  raycaster: THREE.Raycaster
  pointer: THREE.Vector2
  hoveredAgent: AgentRender | null
  frameId: number
}

type AgentRender = {
  agent: SceneData['agents'][number]
  box: THREE.Mesh
  outline: THREE.LineSegments
  headingIcon: THREE.Mesh
  trail: THREE.Line
}

type DynamicSceneState = {
  agents: AgentRender[]
  signalGroup: THREE.Group
}

const signalColors: Record<string, number> = {
  STOP: 0xf25555,
  CAUTION: 0xf7c948,
  GO: 0x43d17a,
  UNKNOWN: 0x8a94a8,
  NONE: 0x3b4252,
}

const agentColors: Record<string, number> = {
  vehicle: 0x58c7f7,
  pedestrian: 0xf8b86a,
  cyclist: 0xc37df4,
  other: 0xcfd6e3,
}

const agentLegend = [
  { label: 'SDC', color: '#ffffff', icon: Crosshair },
  { label: 'Vehicle', color: '#58c7f7', icon: CarFront },
  { label: 'Pedestrian', color: '#f8b86a', icon: Footprints },
  { label: 'Cyclist', color: '#c37df4', icon: Bike },
  { label: 'Other', color: '#cfd6e3', icon: Box },
]

const maxPolarAngle = (82 * Math.PI) / 180
const minPolarAngle = (10 * Math.PI) / 180
const sceneBackground = 0x101722
const initialFocusZoom = 1.4
const demoScenes = [
  { label: 'Scene 55', fileName: 'scene_55.json', url: scene55Url },
  { label: 'Scene 116', fileName: 'scene_116.json', url: scene116Url },
  { label: 'Scene 117', fileName: 'scene_117.json', url: scene117Url },
]

function App() {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const hoverDotRef = useRef<HTMLDivElement | null>(null)
  const threeRef = useRef<ThreeRefs | null>(null)
  const playTimerRef = useRef<number | null>(null)
  const zoomRef = useRef(1)
  const [sceneData, setSceneData] = useState<SceneData | null>(null)
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [loopPlayback, setLoopPlayback] = useState(true)
  const [loading, setLoading] = useState(true)
  const [controlGuideOpen, setControlGuideOpen] = useState(true)
  const overlayRef = useRef<SignalOverlay | null>(null)
  const [overlayOn, setOverlayOn] = useState(false)
  // Not wired to anything yet: will come from the BLE receiver / demo stage.
  const [beaconAlive] = useState(false)
  const [loadDialogOpen, setLoadDialogOpen] = useState(false)

  const bounds = useMemo(() => (sceneData ? getBounds(sceneData) : null), [sceneData])

  const loadScene = useCallback(async (url: string, successMessage: string) => {
    try {
      setLoading(true)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as SceneData
      setSceneData(data)
      setStep(0)
      setPlaying(false)
      console.info(successMessage)
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Unable to load scene')
    } finally {
      setLoading(false)
    }
  }, [])

  const recenterScene = useCallback(() => {
    if (!threeRef.current || !bounds) return
    if (sceneData && focusSdcCamera(threeRef.current.camera, threeRef.current.controls, sceneData, 0)) {
      zoomRef.current = initialFocusZoom
      setZoom(initialFocusZoom)
      applyCameraZoom(threeRef.current.camera, initialFocusZoom)
      return
    }

    fitCamera(threeRef.current.camera, threeRef.current.controls, bounds)
    zoomRef.current = 1
    setZoom(1)
    applyCameraZoom(threeRef.current.camera, 1)
  }, [bounds, sceneData])

  const changeZoom = useCallback((value: number) => {
    zoomRef.current = value
    setZoom(value)
    if (threeRef.current) {
      applyCameraZoom(threeRef.current.camera, value)
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => {
      void loadScene(scene116Url, 'Demo scene 116 loaded')
    })
  }, [loadScene])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(sceneBackground)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap

    const threeScene = new THREE.Scene()
    threeScene.background = new THREE.Color(sceneBackground)
    threeScene.fog = new THREE.Fog(sceneBackground, 180, 420)

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1200)
    camera.up.set(0, 0, 1)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.screenSpacePanning = false
    controls.minDistance = 18
    controls.maxDistance = 420
    controls.minPolarAngle = minPolarAngle
    controls.maxPolarAngle = maxPolarAngle
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    }
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    }

    const staticGroup = new THREE.Group()
    const dynamicGroup = new THREE.Group()
    threeScene.add(staticGroup, dynamicGroup)
    addLights(threeScene)

    stage.appendChild(renderer.domElement)
    renderer.domElement.className = 'three-canvas'
    renderer.domElement.addEventListener('contextmenu', preventMenu)

    const refs: ThreeRefs = {
      renderer,
      scene: threeScene,
      camera,
      controls,
      staticGroup,
      dynamicGroup,
      dynamicState: null,
      raycaster: new THREE.Raycaster(),
      pointer: new THREE.Vector2(),
      hoveredAgent: null,
      frameId: 0,
    }
    threeRef.current = refs

    const updateHover = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      refs.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1))
      refs.raycaster.setFromCamera(refs.pointer, camera)

      const hoverables = refs.dynamicState?.agents
        .filter(({ agent, box }) => agent.type === 'vehicle' && !agent.is_sdc && box.visible)
        .map(({ box }) => box) ?? []
      const hit = refs.raycaster.intersectObjects(hoverables, false)[0]
      setHoveredAgent(refs, hit?.object instanceof THREE.Mesh ? hit.object : null)
    }

    const clearHover = () => {
      setHoveredAgent(refs, null)
      hideHoverDot(hoverDotRef.current)
    }

    const resize = () => {
      const rect = stage.getBoundingClientRect()
      camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height)
      camera.updateProjectionMatrix()
      renderer.setSize(rect.width, rect.height, false)
    }

    const animate = (now: number) => {
      controls.update()
      overlayRef.current?.animate(now)
      updateHoverDot(hoverDotRef.current, stage, camera, refs.hoveredAgent)
      renderer.render(threeScene, camera)
      refs.frameId = window.requestAnimationFrame(animate)
    }

    resize()
    animate(performance.now())
    window.addEventListener('resize', resize)
    renderer.domElement.addEventListener('pointermove', updateHover)
    renderer.domElement.addEventListener('pointerleave', clearHover)

    return () => {
      window.removeEventListener('resize', resize)
      renderer.domElement.removeEventListener('pointermove', updateHover)
      renderer.domElement.removeEventListener('pointerleave', clearHover)
      renderer.domElement.removeEventListener('contextmenu', preventMenu)
      window.cancelAnimationFrame(refs.frameId)
      clearHover()
      controls.dispose()
      clearGroup(staticGroup)
      clearGroup(dynamicGroup)
      renderer.dispose()
      renderer.domElement.remove()
      threeRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!threeRef.current || !sceneData || !bounds) return
    const { staticGroup, dynamicGroup, camera, controls } = threeRef.current
    clearGroup(staticGroup)
    clearGroup(dynamicGroup)
    clearHoveredAgent(threeRef.current)
    buildStaticScene(staticGroup, sceneData, bounds)
    threeRef.current.dynamicState = buildDynamicScene(dynamicGroup, sceneData)
    updateDynamicScene(threeRef.current.dynamicState, sceneData, 0, true)
    if (focusSdcCamera(camera, controls, sceneData, 0)) {
      zoomRef.current = initialFocusZoom
      setZoom(initialFocusZoom)
      applyCameraZoom(camera, initialFocusZoom)
    } else {
      fitCamera(camera, controls, bounds)
      applyCameraZoom(camera, zoomRef.current)
    }
  }, [sceneData, bounds])

  // One overlay per scene; rebuilt when a new scene loads.
  useEffect(() => {
    if (!threeRef.current || !sceneData) return
    const overlay = new SignalOverlay(threeRef.current.scene, sceneData, { zUp: true })
    overlayRef.current = overlay
    return () => {
      overlay.dispose()
      if (overlayRef.current === overlay) overlayRef.current = null
    }
  }, [sceneData])

  useEffect(() => {
    overlayRef.current?.setVisible(overlayOn)
  }, [sceneData, overlayOn])

  useEffect(() => {
    overlayRef.current?.update(step, beaconAlive)
  }, [sceneData, step, beaconAlive])

  useEffect(() => {
    if (!threeRef.current || !sceneData) return
    updateDynamicScene(threeRef.current.dynamicState, sceneData, step, !playing)
  }, [sceneData, step, playing])

  useEffect(() => {
    if (!playing || !sceneData) return

    playTimerRef.current = window.setInterval(() => {
      setStep((current) => {
        const next = current + 1
        if (next < sceneData.num_steps) return next
        if (loopPlayback) return 0

        window.setTimeout(() => setPlaying(false), 0)
        return current
      })
    }, 1000 / (sceneData.hz * playbackSpeed))

    return () => {
      if (playTimerRef.current) {
        window.clearInterval(playTimerRef.current)
        playTimerRef.current = null
      }
    }
  }, [playing, sceneData, loopPlayback, playbackSpeed])

  useEffect(() => {
    if (!loadDialogOpen) return

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLoadDialogOpen(false)
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [loadDialogOpen])

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setLoading(true)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as SceneData
        setSceneData(data)
        setStep(0)
        setPlaying(false)
        setLoadDialogOpen(false)
        console.info(`${file.name} loaded`)
      } catch {
        console.error('That file is not valid scene JSON')
      } finally {
        setLoading(false)
        event.target.value = ''
      }
    }
    reader.onerror = () => {
      console.error('Unable to read that file')
      setLoading(false)
      event.target.value = ''
    }
    reader.readAsText(file)
  }

  function handleDemoScene(url: string, fileName: string) {
    setLoadDialogOpen(false)
    void loadScene(url, `${fileName} loaded`)
  }

  const timeLabel = sceneData ? `${(step / sceneData.hz).toFixed(1)}s` : '0.0s'
  const totalTime = sceneData ? `${((sceneData.num_steps - 1) / sceneData.hz).toFixed(1)}s` : '0.0s'
  const frameLabel = sceneData ? `${step + 1}/${sceneData.num_steps}` : '0/0'

  return (
    <main className="app-shell">
      <section className="stage-wrap">
        <div className="stage" ref={stageRef}>
          <div className="hover-dot" ref={hoverDotRef} aria-hidden="true" />

          <div className={`guide-shell ${controlGuideOpen ? 'is-open' : 'is-closed'}`}>
            <section className="control-guide" aria-label="Application controls" aria-hidden={!controlGuideOpen}>
              <div className="guide-row">
                <Icon icon={MouseRight} />
                <span>Right click to Pan</span>
              </div>
              <div className="guide-row">
                <Icon icon={MouseLeft} />
                <span>Left click to Rotate</span>
              </div>
              <div className="guide-row">
                <Icon icon={ZoomIn} />
                <span>Scroll to Zoom</span>
              </div>
            </section>
            <button
              type="button"
              className="guide-toggle"
              aria-label={controlGuideOpen ? 'Hide controls guide' : 'Show controls guide'}
              aria-expanded={controlGuideOpen}
              onClick={() => setControlGuideOpen((value) => !value)}
            >
              <Icon icon={controlGuideOpen ? ChevronLeft : ChevronRight} />
            </button>
          </div>

          <div className="scene-toolbar" aria-label="Scene controls">
            <button type="button" onClick={() => setLoadDialogOpen(true)}>
              <Icon icon={FolderOpen} />
              Load JSON
            </button>
            <button type="button" onClick={recenterScene} disabled={!sceneData}>
              Recenter
            </button>
            <button
              type="button"
              className={overlayOn ? 'is-active' : undefined}
              aria-pressed={overlayOn}
              onClick={() => setOverlayOn((value) => !value)}
              disabled={!sceneData}
            >
              Overlay {overlayOn ? 'On' : 'Off'}
            </button>
            <label className="zoom-control">
              <span>Zoom</span>
              <input
                type="range"
                min="0.5"
                max="2.5"
                step="0.05"
                value={zoom}
                onChange={(event) => changeZoom(Number(event.target.value))}
                disabled={!sceneData}
              />
            </label>
          </div>

          <section className="agent-legend" aria-label="Agent color legend">
            {agentLegend.map((item) => (
              <div className="legend-item" key={item.label}>
                <span className="legend-swatch" style={{ '--legend-color': item.color } as CSSProperties}>
                  <Icon icon={item.icon} />
                </span>
                <span>{item.label}</span>
              </div>
            ))}
          </section>

          <div className="controls" aria-label="Playback controls">
            <button
              type="button"
              className="play-button"
              onClick={() => {
                if (!playing && sceneData && step >= sceneData.num_steps - 1 && !loopPlayback) {
                  setStep(0)
                }
                setPlaying((value) => !value)
              }}
              disabled={!sceneData}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            <span className="time-readout">{timeLabel}</span>
            <input
              type="range"
              min="0"
              max={Math.max(0, (sceneData?.num_steps ?? 1) - 1)}
              value={step}
              aria-label="Playback timeline"
              onChange={(event) => {
                setPlaying(false)
                setStep(Number(event.target.value))
              }}
              disabled={!sceneData}
            />
            <span className="frame-readout">{frameLabel}</span>
            <label className="speed-control">
              <span>Speed {playbackSpeed.toFixed(2)}x</span>
              <input
                type="range"
                min="0.25"
                max="3"
                step="0.25"
                value={playbackSpeed}
                onChange={(event) => setPlaybackSpeed(Number(event.target.value))}
                disabled={!sceneData}
              />
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={loopPlayback}
                onChange={(event) => setLoopPlayback(event.target.checked)}
              />
              Loop
            </label>
            <span className="time-readout end">{totalTime}</span>
          </div>

          {loading && (
            <div className="loading-screen" role="status" aria-live="polite">
              <Icon icon={LoaderCircle} className="loading-icon" />
              <span>Loading scene</span>
            </div>
          )}

          {loadDialogOpen && (
            <div
              className="modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setLoadDialogOpen(false)
              }}
            >
              <section
                className="load-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="load-dialog-title"
              >
                <header className="load-dialog-header">
                  <h2 id="load-dialog-title">Load JSON</h2>
                  <button type="button" className="icon-button" aria-label="Close" onClick={() => setLoadDialogOpen(false)}>
                    <Icon icon={X} />
                  </button>
                </header>

                <div className="load-dialog-grid">
                  <section className="load-panel" aria-labelledby="demo-data-title">
                    <h3 id="demo-data-title">Demo data</h3>
                    <div className="demo-scene-list">
                      {demoScenes.map((scene) => (
                        <button
                          type="button"
                          className="demo-scene-button"
                          key={scene.fileName}
                          onClick={() => handleDemoScene(scene.url, scene.fileName)}
                        >
                          <Icon icon={FileJson} />
                          <span>
                            <strong>{scene.label}</strong>
                            <small>{scene.fileName}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="load-panel upload-panel" aria-labelledby="upload-data-title">
                    <h3 id="upload-data-title">Upload your own</h3>
                    <label className="upload-dropzone">
                      <input type="file" accept=".json,application/json" onChange={handleFile} />
                      <Icon icon={Upload} />
                      <span>Select JSON file</span>
                    </label>
                  </section>
                </div>
              </section>
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

function preventMenu(event: MouseEvent) {
  event.preventDefault()
}

function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xd9ecff, 0x1b2330, 1.9))

  const key = new THREE.DirectionalLight(0xffffff, 2.4)
  key.position.set(-55, -35, 95)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  scene.add(key)

  const fill = new THREE.DirectionalLight(0x74c7ff, 0.85)
  fill.position.set(70, 60, 40)
  scene.add(fill)
}

function buildStaticScene(group: THREE.Group, sceneData: SceneData, bounds: Bounds) {
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  const spanX = bounds.maxX - bounds.minX
  const spanY = bounds.maxY - bounds.minY
  const size = Math.max(spanX, spanY) + 80
  const fade = makeEdgeFade(bounds)

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({
      color: 0x17202e,
      alphaMap: makeGroundAlphaMap(),
      transparent: true,
      roughness: 0.86,
      metalness: 0.05,
    }),
  )
  ground.position.set(centerX, centerY, -0.03)
  ground.receiveShadow = true
  group.add(ground)

  group.add(makeFadedGrid(centerX, centerY, size, Math.max(8, Math.floor(size / 20)), fade))

  sceneData.map.road_edges.forEach((edge) => {
    group.add(makeFadedLine(edge.points, 0x8b94a7, 0.85, 0.035, fade))
  })

  sceneData.map.lanes.forEach((lane) => {
    group.add(makeFadedLine(lane.points, lane.controlled ? 0x6fcaff : 0x8993a6, lane.controlled ? 0.48 : 0.3, 0.05, fade))
  })

  sceneData.map.crosswalks.forEach((crosswalk) => {
    const mesh = makeFadedPolygon(crosswalk.points, 0xe8eef7, 0.22, 0.025, fade)
    if (mesh) group.add(mesh)
  })
}

function buildDynamicScene(group: THREE.Group, sceneData: SceneData): DynamicSceneState {
  const agents = sceneData.agents.map((agent) => {
    const height = agent.type === 'pedestrian' ? 1.65 : agent.type === 'cyclist' ? 1.35 : 1.55
    const color = agent.is_sdc ? 0xffffff : agentColors[agent.type] ?? agentColors.other
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(agent.length, agent.width, height),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.42,
        metalness: agent.type === 'vehicle' ? 0.18 : 0.02,
      }),
    )
    box.visible = false
    box.castShadow = true

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(box.geometry, 18),
      new THREE.LineBasicMaterial({
        color: 0xdff7ff,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    )
    outline.scale.set(1.06, 1.06, 1.08)
    outline.visible = false
    outline.renderOrder = 60
    box.add(outline)
    group.add(box)

    const headingIcon = makeHeadingIcon(agent)
    headingIcon.visible = false
    group.add(headingIcon)

    const trail = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: agent.is_sdc ? 0xffffff : 0x7cd3ff,
        transparent: true,
        opacity: agent.is_sdc ? 0.58 : 0.26,
      }),
    )
    trail.visible = false
    group.add(trail)

    return { agent, box, outline, headingIcon, trail }
  })

  addTrafficLightConnections(group, sceneData.signals)

  const signalGroup = new THREE.Group()
  group.add(signalGroup)

  return { agents, signalGroup }
}

function updateDynamicScene(state: DynamicSceneState | null, sceneData: SceneData, step: number, showTrails: boolean) {
  if (!state) return
  const truth = sceneData.truth.lane[step] ?? {}

  state.agents.forEach(({ agent, box, outline, headingIcon, trail }) => {
    const agentState = agent.states[step]
    if (!agentState) {
      box.visible = false
      outline.visible = false
      headingIcon.visible = false
      trail.visible = false
      return
    }

    const [x, y, heading] = agentState
    const height = agent.type === 'pedestrian' ? 1.65 : agent.type === 'cyclist' ? 1.35 : 1.55
    box.position.set(x, y, height / 2)
    box.rotation.z = heading
    box.visible = true

    headingIcon.position.set(x, y, height + 0.1)
    headingIcon.rotation.z = heading
    headingIcon.visible = true

    updateTrail(trail, agent, step, showTrails)
  })

  clearGroup(state.signalGroup)
  sceneData.signals.forEach((signal) => {
    const signalState = truth[String(signal.lane_id)] ?? 'UNKNOWN'
    state.signalGroup.add(makeTrafficLight(signal.stop, signal.heading, signalState))
  })
}

function setHoveredAgent(refs: ThreeRefs, hoveredBox: THREE.Mesh | null) {
  const next = hoveredBox
    ? refs.dynamicState?.agents.find(({ box, agent }) => box === hoveredBox && agent.type === 'vehicle' && !agent.is_sdc) ?? null
    : null

  if (refs.hoveredAgent === next) return
  if (refs.hoveredAgent) refs.hoveredAgent.outline.visible = false
  refs.hoveredAgent = next
  if (refs.hoveredAgent) refs.hoveredAgent.outline.visible = true
}

function clearHoveredAgent(refs: ThreeRefs | null) {
  if (!refs) return
  if (refs.hoveredAgent) refs.hoveredAgent.outline.visible = false
  refs.hoveredAgent = null
}

function updateHoverDot(
  dot: HTMLDivElement | null,
  stage: HTMLDivElement,
  camera: THREE.PerspectiveCamera,
  hoveredAgent: AgentRender | null,
) {
  if (!dot || !hoveredAgent || !hoveredAgent.box.visible) {
    hideHoverDot(dot)
    return
  }

  const height = hoveredAgent.agent.type === 'pedestrian' ? 1.65 : hoveredAgent.agent.type === 'cyclist' ? 1.35 : 1.55
  const point = hoveredAgent.box.localToWorld(new THREE.Vector3(0, 0, height / 2 + 1.15))
  const projected = point.project(camera)

  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || projected.z < -1 || projected.z > 1) {
    hideHoverDot(dot)
    return
  }

  const rect = stage.getBoundingClientRect()
  dot.style.opacity = '1'
  dot.style.transform = `translate(${((projected.x + 1) / 2) * rect.width}px, ${((1 - projected.y) / 2) * rect.height}px)`
}

function hideHoverDot(dot: HTMLDivElement | null) {
  if (dot) dot.style.opacity = '0'
}

function fitCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, bounds: Bounds) {
  const center = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, 0)
  const spanX = bounds.maxX - bounds.minX
  const spanY = bounds.maxY - bounds.minY
  const radius = Math.max(spanX, spanY) * 0.64
  const distance = Math.max(60, radius / Math.sin((camera.fov * Math.PI) / 360))

  camera.position.set(center.x - distance * 0.58, center.y - distance * 0.72, distance * 0.62)
  controls.target.copy(center)
  controls.update()
}

function focusSdcCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, sceneData: SceneData, step: number) {
  const sdc = sceneData.agents.find((agent) => agent.is_sdc)
  const state = sdc?.states[step] ?? sdc?.states.find((agentState): agentState is [number, number, number] => Boolean(agentState))
  if (!state) return false

  const [x, y, heading] = state
  const center = new THREE.Vector3(x, y, 0)
  const distance = 34
  // Straight behind the car along its heading, looking forward over its roof.
  camera.position.set(
    x - Math.cos(heading) * distance * 0.9,
    y - Math.sin(heading) * distance * 0.9,
    distance * 0.4,
  )
  controls.target.copy(center)
  controls.update()
  return true
}

function applyCameraZoom(camera: THREE.PerspectiveCamera, zoom: number) {
  camera.zoom = zoom
  camera.updateProjectionMatrix()
}

function Icon({ icon, className }: { icon: IconNode; className?: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icon.map(([tag, attrs], index) => createElement(tag, { ...attrs, key: index }))}
    </svg>
  )
}

function makeHeadingIcon(agent: SceneData['agents'][number]) {
  const length = Math.max(0.72, Math.min(1.25, agent.length * 0.24))
  const width = Math.max(0.42, Math.min(0.82, agent.width * 0.48))
  const shape = new THREE.Shape([
    new THREE.Vector2(length * 0.54, 0),
    new THREE.Vector2(-length * 0.46, width / 2),
    new THREE.Vector2(-length * 0.26, 0),
    new THREE.Vector2(-length * 0.46, -width / 2),
  ])
  const icon = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({
      color: agent.is_sdc ? 0x101722 : 0x0b1520,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  )
  icon.renderOrder = 70
  return icon
}

function makeFadedLine(points: Point[], color: number, opacity: number, z: number, fade: EdgeFade) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, y]) => new THREE.Vector3(x, y, z)))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(points.flatMap((point) => makeFadedColor(point, color, fade)), 3))

  return new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
    }),
  )
}

function makeFadedPolygon(points: Point[], color: number, opacity: number, z: number, fade: EdgeFade) {
  if (points.length < 3) return null

  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))
  const geometry = new THREE.ShapeGeometry(shape)
  const colors: number[] = []
  const position = geometry.getAttribute('position')
  for (let index = 0; index < position.count; index += 1) {
    colors.push(...makeFadedColor([position.getX(index), position.getY(index)], color, fade))
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
    }),
  )
  mesh.position.z = z
  return mesh
}

function makeFadedGrid(centerX: number, centerY: number, size: number, divisions: number, fade: EdgeFade) {
  const group = new THREE.Group()
  const startX = centerX - size / 2
  const startY = centerY - size / 2
  const step = size / divisions

  for (let index = 0; index <= divisions; index += 1) {
    const offset = index * step
    const color = index === Math.floor(divisions / 2) ? 0x354153 : 0x222c3a
    const opacity = index === Math.floor(divisions / 2) ? 0.54 : 0.34

    group.add(makeFadedLine([[startX + offset, startY], [startX + offset, startY + size]], color, opacity, 0, fade))
    group.add(makeFadedLine([[startX, startY + offset], [startX + size, startY + offset]], color, opacity, 0, fade))
  }

  return group
}

function makeFadedColor(point: Point, color: number, fade: EdgeFade) {
  const edgeAmount = getEdgeFadeAmount(point, fade)
  const mixedColor = new THREE.Color(sceneBackground).lerp(new THREE.Color(color), edgeAmount)
  return [mixedColor.r, mixedColor.g, mixedColor.b]
}

function getEdgeFadeAmount([x, y]: Point, fade: EdgeFade) {
  const distanceToEdge = Math.min(x - fade.minX, fade.maxX - x, y - fade.minY, fade.maxY - y)
  return smoothstep(0, 1, clamp(distanceToEdge / fade.fadeDistance, 0, 1))
}

function makeGroundAlphaMap() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512

  const context = canvas.getContext('2d')
  if (context) {
    const gradient = context.createRadialGradient(256, 256, 150, 256, 256, 256)
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
    gradient.addColorStop(0.58, 'rgba(255, 255, 255, 0.96)')
    gradient.addColorStop(0.82, 'rgba(255, 255, 255, 0.36)')
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function makeEdgeFade(bounds: Bounds): EdgeFade {
  const spanX = bounds.maxX - bounds.minX
  const spanY = bounds.maxY - bounds.minY
  return {
    ...bounds,
    fadeDistance: Math.max(18, Math.min(52, Math.max(spanX, spanY) * 0.2)),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function addTrafficLightConnections(group: THREE.Group, signals: SceneData['signals']) {
  const anchors = getTrafficLightAnchors(signals)

  anchors.forEach((anchor, index) => {
    const axis = new THREE.Vector2(Math.cos(anchor.rotation), Math.sin(anchor.rotation))
    const rowNeighbors = anchors
      .filter((candidate, candidateIndex) => {
        if (candidateIndex === index) return false
        if (Math.abs(angleDelta(anchor.rotation, candidate.rotation)) > 0.16) return false

        const offset = candidate.point.clone().sub(anchor.point)
        const along = offset.dot(axis)
        const across = Math.abs(offset.x * -axis.y + offset.y * axis.x)
        return along > 0.35 && along < 7.2 && across < 1.2
      })
      .sort((a, b) => a.point.clone().sub(anchor.point).dot(axis) - b.point.clone().sub(anchor.point).dot(axis))

    const next = rowNeighbors[0]
    if (!next) return

    group.add(makeTrafficLightConnector(anchor.point, next.point))
  })
}

function getTrafficLightAnchors(signals: SceneData['signals']) {
  const anchors: { key: string; point: THREE.Vector2; rotation: number }[] = []
  const seen = new Set<string>()

  signals.forEach((signal) => {
    const rotation = signal.heading + Math.PI / 2
    const x = signal.stop[0] + Math.cos(rotation) * -1.65 + Math.cos(rotation + Math.PI / 2) * -0.34
    const y = signal.stop[1] + Math.sin(rotation) * -1.65 + Math.sin(rotation + Math.PI / 2) * -0.34
    const key = `${Math.round(x * 10)},${Math.round(y * 10)},${Math.round(rotation * 10)}`

    if (seen.has(key)) return
    seen.add(key)
    anchors.push({ key, point: new THREE.Vector2(x, y), rotation })
  })

  return anchors
}

function makeTrafficLightConnector(start: THREE.Vector2, end: THREE.Vector2) {
  const midpoint = start.clone().add(end).multiplyScalar(0.5)
  const length = start.distanceTo(end)
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const connector = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, length, 12),
    makeSignalMaterial({ color: 0x48515f, roughness: 0.5, metalness: 0.3 }),
  )

  connector.position.set(midpoint.x, midpoint.y, 2.16)
  connector.rotation.z = angle + Math.PI / 2
  connector.rotation.x = Math.PI / 2
  connector.castShadow = true
  connector.renderOrder = 25
  return connector
}

function makeTrafficLight(stop: Point, heading: number, state: string) {
  const group = new THREE.Group()
  const activeColor = signalColors[state] ?? signalColors.UNKNOWN

  const stopBar = new THREE.Mesh(
    new THREE.BoxGeometry(3.8, 0.2, 0.1),
    makeSignalMaterial({
      color: activeColor,
      emissive: activeColor,
      emissiveIntensity: 0.45,
      roughness: 0.45,
    }),
  )
  stopBar.position.z = 0.12
  group.add(stopBar)

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 1.9, 12),
    makeSignalMaterial({ color: 0x48515f, roughness: 0.5, metalness: 0.3 }),
  )
  pole.position.set(-1.65, -0.34, 0.95)
  pole.rotation.x = Math.PI / 2
  pole.castShadow = true
  group.add(pole)

  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.22, 1.06),
    makeSignalMaterial({ color: 0x202734, roughness: 0.52, metalness: 0.16 }),
  )
  housing.position.set(-1.65, -0.34, 1.96)
  housing.castShadow = true
  group.add(housing)

  const lensStates = [
    { key: 'STOP', z: 2.27, color: 0xf25555 },
    { key: 'CAUTION', z: 1.96, color: 0xf7c948 },
    { key: 'GO', z: 1.65, color: 0x43d17a },
  ]
  lensStates.forEach((lens) => {
    const isActive = state === lens.key
    const material = makeSignalMaterial({
      color: isActive ? lens.color : 0x2d3542,
      emissive: isActive ? lens.color : 0x000000,
      emissiveIntensity: isActive ? 1.8 : 0,
      roughness: 0.34,
    })
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.105, 18, 12), material)
    light.position.set(-1.65, -0.46, lens.z)
    light.scale.y = 0.35
    group.add(light)
  })

  if (state === 'UNKNOWN') {
    const unknownLens = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 16, 10),
      makeSignalMaterial({
        color: signalColors.UNKNOWN,
        emissive: signalColors.UNKNOWN,
        emissiveIntensity: 0.8,
        roughness: 0.4,
      }),
    )
    unknownLens.position.set(-1.65, -0.46, 1.36)
    unknownLens.scale.y = 0.35
    group.add(unknownLens)
  }

  group.position.set(stop[0], stop[1], 0)
  group.rotation.z = heading + Math.PI / 2
  group.renderOrder = 30
  group.traverse((object) => {
    object.renderOrder = 30
  })
  return group
}

function makeSignalMaterial(parameters: THREE.MeshStandardMaterialParameters) {
  return new THREE.MeshStandardMaterial({
    ...parameters,
    depthTest: false,
    depthWrite: false,
  })
}

function angleDelta(a: number, b: number) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b))
}

function updateTrail(trail: THREE.Line, agent: SceneData['agents'][number], step: number, showTrail: boolean) {
  if (!showTrail) {
    trail.visible = false
    return
  }

  const states = agent.states
    .slice(Math.max(0, step - 18), step + 1)
    .filter((state): state is [number, number, number] => Boolean(state))
  if (states.length < 2) {
    trail.visible = false
    return
  }

  const oldGeometry = trail.geometry
  trail.geometry = new THREE.BufferGeometry().setFromPoints(states.map(([x, y]) => new THREE.Vector3(x, y, 0.22)))
  oldGeometry.dispose()
  trail.visible = true
}

function getBounds(sceneData: SceneData) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const addPoint = ([x, y]: Point) => {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }

  sceneData.map.lanes.forEach((lane) => lane.points.forEach(addPoint))
  sceneData.map.road_edges.forEach((edge) => edge.points.forEach(addPoint))
  sceneData.map.crosswalks.forEach((crosswalk) => crosswalk.points.forEach(addPoint))

  return { minX, maxX, minY, maxY }
}

function clearGroup(group: THREE.Group) {
  group.traverse((object: THREE.Object3D) => {
    if ('geometry' in object && object.geometry instanceof THREE.BufferGeometry) {
      object.geometry.dispose()
    }
    if ('material' in object) {
      const material = object.material
      if (Array.isArray(material)) {
        material.forEach(disposeMaterial)
      } else if (material instanceof THREE.Material) {
        disposeMaterial(material)
      }
    }
  })
  group.clear()
}

function disposeMaterial(material: THREE.Material) {
  if ('map' in material && material.map instanceof THREE.Texture) {
    material.map.dispose()
  }
  if ('alphaMap' in material && material.alphaMap instanceof THREE.Texture) {
    material.alphaMap.dispose()
  }
  material.dispose()
}

export default App
