import type { StageInfo } from './stages'

type StagePanelProps = {
  stage: StageInfo
}

export function StagePanel({ stage }: StagePanelProps) {
  return (
    <section className={`stage-panel stage-${stage.index}`} aria-label="Demo stage" aria-live="polite">
      <div className="stage-heading">
        <span className="stage-index">{stage.index}</span>
        <span>
          <strong>{stage.name}</strong>
          <small>{stage.detail}</small>
        </span>
      </div>
    </section>
  )
}
