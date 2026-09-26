import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { SceneData } from '../types/scene'

export type ThreeRefs = {
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
  followTarget: THREE.Vector3 | null
  clock: { step: number; stepAt: number; stepMs: number; playing: boolean }
  lastFrame: number
  frameId: number
}

export type AgentRender = {
  agent: SceneData['agents'][number]
  box: THREE.Mesh
  outline: THREE.LineSegments
  headingIcon: THREE.Mesh
  trail: THREE.Line
}

export type SignalRender = {
  laneId: number
  group: THREE.Group
  flashMaterial: THREE.MeshStandardMaterial
  state: string
}

export type DynamicSceneState = {
  agents: AgentRender[]
  sdc: AgentRender | null
  signals: SignalRender[]
  signalMaterials: THREE.MeshStandardMaterial[]
}
