export type StageFlags = {
  gridUp: boolean
  beaconAlive: boolean
}

export type StageInfo = {
  index: number
  name: string
  detail: string
}

export function getStageInfo(gridUp: boolean, beaconAlive: boolean, egoSource: string | undefined): StageInfo {
  if (gridUp) return { index: 1, name: 'Normal', detail: 'Signals powered' }
  if (beaconAlive) return { index: 2, name: 'Grid down', detail: 'Signals not powered, beacon transmitting' }
  if (egoSource === 'MODEL') return { index: 3, name: 'Beacon lost', detail: 'Model reading traffic' }
  return { index: 4, name: 'Safe fallback', detail: 'All-way stop' }
}
