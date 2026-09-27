import { useEffect, useState } from 'react'
import logoUrl from '../../assets/logo.png'

export type HardwareScene = 'SCENE_1' | 'SCENE_2'

// Shown while no scene is loaded: plain navy with the logo. Scenes are started from the
// hotkeys (and later the hardware); 0 returns here.
export function LandingScreen({ onSceneReceived }: {
  onSceneReceived: (scene: HardwareScene) => void
}) {
  const [hardwareConnected, setHardwareConnected] = useState(false)

  useEffect(() => {
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined
    let disposed = false

    const connect = () => {
      if (disposed) return

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${window.location.hostname}:8765`)
      socket.addEventListener('open', () => setHardwareConnected(true))
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: unknown; scene?: unknown }
          if (message.type === 'scene' && (message.scene === 'SCENE_1' || message.scene === 'SCENE_2')) {
            onSceneReceived(message.scene)
          }
        } catch {
          console.warn('Ignored an invalid hardware WebSocket message')
        }
      })
      socket.addEventListener('close', () => {
        setHardwareConnected(false)
        if (!disposed) reconnectTimer = window.setTimeout(connect, 2000)
      })
      socket.addEventListener('error', () => socket?.close())
    }

    connect()
    return () => {
      disposed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [onSceneReceived])

  return (
    <div className="landing-screen">
      <img src={logoUrl} alt="Wayfinder" />
      <div className="landing-directions" aria-label="Demo entry instructions">
        <p>Press a number key to enter a demo scene.</p>
        <div className="landing-demo-keys">
          <span><kbd>1</kbd> Normal</span>
          <span><kbd>2</kbd> Beacon</span>
          <span><kbd>3</kbd> Model</span>
          <span><kbd>4</kbd> Fallback</span>
        </div>
        <p className="hardware-status" role="status">
          {hardwareConnected ? 'Hardware bridge connected' : 'Waiting for hardware bridge'}
        </p>
      </div>
    </div>
  )
}
