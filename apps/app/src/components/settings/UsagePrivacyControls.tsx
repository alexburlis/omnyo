import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@omnyo/shared-ui/button";
import { Switch } from "@omnyo/shared-ui/switch";
import { SettingsWithControl } from "@/components/ui/settings-section";
import { sdk } from "@/lib/sdk";
import {
  readClientUsageConsent,
  saveClientUsageConsent,
} from "@/lib/usage-consent";
import type { UsageConsentRequest } from "@omnyo/domain/usage-telemetry";

const key = ["system", "usage"];

export function useUsagePrivacy() {
  const client = useQueryClient();

  const query = useQuery({
    queryKey: key,
    queryFn: () => sdk.system.experimental_usageStatus(),
    staleTime: 0,
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(
    purpose: UsageConsentRequest["purpose"],
    enabled: boolean,
  ) {
    setBusy(true);
    setError(null);
    const stored = readClientUsageConsent();

    try {
      if (purpose === "product" && !enabled)
        saveClientUsageConsent({ ...stored, active: null });

      const result = await sdk.system.experimental_usageConsent({
        purpose,
        choice: enabled ? "granted" : "declined",
        source: "settings",
        ...(stored.active ? { proof: stored.active } : {}),
      });

      if (result.proof) {
        try {
          saveClientUsageConsent({
            active: result.proof,
            proofs: [...new Set([...stored.proofs, result.proof])].slice(-64),
          });
        } catch {
          await sdk.system.experimental_usageConsent({
            purpose: "product",
            choice: "declined",
            source: "settings",
            proof: result.proof,
          });
          throw new Error(
            "Consent could not be saved in this browser. Product analytics remains off.",
          );
        }
      }

      client.setQueryData(key, result.status);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The privacy choice could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function erase() {
    setBusy(true);
    setError(null);
    const stored = readClientUsageConsent();
    saveClientUsageConsent({ ...stored, active: null });

    try {
      let pending = false;

      for (const proof of stored.proofs) {
        const status = await sdk.system.experimental_eraseUsageAnalytics(proof);

        if (status.product.erasure === "pending") pending = true;
      }

      if (pending)
        throw new Error(
          "Erasure is pending. The saved proof remains available here so you can retry.",
        );
      saveClientUsageConsent({ active: null, proofs: [] });
      await client.invalidateQueries({ queryKey: key });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Erasure is pending. Retry here when the collector is available.",
      );
    } finally {
      setBusy(false);
    }
  }

  return { ...query, busy, error, choose, erase };
}

export function UsagePrivacyControls({ disabled }: { disabled: boolean }) {
  const usage = useUsagePrivacy();
  const [preview, setPreview] = useState<string | null>(null);

  if (!usage.data)
    return (
      <p role="status">
        {usage.isError
          ? "Privacy settings could not be loaded."
          : "Loading privacy settings…"}
      </p>
    );

  return (
    <>
      <SettingsWithControl
        label="Weekly activity count"
        description={`Count this coordinator once in a week when someone starts a chat or sends a message. No identifier or message content is sent. Current state: ${usage.data.count.reason}. HTTPS connection metadata remains visible in transit.`}
      >
        <Switch
          aria-label="Weekly activity count"
          checked={usage.data.count.effective}
          disabled={disabled || usage.busy}
          onCheckedChange={(value) => void usage.choose("count", value)}
        />
      </SettingsWithControl>
      <SettingsWithControl
        label="Product analytics for this client"
        description={`Share daily, bounded setup progress, feature use and operation outcomes under a random subject. Other clients must consent separately. Raw records expire after 30 days. Current state: ${usage.data.product.reason}.`}
      >
        <Switch
          aria-label="Product analytics for this client"
          checked={usage.data.product.effective}
          disabled={disabled || usage.busy}
          onCheckedChange={(value) => void usage.choose("product", value)}
        />
      </SettingsWithControl>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={usage.busy || readClientUsageConsent().proofs.length === 0}
          onClick={() => void usage.erase()}
        >
          Erase this client’s analytics
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            void sdk.system
              .experimental_usagePreview()
              .then((value) => setPreview(JSON.stringify(value, null, 2)))
          }
        >
          Preview reported fields
        </Button>
      </div>
      {preview ? (
        <p>These synthetic examples send nothing to the collector.</p>
      ) : null}
      {preview ? (
        <pre className="overflow-auto whitespace-pre-wrap text-xs">
          {preview}
        </pre>
      ) : null}
      {usage.error ? <p role="alert">{usage.error}</p> : null}
    </>
  );
}

export function UsageCountNotice() {
  const usage = useUsagePrivacy();

  if (!usage.data?.count.noticeRequired) return null;

  return (
    <aside
      aria-label="Weekly activity count notice"
      className="border-b p-3 text-sm"
    >
      <p>
        Burlis Management GmbH uses a weekly count to understand use of Omnyo.
        This coordinator can send one identifier-free report after a chat or
        message each week. Your configured US region allows this by default
        after this notice. Product analytics stays off until you choose it in
        Settings. You can turn the count off at any time in Settings → General.
      </p>
      <div className="mt-2 flex gap-2">
        <Button
          variant="outline"
          disabled={usage.busy}
          onClick={() => void usage.choose("count", false)}
        >
          Turn off
        </Button>
        <Button
          variant="outline"
          disabled={usage.busy}
          onClick={() => void usage.choose("notice", true)}
        >
          Continue
        </Button>
      </div>
      {usage.error ? <p role="alert">{usage.error}</p> : null}
    </aside>
  );
}
