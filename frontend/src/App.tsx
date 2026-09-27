import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Bug } from 'lucide'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import logoUrl from './assets/logo.png'
import './App.css'
import { Icon } from './components/Icon'
import { AgentLegend } from './features/scenes/AgentLegend'
import { ControlGuide } from './features/scenes/ControlGuide'
import { LandingScreen } from './features/scenes/LandingScreen'
import type { HardwareScene } from './features/scenes/LandingScreen'
import { LoadSceneDialog } from './features/scenes/LoadSceneDialog'
import { LoadingScreen } from './features/scenes/LoadingScreen'
import { PlaybackControls } from './features/scenes/PlaybackControls'
import { SceneToolbar } from './features/scenes/SceneToolbar'
import { StagePanel } from './features/scenes/StagePanel'
import { demoScenes } from './features/scenes/demoScenes'
import type { DemoScene } from './features/scenes/demoScenes'
import { getStageInfo } from './features/scenes/stages'
import type { StageFlags } from './features/scenes/stages'
import { SignalOverlay, egoDecision } from './signal_overlay'
import {
  addLights,
  applyCameraZoom,
  buildDynamicScene,
  buildStaticScene,
  clearGroup,
  clearHoveredAgent,
  fitCamera,
  focusSdcCamera,
  followCamera,
  getBounds,
  hideHoverDot,
  interpolateAgents,
  preventMenu,
  setHoveredAgent,
  updateDynamicScene,
  updateHoverDot,
  updateSignalFlashes,
} from './three/sceneRenderer'
import { initialFocusZoom, maxPolarAngle, minPolarAngle, sceneBackground } from './three/sceneConstants'
import type { ThreeRefs } from './three/sceneTypes'
import type { SceneData } from './types/scene'

function App() {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const hoverDotRef = useRef<HTMLDivElement | null>(null)
  const threeRef = useRef<ThreeRefs | null>(null)
  const overlayRef = useRef<SignalOverlay | null>(null)
  const playTimerRef = useRef<number | null>(null)
  const cameraLockedRef = useRef(true)
  const zoomRef = useRef(1)

  const [sceneData, setSceneData] = useState<SceneData | null>(null)
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [cameraLocked, setCameraLocked] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [loopPlayback, setLoopPlayback] = useState(true)
  const [speedPopoverOpen, setSpeedPopoverOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [controlGuideOpen, setControlGuideOpen] = useState(true)
  const [topControlsOpen, setTopControlsOpen] = useState(true)
  const [activeSceneKey, setActiveSceneKey] = useState<string | null>(null)
  const [autoStage, setAutoStage] = useState(true)
  const [manualStage, setManualStage] = useState<StageFlags>({ gridUp: true, beaconAlive: true })
  const [loadDialogOpen, setLoadDialogOpen] = useState(false)
  // Testing controls (guide, toolbar, timeline). Hidden for the demo; 8 toggles them.
  const [testUiOpen, setTestUiOpen] = useState(false)

  const bounds = useMemo(() => (sceneData ? getBounds(sceneData) : null), [sceneData])
  const activeScene = demoScenes.find((scene) => scene.key === activeSceneKey) ?? null
  const sceneTime = sceneData ? step / sceneData.hz : 0
  const script = autoStage ? activeScene?.script : undefined
  const gridUp = script ? sceneTime < script.gridDownAt : manualStage.gridUp
  const beaconAlive = script ? sceneTime < script.beaconLostAt : manualStage.beaconAlive
  const beaconPhase = activeScene?.beaconPhase
  const ego = sceneData ? egoDecision(sceneData, step, beaconAlive, beaconPhase) : null
  const stage = getStageInfo(gridUp, beaconAlive, ego?.source)
  const timelineStates = useMemo(() => {
    if (!sceneData) return []

    const egoLane = sceneData.ego_lane ?? sceneData.model?.ego_lane ?? null
    const egoAgent = sceneData.agents.find((agent) => agent.is_sdc)
    const laneTruth = egoLane == null ? null : String(egoLane)

    return Array.from({ length: sceneData.num_steps }, (_, index) => {
      const phase = laneTruth ? sceneData.truth.lane[index]?.[laneTruth] : undefined
      if (phase === 'STOP' || phase === 'ALL_WAY_STOP') return 'stop' as const
      if (phase === 'GO') return 'go' as const

      const state = egoAgent?.states[index]
      const adjacentState = egoAgent?.states[index > 0 ? index - 1 : index + 1]
      if (!state || !adjacentState) return null
      const speed = Math.hypot(state[0] - adjacentState[0], state[1] - adjacentState[1]) * sceneData.hz
      return speed > 0.2 ? 'go' as const : 'stop' as const
    })
  }, [sceneData])
  const timelineGradient = useMemo(() => {
    if (!timelineStates.length) return undefined
    const colors = { stop: '#f25555', go: '#25c58a', unknown: '#687384' }
    const stops: string[] = []
    timelineStates.forEach((state, index) => {
      const color = colors[state ?? 'unknown']
      const start = (index / timelineStates.length) * 100
      const end = ((index + 1) / timelineStates.length) * 100
      stops.push(`${color} ${start}%`, `${color} ${end}%`)
    })
    return `linear-gradient(to right, ${stops.join(', ')})`
  }, [timelineStates])
  const currentTimelineState = timelineStates[step] ?? null

  const loadScene = useCallback(async (url: string, successMessage: string, sceneKey: string | null = null) => {
    try {
      setLoading(true)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as SceneData
      setSceneData(data)
      setActiveSceneKey(sceneKey)
      setAutoStage(true)
      setStep(0)
      setPlaying(true)
      console.info(successMessage)
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Unable to load scene')
    } finally {
      setLoading(false)
    }
  }, [])

  const overrideStage = useCallback(
    (patch: Partial<StageFlags>) => {
      setManualStage({ gridUp, beaconAlive, ...patch })
      setAutoStage(false)
    },
    [beaconAlive, gridUp],
  )

  const updateCameraLock = useCallback((locked: boolean) => {
    cameraLockedRef.current = locked
    setCameraLocked(locked)
  }, [])

  const recenterScene = useCallback(() => {
    if (!threeRef.current || !bounds) return
    updateCameraLock(true)
    if (sceneData && focusSdcCamera(threeRef.current.camera, threeRef.current.controls, sceneData, step)) {
      zoomRef.current = initialFocusZoom
      setZoom(initialFocusZoom)
      applyCameraZoom(threeRef.current.camera, initialFocusZoom)
      return
    }

    fitCamera(threeRef.current.camera, threeRef.current.controls, bounds)
    zoomRef.current = 1
    setZoom(1)
    applyCameraZoom(threeRef.current.camera, 1)
  }, [bounds, sceneData, step, updateCameraLock])

  const changeZoom = useCallback((value: number) => {
    zoomRef.current = value
    setZoom(value)
    if (threeRef.current) applyCameraZoom(threeRef.current.camera, value)
  }, [])

  useEffect(() => {
    const stageElement = stageRef.current
    if (!stageElement) return

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

    stageElement.appendChild(renderer.domElement)
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
      followTarget: null,
      clock: { step: 0, stepAt: 0, stepMs: 100, playing: false },
      lastFrame: 0,
      frameId: 0,
    }
    threeRef.current = refs

    const updateHover = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      refs.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1))
      refs.raycaster.setFromCamera(refs.pointer, camera)

      const hoverables =
        refs.dynamicState?.agents
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
      const rect = stageElement.getBoundingClientRect()
      camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height)
      camera.updateProjectionMatrix()
      renderer.setSize(rect.width, rect.height, false)
    }

    const animate = (now: number) => {
      const dt = refs.lastFrame ? Math.min(0.1, (now - refs.lastFrame) / 1000) : 0
      refs.lastFrame = now
      if (refs.dynamicState) {
        const { clock } = refs
        const frac = clock.playing ? THREE.MathUtils.clamp((now - clock.stepAt) / clock.stepMs, 0, 1) : 0
        interpolateAgents(refs.dynamicState, clock.step, frac)
        const sdcBox = refs.dynamicState.sdc?.box
        if (sdcBox?.visible) {
          refs.followTarget ??= new THREE.Vector3()
          refs.followTarget.set(sdcBox.position.x, sdcBox.position.y, 0)
        }
      }
      if (cameraLockedRef.current) followCamera(camera, controls, refs.followTarget, dt)
      controls.update()
      overlayRef.current?.animate(now)
      overlayRef.current?.fitToView(camera, renderer.domElement.clientHeight)
      updateHoverDot(hoverDotRef.current, stageElement, camera, refs.hoveredAgent)
      updateSignalFlashes(refs.dynamicState?.signalMaterials ?? [], performance.now())
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
    threeRef.current.followTarget = null
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

  useEffect(() => {
    if (!threeRef.current || !sceneData) return
    threeRef.current.clock = {
      step,
      stepAt: performance.now(),
      stepMs: 1000 / (sceneData.hz * playbackSpeed),
      playing,
    }
  }, [sceneData, step, playing, playbackSpeed])

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
    overlayRef.current?.setVisible(activeScene?.overlay ?? false)
  }, [sceneData, activeScene])

  useEffect(() => {
    overlayRef.current?.update(step, beaconAlive, beaconPhase)
  }, [sceneData, step, beaconAlive, beaconPhase])

  useEffect(() => {
    if (!threeRef.current || !sceneData) return
    updateDynamicScene(threeRef.current.dynamicState, sceneData, step, !playing, gridUp)
  }, [sceneData, step, playing, gridUp])

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

  const handlePlayPause = useCallback(() => {
    if (!sceneData) return
    if (!playing && step >= sceneData.num_steps - 1 && !loopPlayback) {
      setStep(0)
    }
    setPlaying((value) => !value)
  }, [loopPlayback, playing, sceneData, step])

  const returnToLanding = useCallback(() => {
    setPlaying(false)
    setSceneData(null)
    setActiveSceneKey(null)
    setStep(0)
    setLoadDialogOpen(false)
  }, [])

  useEffect(() => {
    if (loadDialogOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key.toLowerCase()
      const scene = demoScenes.find((item) => item.hotkey === key)
      if (scene) void loadScene(scene.url, `${scene.fileName} loaded`, scene.key)
      else if (key === '0') returnToLanding()
      else if (key === 'g') overrideStage({ gridUp: !gridUp })
      else if (key === 'b') overrideStage({ beaconAlive: !beaconAlive })
      else if (key === 'a') setAutoStage(true)
      else if (key === '8') setTestUiOpen((value) => !value)
      else if (key === ' ') {
        event.preventDefault()
        handlePlayPause()
      } else return
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [beaconAlive, gridUp, handlePlayPause, loadDialogOpen, loadScene, overrideStage, returnToLanding])

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setLoading(true)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as SceneData
        setSceneData(data)
        setActiveSceneKey(null)
        setStep(0)
        setPlaying(true)
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

  function handleDemoScene(scene: DemoScene) {
    setLoadDialogOpen(false)
    void loadScene(scene.url, `${scene.fileName} loaded`, scene.key)
  }

  const handleHardwareScene = useCallback((hardwareScene: HardwareScene) => {
    const hotkey = hardwareScene === 'SCENE_1' ? '1' : '2'
    const scene = demoScenes.find((item) => item.hotkey === hotkey)
    if (!scene) return

    setLoadDialogOpen(false)
    void loadScene(scene.url, `${scene.fileName} loaded`, scene.key)
  }, [loadScene])


  const timeLabel = sceneData ? `${(step / sceneData.hz).toFixed(1)}s` : '0.0s'
  const totalTime = sceneData ? `${((sceneData.num_steps - 1) / sceneData.hz).toFixed(1)}s` : '0.0s'
  const frameLabel = sceneData ? `${step + 1}/${sceneData.num_steps}` : '0/0'

  return (
    <main className="app-shell">
      <section className="stage-wrap">
        <div className="stage" ref={stageRef}>
          <div className="hover-dot" ref={hoverDotRef} aria-hidden="true" />
          <div className="top-overlay">
            <div className="top-left-box">
              <button
                type="button"
                className="app-logo"
                aria-label="Return to landing page"
                title="Return to landing page"
                onClick={returnToLanding}
              >
                <img src={logoUrl} alt="SDC" />
              </button>
              {testUiOpen && (
                <ControlGuide open={controlGuideOpen} onToggle={() => setControlGuideOpen((value) => !value)} />
              )}
            </div>

            <div className="top-right-stack">
              {testUiOpen && (
                <div className={`top-right-box ${topControlsOpen ? 'is-open' : 'is-collapsed'}`}>
                  <SceneToolbar
                    activeSceneKey={activeSceneKey}
                    cameraLocked={cameraLocked}
                    demoScenes={demoScenes}
                    sceneLoaded={Boolean(sceneData)}
                    topControlsOpen={topControlsOpen}
                    zoom={zoom}
                    onChangeScene={handleDemoScene}
                    onCameraLockChange={updateCameraLock}
                    onOpenLoadDialog={() => setLoadDialogOpen(true)}
                    onRecenter={recenterScene}
                    onToggleTopControls={() => setTopControlsOpen((value) => !value)}
                    onZoomChange={changeZoom}
                  />
                </div>
              )}
              {activeScene && (
                <div className="top-status-box">
                  <StagePanel stage={stage} />
                </div>
              )}
            </div>
          </div>

          <button
            type="button"
            className={`debug-toggle ${testUiOpen ? 'is-active' : ''}`}
            aria-pressed={testUiOpen}
            aria-label={testUiOpen ? 'Hide debug controls' : 'Show debug controls'}
            title={testUiOpen ? 'Hide debug controls' : 'Show debug controls'}
            onClick={() => setTestUiOpen((value) => !value)}
          >
            <Icon icon={Bug} />
          </button>

          <AgentLegend />

          {testUiOpen && (
            <PlaybackControls
              sceneLoaded={Boolean(sceneData)}
              step={step}
              maxStep={Math.max(0, (sceneData?.num_steps ?? 1) - 1)}
              playing={playing}
              loopPlayback={loopPlayback}
              playbackSpeed={playbackSpeed}
              speedPopoverOpen={speedPopoverOpen}
              timeLabel={timeLabel}
              totalTime={totalTime}
              frameLabel={frameLabel}
              timelineGradient={timelineGradient}
              currentTimelineState={currentTimelineState}
              onPlayPause={handlePlayPause}
              onStepChange={(nextStep) => {
                setPlaying(false)
                setStep(nextStep)
              }}
              onLoopChange={setLoopPlayback}
              onSpeedChange={setPlaybackSpeed}
              onSpeedPopoverChange={setSpeedPopoverOpen}
            />
          )}

          {!sceneData && <LandingScreen onSceneReceived={handleHardwareScene} />}

          {loading && <LoadingScreen />}

          {loadDialogOpen && (
            <LoadSceneDialog
              demoScenes={demoScenes}
              onClose={() => setLoadDialogOpen(false)}
              onDemoScene={handleDemoScene}
              onFile={handleFile}
            />
          )}
        </div>
      </section>
    </main>
  )
}

export default App
