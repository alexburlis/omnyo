import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePluginUpdateJobs } from "@/hooks/queries/plugin-update-job-queries";
import {
  invalidatePluginList,
  invalidatePluginCatalogSearch,
} from "@/hooks/cache-owners/plugin-cache-owner";
import {
  hasReportedPluginUpdate,
  isWatchedPluginUpdate,
  markPluginUpdateReported,
  trackPluginUpdate,
} from "@/lib/plugin-update-tracking";
import { appToast } from "@/components/ui/app-toast";
import { usePluginNotificationAction } from "./PluginNotificationDescription";
import { displayPluginVersion } from "./management/plugin-ui";

export function PluginUpdateJobsHost() {
  const action = usePluginNotificationAction();
  const queryClient = useQueryClient();
  const { data: jobs } = usePluginUpdateJobs();
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    for (const job of jobs ?? []) {
      const state = job.state;
      const previous = seen.current.get(job.id);

      if (previous === state) continue;
      seen.current.set(job.id, state);
      const id = `plugin-update:${job.id}`;

      if (job.state === "queued" || job.state === "running") {
        trackPluginUpdate(job.id, true);
        appToast.loading(
          job.state === "queued" ? "Plugin update queued" : "Updating plugin…",
          {
            id,
            description: job.displayName,
          },
        );
        continue;
      }

      const updated = job.state === "completed" && job.result.applied;

      if (updated && hasReportedPluginUpdate(job.id)) continue;

      if (!updated && previous === undefined && !isWatchedPluginUpdate(job.id))
        continue;

      trackPluginUpdate(job.id, false);
      void invalidatePluginList({ queryClient });
      invalidatePluginCatalogSearch({ queryClient });

      if (job.state === "failed") {
        appToast.error("Plugin update failed", {
          id,
          description: `${job.displayName} — ${job.error}`,
          action: action(job.pluginId, "installed"),
        });
      } else if (job.result.outcome === "rolled-back") {
        appToast.error("Plugin update failed", {
          id,
          description: `${job.displayName} — Previous version and data restored.`,
          action: action(job.pluginId, "installed"),
        });
      } else {
        const version = job.result.to?.version;

        appToast.success(updated ? "Plugin updated" : "Plugin is up to date", {
          id,
          badge: true,
          description:
            updated && version !== undefined
              ? `${job.displayName} — ${displayPluginVersion(version)}`
              : job.displayName,
          action: action(job.pluginId, "app"),
        });

        if (updated) markPluginUpdateReported(job.id);
      }
    }
  }, [jobs, queryClient, action]);

  return null;
}
