import scene55Url from '../../../../demo_data/scene_55.json?url'
import scene20s19Url from '../../../../demo_data/scene_20s_19.json?url'
import scene20s2Url from '../../../../demo_data/scene_20s_2.json?url'
import scene20s8_9Url from '../../../../demo_data/scene_20s_8_9.json?url'

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
  // Show the signal overlay (what the car believes). Off for the plain "Normal" scene.
  overlay: boolean
}

export const demoScenes: DemoScene[] = [
  {
    key: 'A',
    hotkey: '1',
    label: 'Scene A',
    title: 'Normal',
    fileName: 'scene_20s_8_9.json',
    url: scene20s8_9Url,
    script: { gridDownAt: Infinity, beaconLostAt: Infinity },
    overlay: false,
  },
  {
    key: 'B',
    hotkey: '2',
    label: 'Scene B',
    title: 'Beacon guidance',
    fileName: 'scene_20s_2.json',
    url: scene20s2Url,
    script: { gridDownAt: 0, beaconLostAt: Infinity },
    overlay: true,
  },
  {
    key: 'C',
    hotkey: '3',
    label: 'Scene C',
    title: 'Model inference',
    fileName: 'scene_20s_19.json',
    url: scene20s19Url,
    script: { gridDownAt: 0, beaconLostAt: 0 },
    overlay: true,
  },
  {
    key: 'D',
    hotkey: '4',
    label: 'Scene D',
    title: 'Safe fallback',
    fileName: 'scene_55.json',
    url: scene55Url,
    script: { gridDownAt: 0, beaconLostAt: 0 },
    overlay: true,
  },
]
