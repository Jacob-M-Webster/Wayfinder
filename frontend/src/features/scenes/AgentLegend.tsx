import type { CSSProperties } from 'react'
import { Bike, Box, CarFront, Crosshair, Footprints } from 'lucide'
import { Icon } from '../../components/Icon'

const agentLegend = [
  { label: 'SDC', color: '#ffffff', icon: Crosshair },
  { label: 'Vehicle', color: '#58c7f7', icon: CarFront },
  { label: 'Pedestrian', color: '#f8b86a', icon: Footprints },
  { label: 'Cyclist', color: '#c37df4', icon: Bike },
  { label: 'Other', color: '#cfd6e3', icon: Box },
]

export function AgentLegend() {
  return (
    <section className="agent-legend" aria-label="Agent color legend">
      {agentLegend.map((item) => (
        <div className="legend-item" key={item.label}>
          <span className="legend-swatch" style={{ '--legend-color': item.color } as CSSProperties}>
            <Icon icon={item.icon} />
          </span>
          <span>{item.label}</span>
        </div>
      ))}
    </section>
  )
}
