export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

export function pointDistance(a: [number, number], b: [number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

export function angleDelta(a: number, b: number) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b))
}

export function circularMean(angles: number[]) {
  const sum = angles.reduce(
    (total, angle) => {
      total.x += Math.cos(angle)
      total.y += Math.sin(angle)
      return total
    },
    { x: 0, y: 0 },
  )
  return Math.atan2(sum.y, sum.x)
}
