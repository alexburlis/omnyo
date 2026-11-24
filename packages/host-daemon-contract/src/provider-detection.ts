import { z } from "zod";

export const acpDetectionAgentSchema = z
  .object({
    id: z.string().regex(/^acp-[a-z0-9][a-z0-9-]*$/u),
    displayName: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
  })
  .strict();

export const onboardingProviderExecutables = [
  { id: "claude-code", displayName: "Claude Code", command: "claude" },
  { id: "codex", displayName: "Codex", command: "codex" },
  { id: "acp-cursor", displayName: "Cursor", command: "cursor-agent" },
  { id: "acp-opencode", displayName: "OpenCode", command: "opencode" },
  { id: "acp-omp", displayName: "oh-my-pi", command: "omp" },
  { id: "acp-grok", displayName: "Grok", command: "grok" },
  { id: "acp-hermes-agent", displayName: "Hermes", command: "hermes" },
] as const;

export const providerCliDetectionResponseSchema = z
  .object({
    providers: z.array(
      z
        .object({
          id: z.string().min(1),
          displayName: z.string().min(1),
          installed: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
