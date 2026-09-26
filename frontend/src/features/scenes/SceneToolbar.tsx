import { ChevronDown, ChevronUp, FileJson, FolderOpen, Lock, Unlock } from 'lucide'
import { Icon } from '../../components/Icon'
import type { DemoScene } from './demoScenes'

type SceneToolbarProps = {
  activeSceneKey: string | null
  cameraLocked: boolean
  demoScenes: DemoScene[]
  sceneLoaded: boolean
  topControlsOpen: boolean
  zoom: number
  onChangeScene: (scene: DemoScene) => void
  onCameraLockChange: (locked: boolean) => void
  onOpenLoadDialog: () => void
  onRecenter: () => void
  onToggleTopControls: () => void
  onZoomChange: (zoom: number) => void
}

export function SceneToolbar({
  activeSceneKey,
  cameraLocked,
  demoScenes,
  sceneLoaded,
  topControlsOpen,
  zoom,
  onChangeScene,
  onCameraLockChange,
  onOpenLoadDialog,
  onRecenter,
  onToggleTopControls,
  onZoomChange,
}: SceneToolbarProps) {
  const activeScene = demoScenes.find((scene) => scene.key === activeSceneKey)
  const scenePickerLabel = activeScene ? `${activeScene.label} - ${activeScene.title}` : 'Custom scene'

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
          <span className="scene-picker-value">{scenePickerLabel}</span>
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
        <div className="camera-actions">
          <button type="button" onClick={onRecenter} disabled={!sceneLoaded}>
            Recenter
          </button>
          <button
            type="button"
            className="camera-lock-toggle"
            onClick={() => onCameraLockChange(!cameraLocked)}
            disabled={!sceneLoaded}
            aria-pressed={cameraLocked}
            aria-label={cameraLocked ? 'Turn camera lock off' : 'Turn camera lock on'}
            title={cameraLocked ? 'Camera follows the central Waymo car' : 'Camera remains free'}
          >
            <Icon icon={cameraLocked ? Lock : Unlock} />
            <span>Camera</span>
            <span className="camera-lock-state">{cameraLocked ? 'On' : 'Off'}</span>
          </button>
        </div>
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
