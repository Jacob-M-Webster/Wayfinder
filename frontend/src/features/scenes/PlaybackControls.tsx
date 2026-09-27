import { Gauge, Pause, Play, Repeat } from 'lucide'
import type { CSSProperties } from 'react'
import { Icon } from '../../components/Icon'

type PlaybackControlsProps = {
  sceneLoaded: boolean
  step: number
  maxStep: number
  playing: boolean
  loopPlayback: boolean
  playbackSpeed: number
  speedPopoverOpen: boolean
  timeLabel: string
  totalTime: string
  frameLabel: string
  timelineGradient?: string
  currentTimelineState: 'stop' | 'go' | null
  onPlayPause: () => void
  onStepChange: (step: number) => void
  onLoopChange: (loop: boolean) => void
  onSpeedChange: (speed: number) => void
  onSpeedPopoverChange: (open: boolean) => void
}

export function PlaybackControls({
  sceneLoaded,
  step,
  maxStep,
  playing,
  loopPlayback,
  playbackSpeed,
  speedPopoverOpen,
  timeLabel,
  totalTime,
  frameLabel,
  timelineGradient,
  currentTimelineState,
  onPlayPause,
  onStepChange,
  onLoopChange,
  onSpeedChange,
  onSpeedPopoverChange,
}: PlaybackControlsProps) {
  return (
    <div className="controls" aria-label="Playback controls">
      <button
        type="button"
        className="icon-control play-button"
        onClick={onPlayPause}
        disabled={!sceneLoaded}
        aria-label={playing ? 'Pause timeline' : 'Play timeline'}
        title={playing ? 'Pause' : 'Play'}
      >
        <Icon icon={playing ? Pause : Play} />
      </button>
      <span className="time-readout">{timeLabel}</span>
      <div className="timeline-visualizer">
        <input
          className="timeline-range"
          type="range"
          min="0"
          max={maxStep}
          value={step}
          style={{ '--timeline-gradient': timelineGradient } as CSSProperties}
          aria-label="Playback timeline"
          aria-valuetext={`${frameLabel}, ${currentTimelineState === 'stop' ? 'stopped' : currentTimelineState === 'go' ? 'able to go' : 'state unknown'}`}
          onChange={(event) => onStepChange(Number(event.target.value))}
          disabled={!sceneLoaded}
        />
        <div className="timeline-key" aria-hidden="true">
          <span><i className="timeline-key-stop" />Stopped</span>
          <span><i className="timeline-key-go" />Able to go</span>
        </div>
      </div>
      <span className="frame-readout">{frameLabel}</span>
      <div
        className="speed-menu"
        onBlur={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
            onSpeedPopoverChange(false)
          }
        }}
      >
        <button
          type="button"
          className="speed-trigger"
          onClick={() => onSpeedPopoverChange(!speedPopoverOpen)}
          disabled={!sceneLoaded}
          aria-label={`Playback speed ${playbackSpeed.toFixed(2)}x`}
          aria-expanded={speedPopoverOpen}
        >
          <Icon icon={Gauge} />
          <span>{playbackSpeed.toFixed(2)}x</span>
        </button>
        {speedPopoverOpen && (
          <div className="speed-popover" role="dialog" aria-label="Playback speed">
            <span>Speed</span>
            <input
              type="range"
              min="0.25"
              max="3"
              step="0.25"
              value={playbackSpeed}
              onChange={(event) => onSpeedChange(Number(event.target.value))}
              disabled={!sceneLoaded}
              aria-label="Playback speed"
            />
          </div>
        )}
      </div>
      <button
        type="button"
        className={`icon-control loop-button${loopPlayback ? ' is-active' : ''}`}
        onClick={() => onLoopChange(!loopPlayback)}
        disabled={!sceneLoaded}
        aria-pressed={loopPlayback}
        aria-label={loopPlayback ? 'Disable loop playback' : 'Enable loop playback'}
        title="Loop"
      >
        <Icon icon={Repeat} />
      </button>
      <span className="time-readout end">{totalTime}</span>
    </div>
  )
}
