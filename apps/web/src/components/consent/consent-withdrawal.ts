// Shared source: product-launch/assets/browser-consent. Use install-consent.py.

// One emitter per channel in this document. BroadcastChannel excludes its own
// sender, so a local choice can finish account sync before the host reloads.
const channels = new Map<string, { channel: BroadcastChannel; users: number }>()

function acquireChannel(name: string) {
  if (typeof BroadcastChannel === "undefined") return undefined
  let entry = channels.get(name)

  if (!entry) {
    entry = { channel: new BroadcastChannel(name), users: 0 }
    channels.set(name, entry)
  }

  entry.users += 1

  return entry.channel
}

function releaseChannel(name: string) {
  const entry = channels.get(name)

  if (!entry) return
  entry.users -= 1

  if (entry.users === 0) {
    entry.channel.close()
    channels.delete(name)
  }
}

/** Messages are notifications, never consent. Always re-read product storage. */
export function watchConsentWithdrawal({
  channelName,
  isAccepted,
  onWithdraw,
}: {
  channelName: string
  isAccepted: () => boolean
  onWithdraw: () => void
}): () => void {
  let withdrawn = false

  const check = () => {
    if (withdrawn || isAccepted()) return
    withdrawn = true
    onWithdraw()
  }

  const channel = acquireChannel(channelName)
  channel?.addEventListener("message", check)
  window.addEventListener("focus", check)
  document.addEventListener("visibilitychange", check)

  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") check()
  }, 30_000)

  // Covers a change between rendering accepted state and installing listeners.
  check()

  return () => {
    window.clearInterval(timer)
    channel?.removeEventListener("message", check)
    releaseChannel(channelName)
    window.removeEventListener("focus", check)
    document.removeEventListener("visibilitychange", check)
  }
}

/** Call after persisting the product's choice, before any reload. */
export function announceConsentChange(channelName: string): void {
  const channel = acquireChannel(channelName)
  channel?.postMessage("consent-changed")
  releaseChannel(channelName)
}
