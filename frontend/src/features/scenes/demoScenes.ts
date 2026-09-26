import scene55Url from '../../../../demo_data/scene_55.json?url'
import scene20s19Url from '../../../../demo_data/scene_20s_19.json?url'
import scene20s2Url from '../../../../demo_data/scene_20s_2.json?url'

export type StageScript = {
  gridDownAt: number
  beaconLostAt: number
}

export type DemoScene = {
  key: string
  hotkey: string
  label: string
  title: string
  fileName: string
  url: string
  script: StageScript
}

export const demoScenes: DemoScene[] = [
  {
    key: 'B',
    hotkey: '2',
    label: 'Scene B',
    title: 'Beacon guidance',
    fileName: 'scene_20s_2.json',
    url: scene20s2Url,
    script: { gridDownAt: 0, beaconLostAt: Infinity },
  },
  {
    key: 'C',
    hotkey: '3',
    label: 'Scene C',
    title: 'Model inference',
    fileName: 'scene_20s_19.json',
    url: scene20s19Url,
    script: { gridDownAt: 0, beaconLostAt: 0 },
  },
  {
    key: 'D',
    hotkey: '4',
    label: 'Scene D',
    title: 'Safe fallback',
    fileName: 'scene_55.json',
    url: scene55Url,
    script: { gridDownAt: 0, beaconLostAt: 0 },
  },
]
