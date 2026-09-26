import type { OverlaySceneData } from '../signal_overlay'

export type Point = [number, number]
export type AgentState = [number, number, number] | null

export type Lane = {
  id: number
  points: Point[]
  controlled: boolean
}

export type SceneData = {
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
  ego_lane?: number | null
  ego_approach?: string | null
  model?: OverlaySceneData['model']
}

export type Bounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}
