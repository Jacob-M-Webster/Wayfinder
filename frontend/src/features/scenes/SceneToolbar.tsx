import { ChevronDown, ChevronUp, FileJson, FolderOpen } from 'lucide'
import { Icon } from '../../components/Icon'
import type { DemoScene } from './demoScenes'

type SceneToolbarProps = {
  activeSceneKey: string | null
  demoScenes: DemoScene[]
  sceneLoaded: boolean
  topControlsOpen: boolean
  zoom: number
  onChangeScene: (scene: DemoScene) => void
  onOpenLoadDialog: () => void
  onRecenter: () => void
  onToggleTopControls: () => void
  onZoomChange: (zoom: number) => void
}

export function SceneToolbar({
  activeSceneKey,
  demoScenes,
  sceneLoaded,
  topControlsOpen,
  zoom,
  onChangeScene,
  onOpenLoadDialog,
  onRecenter,
  onToggleTopControls,
  onZoomChange,
}: SceneToolbarProps) {
  return (
    <>
      <button
        type="button"
        className="top-controls-toggle"
        aria-label={topControlsOpen ? 'Collapse scene controls' : 'Expand scene controls'}
        aria-expanded={topControlsOpen}
        onClick={onToggleTopControls}
      >
        <span>Scene controls</span>
        <Icon icon={topControlsOpen ? ChevronUp : ChevronDown} />
      </button>
      <div className="scene-toolbar" aria-label="Scene controls">
        <label className="scene-picker">
          <Icon icon={FileJson} />
          <select
            value={activeSceneKey ?? ''}
            onChange={(event) => {
              const scene = demoScenes.find((item) => item.key === event.target.value)
              if (scene) onChangeScene(scene)
            }}
            disabled={!sceneLoaded}
            aria-label="Preloaded scenes"
          >
            {!activeSceneKey && <option value="">Custom scene</option>}
            {demoScenes.map((scene) => (
              <option key={scene.key} value={scene.key}>
                {scene.label} - {scene.title}
              </option>
            ))}
          </select>
          <Icon icon={ChevronDown} className="select-chevron" />
        </label>
        <button type="button" onClick={onOpenLoadDialog}>
          <Icon icon={FolderOpen} />
          Load JSON
        </button>
        <button type="button" onClick={onRecenter} disabled={!sceneLoaded}>
          Recenter
        </button>
        <label className="zoom-control">
          <span>Zoom</span>
          <input
            type="range"
            min="0.5"
            max="2.5"
            step="0.05"
            value={zoom}
            onChange={(event) => onZoomChange(Number(event.target.value))}
            disabled={!sceneLoaded}
          />
        </label>
      </div>
    </>
  )
}
