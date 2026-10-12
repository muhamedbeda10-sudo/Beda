// ============================================================================
// §24 — the chime the open app plays when a notification arrives while it is
// in front (with the app closed, the device plays its own notification
// sound). Two short soft tones made with Web Audio: no file to download, and
// nothing plays until the page has been touched once (the browser's rule).
// On or off per device, on by default.
// ============================================================================

const SOUND_KEY = 'qc-notification-sound'

export function chimeOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setChimeOn(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off')
  } catch {
    /* private mode: the default stays */
  }
}

let audio: AudioContext | null = null

/** Two tones, rising; quiet enough for an office, clear enough on the floor. Never throws. */
export function playChime(): void {
  if (!chimeOn()) return
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    audio ??= new Ctx()
    const ctx = audio
    void ctx.resume().catch(() => {})
    const start = ctx.currentTime + 0.01
    for (const [i, freq] of [880, 1318.5].entries()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t = start + i * 0.16
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.3)
    }
  } catch {
    /* no sound is better than an error */
  }
}
