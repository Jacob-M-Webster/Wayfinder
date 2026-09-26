import * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Bounds, Point, SceneData } from '../types/scene'
import { agentColors, sceneBackground, signalColors } from './sceneConstants'
import { angleDelta, circularMean, clamp, pointDistance, smoothstep } from './math'
import type { AgentRender, DynamicSceneState, ThreeRefs } from './sceneTypes'

type EdgeFade = Bounds & {
  fadeDistance: number
}

type SignalBarLayout = {
  stop: Point
  heading: number
}

export function preventMenu(event: MouseEvent) {
  event.preventDefault()
}

export function addLights(scene: THREE.Scene) {
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

export function buildStaticScene(group: THREE.Group, sceneData: SceneData, bounds: Bounds) {
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

export function buildDynamicScene(group: THREE.Group, sceneData: SceneData): DynamicSceneState {
  const agents = sceneData.agents.map((agent) => {
    const height = getAgentHeight(agent.type)
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

  const signalLayouts = getSignalBarLayouts(sceneData.signals)
  const signals = sceneData.signals.map((signal, index) => {
    const layout = signalLayouts[index]
    const signalBar = makeTrafficFloorBar(layout.stop, layout.heading, 'UNKNOWN')
    group.add(signalBar.group)

    return {
      laneId: signal.lane_id,
      state: 'UNKNOWN',
      ...signalBar,
    }
  })

  return {
    agents,
    sdc: agents.find(({ agent }) => agent.is_sdc) ?? null,
    signals,
    signalMaterials: signals.map((signal) => signal.flashMaterial),
  }
}

export function updateDynamicScene(
  state: DynamicSceneState | null,
  sceneData: SceneData,
  step: number,
  showTrails: boolean,
  gridUp = true,
) {
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
    const height = getAgentHeight(agent.type)
    box.position.set(x, y, height / 2)
    box.rotation.z = heading
    box.visible = true

    headingIcon.position.set(x, y, height + 0.1)
    headingIcon.rotation.z = heading
    headingIcon.visible = true

    updateTrail(trail, agent, step, showTrails)
  })

  state.signals.forEach((signal) => {
    const signalState = gridUp ? truth[String(signal.laneId)] ?? 'UNKNOWN' : 'DARK'
    if (signal.state === signalState) return

    signal.state = signalState
    setSignalMaterialState(signal.flashMaterial, signalState)
  })
}

export function setHoveredAgent(refs: ThreeRefs, hoveredBox: THREE.Mesh | null) {
  const next = hoveredBox
    ? refs.dynamicState?.agents.find(({ box, agent }) => box === hoveredBox && agent.type === 'vehicle' && !agent.is_sdc) ?? null
    : null

  if (refs.hoveredAgent === next) return
  if (refs.hoveredAgent) refs.hoveredAgent.outline.visible = false
  refs.hoveredAgent = next
  if (refs.hoveredAgent) refs.hoveredAgent.outline.visible = true
}

export function clearHoveredAgent(refs: ThreeRefs | null) {
  if (!refs) return
  if (refs.hoveredAgent) refs.hoveredAgent.outline.visible = false
  refs.hoveredAgent = null
}

export function updateHoverDot(
  dot: HTMLDivElement | null,
  stage: HTMLDivElement,
  camera: THREE.PerspectiveCamera,
  hoveredAgent: AgentRender | null,
) {
  if (!dot || !hoveredAgent || !hoveredAgent.box.visible) {
    hideHoverDot(dot)
    return
  }

  const height = getAgentHeight(hoveredAgent.agent.type)
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

export function hideHoverDot(dot: HTMLDivElement | null) {
  if (dot) dot.style.opacity = '0'
}

export function fitCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, bounds: Bounds) {
  const center = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, 0)
  const spanX = bounds.maxX - bounds.minX
  const spanY = bounds.maxY - bounds.minY
  const radius = Math.max(spanX, spanY) * 0.64
  const distance = Math.max(60, radius / Math.sin((camera.fov * Math.PI) / 360))

  camera.position.set(center.x - distance * 0.58, center.y - distance * 0.72, distance * 0.62)
  controls.target.copy(center)
  controls.update()
}

export function interpolateAgents(state: DynamicSceneState, step: number, frac: number) {
  state.agents.forEach(({ agent, box, headingIcon }) => {
    const a = agent.states[step]
    if (!a || !box.visible) return
    const b = frac > 0 ? agent.states[step + 1] : null
    const [x, y, heading] = b
      ? [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, a[2] + angleDelta(b[2], a[2]) * frac]
      : a
    box.position.x = x
    box.position.y = y
    box.rotation.z = heading
    headingIcon.position.x = x
    headingIcon.position.y = y
    headingIcon.rotation.z = heading
  })
}

export function followCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, target: THREE.Vector3 | null, dt: number) {
  if (!target || dt <= 0) return
  const delta = target.clone().sub(controls.target)
  if (delta.lengthSq() < 1e-6) return
  delta.multiplyScalar(1 - Math.exp(-dt * 6))
  controls.target.add(delta)
  camera.position.add(delta)
}

export function focusSdcCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, sceneData: SceneData, step: number) {
  const sdc = sceneData.agents.find((agent) => agent.is_sdc)
  const state = sdc?.states[step] ?? sdc?.states.find((agentState): agentState is [number, number, number] => Boolean(agentState))
  if (!state) return false

  const [x, y, heading] = state
  const center = new THREE.Vector3(x, y, 0)
  const distance = 34
  camera.position.set(
    x - Math.cos(heading) * distance * 0.84,
    y - Math.sin(heading) * distance * 0.84,
    distance * 0.54,
  )
  controls.target.copy(center)
  controls.update()
  return true
}

export function applyCameraZoom(camera: THREE.PerspectiveCamera, zoom: number) {
  camera.zoom = zoom
  camera.updateProjectionMatrix()
}

export function updateSignalFlashes(materials: THREE.MeshStandardMaterial[], now: number) {
  const pulse = 0.42 + 0.58 * ((Math.sin(now * 0.008) + 1) / 2)

  materials.forEach((material) => {
    const baseColor = material.userData.baseColor as THREE.Color | undefined
    if (!baseColor) return

    material.color.copy(baseColor).multiplyScalar(pulse)
    material.emissive.copy(baseColor)
    material.emissiveIntensity = 0.35 + pulse * 1.15
    material.opacity = 0.52 + pulse * 0.42
  })
}

export function getBounds(sceneData: SceneData) {
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

export function clearGroup(group: THREE.Group) {
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

function getAgentHeight(type: string) {
  return type === 'pedestrian' ? 1.65 : type === 'cyclist' ? 1.35 : 1.55
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

function getSignalBarLayouts(signals: SceneData['signals']): SignalBarLayout[] {
  const layouts = signals.map((signal) => ({ stop: signal.stop, heading: signal.heading }))
  const clusters: number[][] = []
  const visited = new Set<number>()

  signals.forEach((signal, index) => {
    if (visited.has(index)) return

    const cluster = [index]
    visited.add(index)

    for (let candidateIndex = index + 1; candidateIndex < signals.length; candidateIndex += 1) {
      const candidate = signals[candidateIndex]
      if (visited.has(candidateIndex)) continue
      if (Math.abs(angleDelta(signal.heading, candidate.heading)) > 0.16) continue
      if (pointDistance(signal.stop, candidate.stop) > 6.4) continue

      cluster.push(candidateIndex)
      visited.add(candidateIndex)
    }

    clusters.push(cluster)
  })

  clusters.forEach((cluster) => {
    if (cluster.length < 2) return

    const heading = circularMean(cluster.map((index) => signals[index].heading))
    const forward = new THREE.Vector2(Math.cos(heading), Math.sin(heading))
    const side = new THREE.Vector2(-forward.y, forward.x)
    const center = cluster.reduce(
      (sum, index) => sum.add(new THREE.Vector2(signals[index].stop[0], signals[index].stop[1])),
      new THREE.Vector2(),
    ).multiplyScalar(1 / cluster.length)

    const sorted = [...cluster].sort((a, b) => {
      const pointA = new THREE.Vector2(signals[a].stop[0], signals[a].stop[1]).sub(center)
      const pointB = new THREE.Vector2(signals[b].stop[0], signals[b].stop[1]).sub(center)
      return pointA.dot(side) - pointB.dot(side)
    })
    const spacing = 0.84

    sorted.forEach((signalIndex, order) => {
      const original = signals[signalIndex].stop
      const offset = (order - (sorted.length - 1) / 2) * spacing
      const shifted = new THREE.Vector2(original[0], original[1]).addScaledVector(side, offset)
      layouts[signalIndex] = { stop: [shifted.x, shifted.y], heading }
    })
  })

  return layouts
}

function makeTrafficFloorBar(stop: Point, heading: number, state: string) {
  const group = new THREE.Group()
  const activeColor = signalColors[state] ?? signalColors.UNKNOWN
  const baseMaterial = new THREE.MeshStandardMaterial({
    color: 0x161e2b,
    roughness: 0.7,
    metalness: 0.08,
    depthWrite: false,
  })

  const base = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.78, 0.075), baseMaterial)
  base.position.z = 0.048
  base.renderOrder = 28
  group.add(base)

  const flashMaterial = new THREE.MeshStandardMaterial({
    color: activeColor,
    emissive: activeColor,
    emissiveIntensity: 0.55,
    roughness: 0.38,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  })
  flashMaterial.userData.baseColor = new THREE.Color(activeColor)

  const flash = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.42, 0.09), flashMaterial)
  flash.position.z = 0.11
  flash.renderOrder = 29
  group.add(flash)

  group.position.set(stop[0], stop[1], 0)
  group.rotation.z = heading + Math.PI / 2
  return { group, flashMaterial }
}

function setSignalMaterialState(material: THREE.MeshStandardMaterial, state: string) {
  const activeColor = signalColors[state] ?? signalColors.UNKNOWN
  const color = new THREE.Color(activeColor)
  material.userData.baseColor = color
  material.color.copy(color)
  material.emissive.copy(color)
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

function disposeMaterial(material: THREE.Material) {
  if ('map' in material && material.map instanceof THREE.Texture) {
    material.map.dispose()
  }
  if ('alphaMap' in material && material.alphaMap instanceof THREE.Texture) {
    material.alphaMap.dispose()
  }
  material.dispose()
}
