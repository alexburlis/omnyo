import { createFileRoute } from "@tanstack/react-router";

import { FeatureIndex } from "../features/feature-index";
import { pageMeta } from "../landing/page-head";

const TITLE = "Omnyo features: everything the app does";

const DESCRIPTION =
  "Every part of Omnyo in detail: the inbox, parallel agents in Git worktrees, remote control from your phone, usage tracking, automations and more.";

export const Route = createFileRoute("/features/")({
  head: () => ({ meta: pageMeta(TITLE, DESCRIPTION, "/features") }),
  component: FeatureIndex,
});
