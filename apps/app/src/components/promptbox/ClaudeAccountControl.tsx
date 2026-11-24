import { OptionPicker } from "@/components/pickers/OptionPicker";
import type {
  ClaudeProfileSelection,
  ProfileList,
} from "@/hooks/useClaudeAccounts";

export {
  useClaudeAccounts,
  type ClaudeProfileSelection,
} from "@/hooks/useClaudeAccounts";

export function ClaudeAccountControl({
  data,
  error,
  selection,
  onChange,
  handoff = false,
  disabled = false,
  onSetDefault,
}: {
  data: ProfileList | null;
  error: boolean;
  selection: ClaudeProfileSelection | undefined;
  onChange: (selection: ClaudeProfileSelection) => void;
  handoff?: boolean;
  disabled?: boolean;
  onSetDefault?: (selection: ClaudeProfileSelection) => Promise<void>;
}) {
  if (error) {
    return (
      <span role="status" className="text-xs text-destructive-text">
        Claude accounts unavailable
      </span>
    );
  }

  if (!data?.supported) return null;
  const effective = selection ?? data.defaultSelection;

  const profile =
    effective.kind === "profile"
      ? data.profiles.find((candidate) => candidate.id === effective.profileId)
      : null;

  return (
    <OptionPicker
      label={handoff ? "Continue with Claude account" : "Claude account"}
      value={effective.kind === "profile" ? effective.profileId : "unprofiled"}
      displayOverride={{
        label:
          (profile
            ? `${profile.label}${profile.status === "ready" ? "" : " · Sign in again"}`
            : undefined) ??
          (effective.kind === "profile"
            ? "Saved Claude account"
            : "Ordinary sign-in"),
      }}
      options={[
        {
          value: "unprofiled",
          label: "Ordinary sign-in",
          description: handoff ? "Continue in a new chat" : undefined,
        },
        ...data.profiles.map((candidate) => ({
          value: candidate.id,
          label: candidate.label,
          description:
            candidate.status === "ready"
              ? handoff
                ? "Continue in a new chat"
                : "Ready"
              : candidate.status === "wrong-account"
                ? "Different account signed in"
                : candidate.status === "sign-in-required"
                  ? "Sign in required"
                  : "Unavailable",
          disabled: candidate.status !== "ready",
        })),
        ...(onSetDefault === undefined
          ? []
          : [
              {
                value: "set-project-default",
                label: "Use for new chats in this project",
                disabled:
                  effective.kind === "profile" && profile?.status !== "ready",
              },
            ]),
      ]}
      onChange={(value) => {
        if (value === "set-project-default") {
          void onSetDefault?.(effective);

          return;
        }

        onChange(
          value === "unprofiled"
            ? { kind: "unprofiled" }
            : { kind: "profile", profileId: value },
        );
      }}
      disabled={disabled}
      muted
    />
  );
}
