"use client"

// Optional starter for a new product with exactly one measurement purpose. Import consent.css once.
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { ConsentBanner, type ConsentBannerProps } from "./ConsentBanner"
import {
  announceConsentChange,
  watchConsentWithdrawal,
} from "./consent-withdrawal"
import { readPurposeConsent, writePurposeConsent } from "./purpose-consent"

const subscribe = () => () => {}

export function SinglePurposeConsent({
  cookieName,
  maxAgeSeconds,
  description,
  privacyUrl,
  classes,
  children,
}: {
  cookieName: string
  maxAgeSeconds: number
  description: string
  privacyUrl: string
  classes?: ConsentBannerProps["classes"]
  children: ReactNode
}) {
  const choice = useSyncExternalStore(
    subscribe,
    () => readPurposeConsent(cookieName, maxAgeSeconds),
    () => undefined,
  )

  const [settingsOpen, setSettingsOpen] = useState(false)
  const open = choice === null || settingsOpen
  const [error, setError] = useState(false)
  useEffect(() => {
    if (choice !== "accepted") return

    return watchConsentWithdrawal({
      channelName: cookieName,
      isAccepted: () =>
        readPurposeConsent(cookieName, maxAgeSeconds) === "accepted",
      onWithdraw: () => window.location.reload(),
    })
  }, [choice, cookieName, maxAgeSeconds])

  if (choice === undefined) return null

  return (
    <>
      {choice === "accepted" && children}
      <ConsentBanner
        choice={choice}
        open={open}
        onOpenChange={setSettingsOpen}
        onChoose={(value) => {
          try {
            writePurposeConsent(cookieName, value === "accepted", maxAgeSeconds)
            announceConsentChange(cookieName)
            window.location.reload()
          } catch {
            setError(true)
            setSettingsOpen(true)
          }
        }}
        labels={{
          region: "Privacy choices",
          settings: "Privacy settings",
          accept: "Accept",
          reject: "Reject",
          close: "Close privacy settings",
        }}
        description={description}
        links={<a href={privacyUrl}>Privacy</a>}
        classes={classes}
        error={
          error
            ? "Your choice could not be saved. Allow browser storage and try again."
            : undefined
        }
      />
    </>
  )
}
