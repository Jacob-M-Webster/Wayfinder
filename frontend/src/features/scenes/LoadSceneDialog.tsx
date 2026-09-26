import type { ChangeEvent } from 'react'
import { FileJson, Upload, X } from 'lucide'
import { Icon } from '../../components/Icon'
import type { DemoScene } from './demoScenes'

type LoadSceneDialogProps = {
  demoScenes: DemoScene[]
  onClose: () => void
  onDemoScene: (scene: DemoScene) => void
  onFile: (event: ChangeEvent<HTMLInputElement>) => void
}

export function LoadSceneDialog({ demoScenes, onClose, onDemoScene, onFile }: LoadSceneDialogProps) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="load-dialog" role="dialog" aria-modal="true" aria-labelledby="load-dialog-title">
        <header className="load-dialog-header">
          <h2 id="load-dialog-title">Load JSON</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon icon={X} />
          </button>
        </header>

        <div className="load-dialog-grid">
          <section className="load-panel" aria-labelledby="demo-data-title">
            <h3 id="demo-data-title">Demo data</h3>
            <div className="demo-scene-list">
              {demoScenes.map((scene) => (
                <button
                  type="button"
                  className="demo-scene-button"
                  key={scene.fileName}
                  onClick={() => onDemoScene(scene)}
                >
                  <Icon icon={FileJson} />
                  <span>
                    <strong>{scene.label} - {scene.title}</strong>
                    <small>{scene.fileName}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="load-panel upload-panel" aria-labelledby="upload-data-title">
            <h3 id="upload-data-title">Upload your own</h3>
            <label className="upload-dropzone">
              <input type="file" accept=".json,application/json" onChange={onFile} />
              <Icon icon={Upload} />
              <span>Select JSON file</span>
            </label>
          </section>
        </div>
      </section>
    </div>
  )
}
