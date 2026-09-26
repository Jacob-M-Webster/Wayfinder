export const maxPolarAngle = (82 * Math.PI) / 180
export const minPolarAngle = (10 * Math.PI) / 180
export const sceneBackground = 0x101722
export const initialFocusZoom = 0.65

export const agentColors: Record<string, number> = {
  vehicle: 0x58c7f7,
  pedestrian: 0xf8b86a,
  cyclist: 0xc37df4,
  other: 0xcfd6e3,
}

export const signalColors: Record<string, number> = {
  STOP: 0xf25555,
  CAUTION: 0xf7c948,
  GO: 0x43d17a,
  UNKNOWN: 0x8a94a8,
  NONE: 0x3b4252,
  DARK: 0x232a35,
}
