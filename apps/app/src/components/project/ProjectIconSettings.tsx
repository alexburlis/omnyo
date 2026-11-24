import { useRef, useState } from "react";
import type { ProjectResponse } from "@omnyo/server-contract";
import { projectCustomIconSchema } from "@omnyo/domain";
import { Button } from "@omnyo/shared-ui/button";
import {
  ProjectFace,
  useConnectedHostIds,
} from "@/components/sidebar/ProjectFace";
import { SettingsRow } from "@/components/ui/settings-section";
import { useUpdateProject } from "@/hooks/mutations/project-mutations";

export async function readCustomProjectIcon(file: File): Promise<string> {
  if (
    !/^image\/(png|jpeg|webp|gif|svg\+xml|x-icon|vnd.microsoft.icon)$/u.test(
      file.type,
    ) ||
    file.size > 5 * 1024 * 1024
  ) {
    throw new Error("Choose an image smaller than 5 MB.");
  }

  const url = URL.createObjectURL(file);

  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const scale = Math.min(
      1,
      96 / Math.max(image.naturalWidth, image.naturalHeight),
    );

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");

    if (context === null) throw new Error("Couldn't prepare this image.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const result = projectCustomIconSchema.safeParse(
      canvas.toDataURL("image/png"),
    );

    if (!result.success)
      throw new Error("Couldn't prepare this image. Try another image.");

    return result.data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ProjectIconSettings({ project }: { project: ProjectResponse }) {
  const input = useRef<HTMLInputElement>(null);
  const update = useUpdateProject({ showErrorToast: false });
  const connectedHostIds = useConnectedHostIds();
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = preparing || update.isPending;

  const save = async (file: File) => {
    setError(null);
    setPreparing(true);

    try {
      const customIcon = await readCustomProjectIcon(file);
      await update.mutateAsync({ id: project.id, customIcon });
    } catch {
      setError(
        "Couldn't save this icon. Choose an image smaller than 5 MB and try again.",
      );
    } finally {
      setPreparing(false);
    }
  };

  return (
    <SettingsRow className="flex-wrap">
      <span
        className="size-10 shrink-0 overflow-hidden rounded-md"
        aria-hidden="true"
      >
        <ProjectFace
          project={project}
          connectedHostIds={connectedHostIds}
          variant="tile"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Project icon</p>
        {error === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
        aria-label="Choose project icon"
        className="hidden"
        disabled={pending}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";

          if (file !== undefined) void save(file);
        }}
      />
      <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0">
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => input.current?.click()}
        >
          {pending ? "Saving…" : "Change icon"}
        </Button>
        {project.customIcon ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setError(null);
              update.mutate(
                { id: project.id, customIcon: null },
                {
                  onError: () =>
                    setError("Couldn't reset this icon. Try again."),
                },
              );
            }}
          >
            Use automatic icon
          </Button>
        ) : null}
      </div>
    </SettingsRow>
  );
}
