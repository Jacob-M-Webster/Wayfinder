import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import './App.css'

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
}

type Bounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

type ThreeRefs = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  staticGroup: THREE.Group
  dynamicGroup: THREE.Group
  frameId: number
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

const maxPolarAngle = (82 * Math.PI) / 180
const minPolarAngle = (10 * Math.PI) / 180
const sceneBackground = 0x101722

function App() {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const threeRef = useRef<ThreeRefs | null>(null)
  const playTimerRef = useRef<number | null>(null)
  const [sceneData, setSceneData] = useState<SceneData | null>(null)
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [status, setStatus] = useState('Loading sample scene...')
  const [showTrails, setShowTrails] = useState(true)

  const bounds = useMemo(() => (sceneData ? getBounds(sceneData) : null), [sceneData])
  const visibleAgents = useMemo(
    () => sceneData?.agents.filter((agent) => agent.states[step]).length ?? 0,
    [sceneData, step],
  )

  const loadScene = useCallback(async (url: string, successMessage: string) => {
    try {
      setStatus('Loading scene...')
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as SceneData
      setSceneData(data)
      setStep(0)
      setPlaying(false)
      setStatus(successMessage)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to load scene')
    }
  }, [])

  const fitScene = useCallback(() => {
    if (!threeRef.current || !bounds) return
    fitCamera(threeRef.current.camera, threeRef.current.controls, bounds)
  }, [bounds])

  useEffect(() => {
    queueMicrotask(() => {
      void loadScene('/scene.json', 'Sample scene loaded')
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
      frameId: 0,
    }
    threeRef.current = refs

    const resize = () => {
      const rect = stage.getBoundingClientRect()
      camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height)
      camera.updateProjectionMatrix()
      renderer.setSize(rect.width, rect.height, false)
    }

    const animate = () => {
      controls.update()
      renderer.render(threeScene, camera)
      refs.frameId = window.requestAnimationFrame(animate)
    }

    resize()
    animate()
    window.addEventListener('resize', resize)

    return () => {
      window.removeEventListener('resize', resize)
      renderer.domElement.removeEventListener('contextmenu', preventMenu)
      window.cancelAnimationFrame(refs.frameId)
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
    const { staticGroup, camera, controls } = threeRef.current
    clearGroup(staticGroup)
    buildStaticScene(staticGroup, sceneData, bounds)
    fitCamera(camera, controls, bounds)
  }, [sceneData, bounds])

  useEffect(() => {
    if (!threeRef.current || !sceneData) return
    const { dynamicGroup } = threeRef.current
    clearGroup(dynamicGroup)
    buildDynamicScene(dynamicGroup, sceneData, step, showTrails)
  }, [sceneData, step, showTrails])

  useEffect(() => {
    if (!playing || !sceneData) return

    playTimerRef.current = window.setInterval(() => {
      setStep((current) => (current + 1) % sceneData.num_steps)
    }, 1000 / sceneData.hz)

    return () => {
      if (playTimerRef.current) {
        window.clearInterval(playTimerRef.current)
        playTimerRef.current = null
      }
    }
  }, [playing, sceneData])

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as SceneData
        setSceneData(data)
        setStep(0)
        setPlaying(false)
        setStatus(`${file.name} loaded`)
      } catch {
        setStatus('That file is not valid scene JSON')
      }
    }
    reader.readAsText(file)
  }

  const approaches = sceneData?.truth.approach[step] ?? {}
  const timeLabel = sceneData ? `${(step / sceneData.hz).toFixed(1)}s` : '0.0s'
  const totalTime = sceneData ? `${((sceneData.num_steps - 1) / sceneData.hz).toFixed(1)}s` : '0.0s'

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Waymo scene</p>
          <h1>Three.js Scene Visualizer</h1>
        </div>
        <div className="topbar-actions">
          <label className="file-button">
            <input type="file" accept=".json,application/json" onChange={handleFile} />
            Load JSON
          </label>
          <button type="button" onClick={fitScene} disabled={!sceneData}>
            Fit
          </button>
        </div>
      </header>

      <section className="viewer-layout">
        <aside className="scene-panel">
          <div className="metric-grid">
            <div>
              <span>Scenario</span>
              <strong>{sceneData?.scenario_id ?? '-'}</strong>
            </div>
            <div>
              <span>Frame</span>
              <strong>
                {sceneData ? step + 1 : 0}/{sceneData?.num_steps ?? 0}
              </strong>
            </div>
            <div>
              <span>Time</span>
              <strong>
                {timeLabel}/{totalTime}
              </strong>
            </div>
            <div>
              <span>Visible agents</span>
              <strong>{visibleAgents}</strong>
            </div>
          </div>

          <div className="approach-list">
            {sceneData?.approach_order.map((approach) => (
              <div key={approach} className="approach-row">
                <span>{approach}</span>
                <strong data-state={approaches[approach] ?? 'UNKNOWN'}>
                  {approaches[approach] ?? 'UNKNOWN'}
                </strong>
              </div>
            ))}
          </div>

          <div className="legend">
            <span>
              <i className="legend-agent vehicle" /> Vehicle
            </span>
            <span>
              <i className="legend-agent pedestrian" /> Pedestrian
            </span>
            <span>
              <i className="legend-agent cyclist" /> Cyclist
            </span>
            <span>
              <i className="legend-signal go" /> Go
            </span>
            <span>
              <i className="legend-signal stop" /> Stop
            </span>
          </div>

          <p className="status">{status}</p>
        </aside>

        <section className="stage-wrap">
          <div className="stage" ref={stageRef} />

          <div className="controls">
            <button type="button" className="play-button" onClick={() => setPlaying((value) => !value)} disabled={!sceneData}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <input
              type="range"
              min="0"
              max={Math.max(0, (sceneData?.num_steps ?? 1) - 1)}
              value={step}
              onChange={(event) => {
                setPlaying(false)
                setStep(Number(event.target.value))
              }}
              disabled={!sceneData}
            />
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={showTrails}
                onChange={(event) => setShowTrails(event.target.checked)}
              />
              Trails
            </label>
          </div>
        </section>
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

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: 0x17202e, roughness: 0.86, metalness: 0.05 }),
  )
  ground.position.set(centerX, centerY, -0.03)
  ground.receiveShadow = true
  group.add(ground)

  const grid = new THREE.GridHelper(size, Math.max(8, Math.floor(size / 20)), 0x354153, 0x222c3a)
  grid.rotation.x = Math.PI / 2
  grid.position.set(centerX, centerY, 0)
  group.add(grid)
  group.add(makeCircularFog(centerX, centerY, size * 0.72))

  const roadEdgeMaterial = new THREE.LineBasicMaterial({ color: 0x8b94a7, transparent: true, opacity: 0.85 })
  const controlledLaneMaterial = new THREE.LineBasicMaterial({ color: 0x6fcaff, transparent: true, opacity: 0.48 })
  const laneMaterial = new THREE.LineBasicMaterial({ color: 0x8993a6, transparent: true, opacity: 0.3 })

  sceneData.map.road_edges.forEach((edge) => {
    group.add(makeLine(edge.points, roadEdgeMaterial, 0.035))
  })

  sceneData.map.lanes.forEach((lane) => {
    group.add(makeLine(lane.points, lane.controlled ? controlledLaneMaterial : laneMaterial, 0.05))
  })

  const crosswalkMaterial = new THREE.MeshStandardMaterial({
    color: 0xe8eef7,
    transparent: true,
    opacity: 0.22,
    roughness: 0.72,
    side: THREE.DoubleSide,
  })
  sceneData.map.crosswalks.forEach((crosswalk) => {
    const mesh = makePolygon(crosswalk.points, crosswalkMaterial, 0.025)
    if (mesh) group.add(mesh)
  })
}

function buildDynamicScene(group: THREE.Group, sceneData: SceneData, step: number, showTrails: boolean) {
  const truth = sceneData.truth.lane[step] ?? {}

  sceneData.agents.forEach((agent) => {
    const state = agent.states[step]
    if (!state) return

    if (showTrails) {
      const trail = makeTrail(agent, step)
      if (trail) group.add(trail)
    }

    const [x, y, heading] = state
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
    box.position.set(x, y, height / 2)
    box.rotation.z = heading
    box.castShadow = true
    group.add(box)

    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(Math.min(agent.width * 0.34, 0.45), 0.85, 3),
      new THREE.MeshStandardMaterial({ color: 0x101827, roughness: 0.5 }),
    )
    nose.position.set(x + Math.cos(heading) * agent.length * 0.36, y + Math.sin(heading) * agent.length * 0.36, height + 0.08)
    nose.rotation.z = heading - Math.PI / 2
    nose.rotation.x = Math.PI / 2
    group.add(nose)
  })

  addTrafficLightConnections(group, sceneData.signals)

  sceneData.signals.forEach((signal) => {
    const state = truth[String(signal.lane_id)] ?? 'UNKNOWN'
    group.add(makeTrafficLight(signal.stop, signal.heading, state))
  })
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

function makeLine(points: Point[], material: THREE.LineBasicMaterial, z: number) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, y]) => new THREE.Vector3(x, y, z)))
  return new THREE.Line(geometry, material)
}

function makePolygon(points: Point[], material: THREE.Material, z: number) {
  if (points.length < 3) return null

  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))
  const geometry = new THREE.ShapeGeometry(shape)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.z = z
  return mesh
}

function makeCircularFog(centerX: number, centerY: number, radius: number) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512

  const context = canvas.getContext('2d')
  if (context) {
    const gradient = context.createRadialGradient(256, 256, 170, 256, 256, 256)
    gradient.addColorStop(0, 'rgba(16, 23, 34, 0)')
    gradient.addColorStop(0.58, 'rgba(16, 23, 34, 0.18)')
    gradient.addColorStop(0.82, 'rgba(16, 23, 34, 0.72)')
    gradient.addColorStop(1, 'rgba(16, 23, 34, 1)')
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace

  const fog = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 160),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  fog.name = 'circular-map-edge-fog'
  fog.position.set(centerX, centerY, 0.09)
  fog.renderOrder = 8
  return fog
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

function makeTrail(agent: SceneData['agents'][number], step: number) {
  const states = agent.states
    .slice(Math.max(0, step - 18), step + 1)
    .filter((state): state is [number, number, number] => Boolean(state))
  if (states.length < 2) return null

  const geometry = new THREE.BufferGeometry().setFromPoints(states.map(([x, y]) => new THREE.Vector3(x, y, 0.22)))
  const material = new THREE.LineBasicMaterial({
    color: agent.is_sdc ? 0xffffff : 0x7cd3ff,
    transparent: true,
    opacity: agent.is_sdc ? 0.58 : 0.26,
  })
  return new THREE.Line(geometry, material)
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
  material.dispose()
}

export default App
