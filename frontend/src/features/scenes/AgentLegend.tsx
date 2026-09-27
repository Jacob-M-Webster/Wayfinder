import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Bike, Box, CarFront, ChevronsLeft, ChevronsRight, Crosshair, Footprints } from 'lucide'
import { Icon } from '../../components/Icon'

const agentLegend = [
  { label: 'Waymo', color: '#ffffff', icon: Crosshair },
  { label: 'Vehicle', color: '#58c7f7', icon: CarFront },
  { label: 'Pedestrian', color: '#f8b86a', icon: Footprints },
  { label: 'Cyclist', color: '#c37df4', icon: Bike },
  { label: 'Other', color: '#cfd6e3', icon: Box },
]

export function AgentLegend() {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className={`agent-legend ${collapsed ? 'is-closed' : 'is-open'}`}>
      <section className="legend-panel" aria-label="Agent color legend">
        {agentLegend.map((item) => (
          <div className="legend-item" key={item.label}>
            <span className="legend-swatch" style={{ '--legend-color': item.color } as CSSProperties}>
              <Icon icon={item.icon} />
            </span>
            <span className="legend-label">{item.label}</span>
          </div>
        ))}
      </section>
      <button
        type="button"
        className="legend-toggle"
        aria-label={collapsed ? 'Expand agent legend' : 'Collapse agent legend'}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand legend' : 'Collapse legend'}
        onClick={() => setCollapsed((value) => !value)}
      >
        <Icon icon={collapsed ? ChevronsRight : ChevronsLeft} />
      </button>
    </div>
  )
}
