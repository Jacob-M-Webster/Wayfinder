import logoUrl from '../../assets/logo.png'

// Shown while no scene is loaded: plain navy with the logo. Scenes are started from the
// hotkeys (and later the hardware); 0 returns here.
export function LandingScreen() {
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
      </div>
    </div>
  )
}
