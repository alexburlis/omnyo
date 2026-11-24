import { skipToken, useQuery } from "@tanstack/react-query";
import { PERSONAL_PROJECT_ID } from "@omnyo/domain";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { OnboardingLayout, type OnboardingStepChrome } from "./OnboardingViews";

const SKILL_MARKETPLACE_URL = "https://omnyohq.com/explore/skills";

const POTETO_MODE_URL = `${SKILL_MARKETPLACE_URL}/source/poteto-mode`;

const RTK_INSTALL_URL =
  "https://www.rtk-ai.app/docs/getting-started/installation/";

export function RecommendedSkillsStep({
  chrome,
  hostId,
  onBack,
  onContinue,
}: {
  chrome: OnboardingStepChrome;
  hostId: string | null;
  onBack: () => void;
  onContinue: () => void;
}) {
  const potetoMode = useQuery({
    queryKey: ["onboarding", "poteto-mode", hostId],
    queryFn:
      hostId === null
        ? skipToken
        : ({ signal }) =>
            sdk.skills.list({
              projectId: PERSONAL_PROJECT_ID,
              environmentId: null,
              hostId,
              signal,
            }),
    select: ({ skills }) =>
      skills.some(({ name }) => {
        const skillName = name.toLowerCase();

        return (
          skillName === "poteto-mode" || skillName === "pstack:poteto-mode"
        );
      }),
    refetchOnWindowFocus: true,
    retry: false,
  });

  const rtk = useQuery({
    queryKey: ["onboarding", "rtk", hostId],
    queryFn:
      hostId === null
        ? skipToken
        : ({ signal }) => sdk.hosts.rtkStatus({ hostId, signal }),
    refetchOnWindowFocus: true,
    retry: false,
  });

  const showPotetoMode = potetoMode.isSuccess && !potetoMode.data;
  const showRtk = rtk.isSuccess && !rtk.data.installed;

  return (
    <OnboardingLayout
      {...chrome}
      step="skills"
      title="Recommended skills"
      description="Find skills and tools for your coding agent."
      primaryLabel="Continue"
      onPrimary={onContinue}
      onBack={onBack}
    >
      <div className="flex flex-col gap-4">
        {showPotetoMode || showRtk ? (
          <ul className="divide-y divide-border-hairline overflow-hidden rounded-xl border border-border bg-card shadow-xs">
            {showPotetoMode ? (
              <Recommendation
                name="Poteto Mode"
                description="Give your agent a workflow for planning, reviewing, and verifying code changes."
                action="View skill"
                url={POTETO_MODE_URL}
              />
            ) : null}
            {showRtk ? (
              <Recommendation
                name="RTK"
                description="Reduce the amount of terminal output your agent has to read."
                action="Set up RTK"
                url={RTK_INSTALL_URL}
              />
            ) : null}
          </ul>
        ) : null}
        <Button
          className="self-start"
          variant="outline"
          size="sm"
          onClick={() => openUrlInExternalBrowser(SKILL_MARKETPLACE_URL)}
        >
          Browse the skill marketplace
          <Icon name="ArrowUpRight" aria-hidden />
        </Button>
      </div>
    </OnboardingLayout>
  );
}

function Recommendation({
  name,
  description,
  action,
  url,
}: {
  name: string;
  description: string;
  action: string;
  url: string;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 basis-48">
        <h2 className="text-sm font-medium">{name}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => openUrlInExternalBrowser(url)}
      >
        {action}
        <Icon name="ArrowUpRight" aria-hidden />
      </Button>
    </li>
  );
}
