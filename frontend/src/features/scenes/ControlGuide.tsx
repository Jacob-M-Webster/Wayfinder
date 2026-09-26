import { ChevronLeft, ChevronRight, MouseLeft, MouseRight, ZoomIn } from 'lucide'
import { Icon } from '../../components/Icon'

type ControlGuideProps = {
  open: boolean
  onToggle: () => void
}

export function ControlGuide({ open, onToggle }: ControlGuideProps) {
  return (
    <div className={`guide-shell ${open ? 'is-open' : 'is-closed'}`}>
      <section className="control-guide" aria-label="Application controls" aria-hidden={!open}>
        <div className="guide-row">
          <Icon icon={MouseRight} />
          <span>Right click to Pan</span>
        </div>
        <div className="guide-row">
          <Icon icon={MouseLeft} />
          <span>Left click to Rotate</span>
        </div>
        <div className="guide-row">
          <Icon icon={ZoomIn} />
          <span>Scroll to Zoom</span>
        </div>
      </section>
      <button
        type="button"
        className="guide-toggle"
        aria-label={open ? 'Hide controls guide' : 'Show controls guide'}
        aria-expanded={open}
        onClick={onToggle}
      >
        {!open && <span className="guide-toggle-label">Movement guide</span>}
        <Icon icon={open ? ChevronLeft : ChevronRight} />
      </button>
    </div>
  )
}
