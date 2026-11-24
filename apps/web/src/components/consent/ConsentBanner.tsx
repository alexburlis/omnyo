"use client"

// Shared source: product-launch/assets/browser-consent. Use install-consent.py.
import { useEffect, useRef, useState, type ReactNode } from "react"

export type ConsentChoice = "accepted" | "rejected"

/** Optional extra classes per part. Layout, sizes, pointer and hover come from consent.css; products theme it with
 * the --consent-* variables there and use these only for product typography or colours the variables do not cover. */
export type ConsentClasses = Partial<
  Record<
    | "panel"
    | "trigger"
    | "header"
    | "title"
    | "status"
    | "close"
    | "description"
    | "links"
    | "actions"
    | "action"
    | "error"
    | "backdrop",
    string
  >
>

export type ConsentPreferences = {
  label: string
  save: string
  purposes: {
    id: string
    label: string
    description: string
    enabled: boolean
  }[]
  disclosure?: ReactNode
  onSave: (values: Record<string, boolean>) => void
}

/** Lucide's cookie (ISC licence), drawn in the trigger's text colour. */
function CookieIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11.496 2c.324-.016.558.292.529.615a4 4 0 0 0 4.235 4.368.713.713 0 0 1 .758.757 4 4 0 0 0 4.366 4.237c.323-.03.63.204.614.527a10 10 0 0 1-2.915 6.566A1 1 0 1 1 4.93 4.918 10 10 0 0 1 11.496 2" />
      <path d="M11 17h.01" />
      <path d="M12 12h.01" />
      <path d="M16 16h.01" />
      <path d="M16 3h.01" />
      <path d="M21 4h.01" />
      <path d="M21 8h.01" />
      <path d="M7 14h.01" />
      <path d="M9 8h.01" />
    </svg>
  )
}

function PurposeSettings({
  preferences,
  classes,
}: {
  preferences: ConsentPreferences
  classes: ConsentClasses
}) {
  const [values, setValues] = useState(() =>
    Object.fromEntries(preferences.purposes.map((p) => [p.id, p.enabled])),
  )

  return (
    <details data-consent-purposes="">
      <summary>{preferences.label}</summary>
      <div data-consent-purposes-body="">
        {preferences.purposes.map((p) => (
          <label key={p.id} data-consent-purpose="">
            <input
              type="checkbox"
              checked={values[p.id] === true}
              onChange={(event) =>
                setValues({ ...values, [p.id]: event.target.checked })
              }
            />
            <span>
              <strong>{p.label}</strong>
              <span>{p.description}</span>
            </span>
          </label>
        ))}
        {preferences.disclosure && (
          <div data-consent-disclosure="">{preferences.disclosure}</div>
        )}
        <button
          type="button"
          data-consent-action=""
          data-consent-save=""
          className={classes.action}
          onClick={() => preferences.onSave(values)}
        >
          {preferences.save}
        </button>
      </div>
    </details>
  )
}

export type ConsentBannerProps = {
  choice: ConsentChoice | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChoose: (choice: ConsentChoice) => void
  labels: {
    region: string
    /** The persistent settings control's name: its tooltip and what screen readers announce. */
    settings: string
    accept: string
    reject: string
    close: string
  }
  preferences?: ConsentPreferences
  description: ReactNode
  links: ReactNode
  title?: ReactNode
  status?: ReactNode
  error?: ReactNode
  classes?: ConsentClasses
  showTriggerWhileOpen?: boolean
}

/** Presentation only. The product owns consent storage, purpose and SDK lifecycle. Import consent.css once. */
export function ConsentBanner({
  choice,
  open,
  onOpenChange,
  onChoose,
  labels,
  preferences,
  description,
  links,
  title,
  status,
  error,
  classes = {},
  showTriggerWhileOpen = false,
}: ConsentBannerProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  // Opening from the settings control hides it, so focus moves into the panel rather than falling back to the page:
  // Escape and Tab then work at once. A panel the product opens by itself (a first visit) leaves focus where it is.
  const focusPanel = useRef(false)
  useEffect(() => {
    if (open && focusPanel.current)
      panel.current?.focus({ preventScroll: true })
    focusPanel.current = false
  }, [open])

  const close = () => {
    onOpenChange(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }

  return (
    <div className="ph-no-capture" data-consent-panel="">
      <button
        ref={trigger}
        type="button"
        data-consent-trigger=""
        hidden={open && !showTriggerWhileOpen}
        onClick={() => {
          focusPanel.current = true
          onOpenChange(true)
        }}
        className={classes.trigger}
        title={labels.settings}
        aria-expanded={open}
      >
        <CookieIcon />
        <span data-consent-label="">{labels.settings}</span>
      </button>
      {open && (
        <>
          {classes.backdrop && (
            <div
              aria-hidden="true"
              data-consent-backdrop=""
              className={classes.backdrop}
            />
          )}
          <section
            ref={panel}
            tabIndex={-1}
            aria-label={labels.region}
            data-consent-dialog=""
            className={classes.panel}
            onKeyDown={(event) => {
              if (event.key === "Escape" && choice !== null) {
                event.preventDefault()
                close()
              }
            }}
          >
            {choice !== null && (
              <button
                type="button"
                data-consent-close=""
                onClick={close}
                className={classes.close}
                aria-label={labels.close}
              >
                <span aria-hidden="true">×</span>
              </button>
            )}
            {(title || status) && (
              <div data-consent-header="" className={classes.header}>
                {title && (
                  <h2 data-consent-title="" className={classes.title}>
                    {title}
                  </h2>
                )}
                {status && (
                  <p data-consent-status="" className={classes.status}>
                    {status}
                  </p>
                )}
              </div>
            )}
            <p data-consent-description="" className={classes.description}>
              {description}
            </p>
            {error && (
              <p role="alert" data-consent-error="" className={classes.error}>
                {error}
              </p>
            )}
            <div data-consent-row="">
              {preferences && (
                <PurposeSettings preferences={preferences} classes={classes} />
              )}
              <div data-consent-links="" className={classes.links}>
                {links}
              </div>
            </div>
            <div data-consent-actions="" className={classes.actions}>
              <button
                type="button"
                data-consent-action=""
                className={classes.action}
                onClick={() => onChoose("rejected")}
              >
                {labels.reject}
              </button>
              <button
                type="button"
                data-consent-action=""
                className={classes.action}
                onClick={() => onChoose("accepted")}
              >
                {labels.accept}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
