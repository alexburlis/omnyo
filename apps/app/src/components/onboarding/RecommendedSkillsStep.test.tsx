// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { RecommendedSkillsStep } from "./RecommendedSkillsStep";
import { onboardingSteps } from "./onboarding-model";

vi.mock("@/lib/sdk", () => ({
  sdk: { hosts: { rtkStatus: vi.fn() }, skills: { list: vi.fn() } },
}));

vi.mock("@/lib/url-open-routing", () => ({
  openUrlInExternalBrowser: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function showStep() {
  const onContinue = vi.fn();

  render(
    <QueryClientProvider client={new QueryClient()}>
      <RecommendedSkillsStep
        chrome={{
          compact: false,
          reserveMacosTrafficLights: false,
          previousStep: null,
          steps: onboardingSteps({
            browserLogins: false,
            chatImporterEnabled: false,
            automationsEnabled: false,
          }),
          onSelectStep: vi.fn(),
          onSkipAll: vi.fn(),
        }}
        hostId="host_primary"
        onBack={vi.fn()}
        onContinue={onContinue}
      />
    </QueryClientProvider>,
  );

  return onContinue;
}

it("links to setup for both missing recommendations and keeps setup optional", async () => {
  vi.mocked(sdk.skills.list).mockResolvedValue({ skills: [] });
  vi.mocked(sdk.hosts.rtkStatus).mockResolvedValue({ installed: false });
  const onContinue = showStep();

  fireEvent.click(await screen.findByRole("button", { name: "View skill" }));
  fireEvent.click(await screen.findByRole("button", { name: "Set up RTK" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  expect(openUrlInExternalBrowser).toHaveBeenNthCalledWith(
    1,
    "https://omnyohq.com/explore/skills/source/poteto-mode",
  );
  expect(openUrlInExternalBrowser).toHaveBeenNthCalledWith(
    2,
    "https://www.rtk-ai.app/docs/getting-started/installation/",
  );
  expect(sdk.skills.list).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: "host_primary" }),
  );
  expect(sdk.hosts.rtkStatus).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: "host_primary" }),
  );
  expect(onContinue).toHaveBeenCalledOnce();
});

it.each(["poteto-mode", "pstack:poteto-mode"])(
  "hides an installed %s while still recommending missing RTK",
  async (name) => {
    vi.mocked(sdk.skills.list).mockResolvedValue({
      skills: [
        {
          id: `skill_${"a".repeat(64)}`,
          name,
          scope: "plugin",
          provider: "codex",
          description: null,
          pluginId: "pstack",
          filePath: "/skills/poteto-mode/SKILL.md",
          manageable: false,
          registrySkillId: null,
        },
      ],
    });
    vi.mocked(sdk.hosts.rtkStatus).mockResolvedValue({ installed: false });
    showStep();

    await screen.findByRole("button", { name: "Set up RTK" });

    expect(screen.queryByText("Poteto Mode")).toBeNull();
  },
);

it.each(["installed", "unknown"])(
  "hides RTK when its status is %s",
  async (status) => {
    vi.mocked(sdk.skills.list).mockResolvedValue({ skills: [] });
    const rtkStatus = vi.mocked(sdk.hosts.rtkStatus);

    if (status === "installed")
      rtkStatus.mockResolvedValue({ installed: true });
    else rtkStatus.mockRejectedValue(new Error("Worker unavailable"));

    showStep();

    await screen.findByRole("button", { name: "View skill" });
    await waitFor(() => expect(rtkStatus).toHaveBeenCalledOnce());

    expect(screen.queryByText("RTK")).toBeNull();
  },
);
