import logoUrl from '../../assets/logo.png'

// Shown while no scene is loaded: plain navy with the logo. Scenes are started from the
// hotkeys (and later the hardware); 0 returns here.
export function LandingScreen() {
  return (
    <div className="landing-screen">
      <img src={logoUrl} alt="Wayfinder" />
    </div>
  )
}
