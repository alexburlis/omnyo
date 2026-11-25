import { useCallback, useId, useState, type FormEvent } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  deriveProjectNameFromPath,
  getProjectPathValidationMessage,
  normalizeProjectPathInput,
  type Host,
} from "@omnyo/domain";
import type { HostPlatform } from "@omnyo/host-daemon-contract";
import type { ProjectResponse } from "@omnyo/server-contract";
import { Button } from "@omnyo/shared-ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@omnyo/shared-ui/dialog";
import { Input } from "@omnyo/shared-ui/input";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { RemotePathBrowser } from "@/components/dialogs/RemotePathBrowser";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { selectHosts } from "@/hooks/queries/host-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { sdk } from "@/lib/sdk";

export type ProjectPathDialogTarget =
  | {
      kind: "create";
      select?: {
        onCreated?: (project: Pick<ProjectResponse, "id" | "name">) => void;
      };
    }
  | {
      kind: "update";
      projectId: string;
      projectName: string;
      currentPath: string;
    }
  | {
      kind: "add-source";
      projectId: string;
      projectName: string;
    };

export type ProjectPathDialogSubmitHandler = (
  target: ProjectPathDialogTarget,
  path: string,
  hostId: string | null,
) => Promise<void> | void;

interface ProjectPathDialogProps {
  target: ProjectPathDialogTarget | null;
  pending?: boolean;
  platform: HostPlatform | null;
  hostId: string | null;
  hostName: string | null;
  hosts?: readonly Host[];
  onOpenChange: (open: boolean) => void;
  onSubmit: ProjectPathDialogSubmitHandler;
}

export function ProjectPathDialog({
  target,
  pending = false,
  platform,
  hostId,
  hostName,
  hosts,
  onOpenChange,
  onSubmit,
}: ProjectPathDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] max-w-[min(42rem,calc(100%-2rem))] overflow-y-auto p-5 sm:p-6"
        onEscapeKeyDown={(event) => {
          if (
            event.target instanceof HTMLElement &&
            event.target.closest("[data-folder-picker-editor]")
          ) {
            event.preventDefault();
          }
        }}
      >
        {target ? (
          <ProjectPathDialogContent
            key={
              target.kind === "create"
                ? "create"
                : `${target.kind}:${target.projectId}`
            }
            target={target}
            pending={pending}
            platform={platform}
            hostId={hostId}
            hostName={hostName}
            hosts={hosts}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface ProjectPathDialogContentProps {
  target: ProjectPathDialogTarget;
  pending: boolean;
  platform: HostPlatform | null;
  hostId: string | null;
  hostName: string | null;
  hosts?: readonly Host[];
  onSubmit: ProjectPathDialogSubmitHandler;
}

interface PlatformCopy {
  description: string;
  placeholder: string;
}

function getDialogTitle(kind: ProjectPathDialogTarget["kind"]): string {
  switch (kind) {
    case "create":
      return "Add project";
    case "update":
      return "Update project path";
    case "add-source":
      return "Add project source";
  }
}

function getDialogSubmitLabel(kind: ProjectPathDialogTarget["kind"]): string {
  switch (kind) {
    case "create":
      return "Add project";
    case "update":
      return "Save path";
    case "add-source":
      return "Add source";
  }
}

function getPlatformCopy(
  platform: HostPlatform | null,
  hostName: string | null,
): PlatformCopy {
  const placeholder = "/path/to/project";
  const hostSuffix = hostName ? ` on ${hostName}` : "";

  if (platform === "wsl") {
    return {
      description: `Enter an absolute WSL path${hostSuffix} to the project folder, such as /home/me/repo or /mnt/c/...`,
      placeholder,
    };
  }

  if (platform === "win32") {
    return {
      description: `Enter an absolute Windows path${hostSuffix} to the project folder, such as C:\\Users\\me\\repo.`,
      placeholder: "C:\\path\\to\\project",
    };
  }

  return {
    description: `Enter an absolute path${hostSuffix} to the project folder.`,
    placeholder,
  };
}

export function ProjectPathDialogContent({
  target,
  pending,
  platform,
  hostId,
  hostName,
  hosts,
  onSubmit,
}: ProjectPathDialogContentProps) {
  const inputId = useId();
  const isPointerCoarse = usePointerCoarse();
  const { localDaemonHostId, supportsNativeFolderPicker } = useHostDaemon();

  const machineOptions =
    target.kind === "create" && hosts !== undefined
      ? selectHosts(hosts, "all")
      : undefined;

  const firstConnectedHostId = machineOptions?.find(
    (host) => host.status === "connected",
  )?.id;

  const [selectedHostIdState, setSelectedHostId] = useState(
    hostId ?? firstConnectedHostId ?? null,
  );

  const selectedHostId =
    machineOptions === undefined ||
    machineOptions.some(
      (host) => host.id === selectedHostIdState && host.status === "connected",
    )
      ? selectedHostIdState
      : (firstConnectedHostId ?? null);

  const selectedHost = machineOptions?.find(
    (host) => host.id === selectedHostId,
  );

  const selectedHostName = selectedHost?.name ?? hostName;

  const showMachinePicker = (machineOptions?.length ?? 0) > 1;

  const noMachineAvailable =
    target.kind === "create" && selectedHostId === null;

  const [manualPath, setManualPath] = useState(
    target.kind === "update" ? target.currentPath : "",
  );

  const [selection, setSelection] = useState<{
    hostId: string;
    path: string;
  } | null>(null);

  const [browseInOmnyo, setBrowseInOmnyo] = useState(false);
  const [nativePickerPending, setNativePickerPending] = useState(false);

  const [nativePickerError, setNativePickerError] = useState<string | null>(
    null,
  );

  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );

  const copy = getPlatformCopy(platform, selectedHostName);

  const placeholder =
    target.kind === "update"
      ? target.currentPath || copy.placeholder
      : copy.placeholder;

  const setHostSelection = useCallback(
    (path: string | null) => {
      setSelection(
        path && selectedHostId ? { hostId: selectedHostId, path } : null,
      );
      setValidationMessage(null);
    },
    [selectedHostId],
  );

  const canPickNatively =
    supportsNativeFolderPicker &&
    selectedHostId !== null &&
    selectedHostId === localDaemonHostId;

  const useNativePicker = canPickNatively && !browseInOmnyo;
  const busy = pending || nativePickerPending;

  const selectedPath = selectedHostId
    ? selection?.hostId === selectedHostId
      ? selection.path
      : null
    : normalizeProjectPathInput(manualPath) || null;

  const derivedProjectName = selectedPath
    ? deriveProjectNameFromPath(selectedPath)
    : "";

  const browseNativeFolder = async () => {
    if (!selectedHostId || !canPickNatively || busy) return;

    setNativePickerPending(true);
    setNativePickerError(null);

    try {
      const { path } = await sdk.hosts.pickFolder({
        hostId: selectedHostId,
        clientHostId: selectedHostId,
      });

      if (path) setHostSelection(path);
    } catch (error) {
      setNativePickerError(
        getMutationErrorMessage({
          error,
          fallbackMessage: "Couldn't open the system folder picker.",
        }),
      );
    } finally {
      setNativePickerPending(false);
    }
  };

  const selectBrowser = (browseInApp: boolean) => {
    setHostSelection(null);
    setNativePickerError(null);
    setBrowseInOmnyo(browseInApp);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (busy || noMachineAvailable) return;

    if (!selectedPath) {
      setValidationMessage("Choose a project folder.");

      return;
    }

    const normalizedPath = normalizeProjectPathInput(selectedPath);

    const pathValidationMessage =
      getProjectPathValidationMessage(normalizedPath);

    if (pathValidationMessage) {
      setValidationMessage(pathValidationMessage);

      return;
    }

    if (
      target.kind === "create" &&
      !deriveProjectNameFromPath(normalizedPath)
    ) {
      setValidationMessage("Could not derive a project name from that path.");

      return;
    }

    void onSubmit(target, normalizedPath, selectedHostId);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{getDialogTitle(target.kind)}</DialogTitle>
        <DialogDescription
          className={cn((selectedHostId || noMachineAvailable) && "sr-only")}
        >
          {selectedHostId
            ? `Choose a project folder${selectedHostName ? ` on ${selectedHostName}` : ""}.`
            : noMachineAvailable
              ? "No machine is online. Start one to choose a project folder."
              : copy.description}
        </DialogDescription>
      </DialogHeader>
      <form className="min-w-0 space-y-4" onSubmit={handleSubmit}>
        {showMachinePicker ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={busy}>
              <Button
                type="button"
                variant="outline"
                aria-label="Machine"
                disabled={busy}
                className="max-w-full justify-between font-normal"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {selectedHost ? (
                    <MachineStatusDot connected label="Online" />
                  ) : null}
                  <span className="min-w-0 truncate">
                    {selectedHost?.name ?? "Select a machine"}
                  </span>
                </span>
                <Icon
                  name="ChevronDown"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              mobileTitle="Machine"
              className="max-h-72 min-w-48 overflow-y-auto"
            >
              {machineOptions?.map((host) => {
                const connected = host.status === "connected";

                return (
                  <DropdownMenuItem
                    key={host.id}
                    disabled={!connected}
                    className="flex items-center gap-2"
                    onSelect={() => {
                      if (!connected) return;
                      setSelectedHostId(host.id);

                      if (host.id !== selectedHostId) selectBrowser(false);
                    }}
                  >
                    <MachineStatusDot
                      connected={connected}
                      label={connected ? "Online" : undefined}
                    />
                    <span className="min-w-0 flex-1 truncate">{host.name}</span>
                    {!connected ? (
                      <span className="shrink-0 text-xs text-subtle-foreground">
                        Offline
                      </span>
                    ) : null}
                    <Icon
                      name="Check"
                      className={cn(
                        "size-4 shrink-0",
                        host.id === selectedHostId
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : selectedHostId && selectedHostName ? (
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <Icon name="Laptop" className="size-4 shrink-0" />
            <span className="truncate" title={selectedHostName}>
              {selectedHostName}
            </span>
          </div>
        ) : null}
        {useNativePicker ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border bg-muted/30 px-3 py-6">
            <Icon name="FolderOpen" className="size-8 text-muted-foreground" />
            <Button
              type="button"
              variant={selectedPath ? "outline" : "default"}
              disabled={busy}
              onClick={() => void browseNativeFolder()}
            >
              {nativePickerPending
                ? "Waiting for system picker…"
                : selectedPath
                  ? "Choose another folder…"
                  : "Choose folder…"}
            </Button>
            {nativePickerError ? (
              <p
                role="alert"
                className="max-w-full break-words text-center text-sm text-destructive"
              >
                {nativePickerError}
              </p>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => selectBrowser(true)}
            >
              Browse in Omnyo
            </Button>
          </div>
        ) : selectedHostId ? (
          <RemotePathBrowser
            key={selectedHostId}
            hostId={selectedHostId}
            initialPath={target.kind === "update" ? target.currentPath : null}
            allowCreateFolder={target.kind === "create"}
            selectInitialFolder={target.kind === "update"}
            onDirectoryChange={setHostSelection}
            disabled={busy}
          />
        ) : noMachineAvailable ? (
          <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
            Every machine is offline. Bring one online to browse its folders.
          </p>
        ) : (
          <Input
            id={inputId}
            aria-label="Project path"
            value={manualPath}
            autoFocus={!isPointerCoarse}
            disabled={pending}
            placeholder={placeholder}
            onChange={(event) => {
              setManualPath(event.target.value);
              setValidationMessage(null);
            }}
          />
        )}
        {validationMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {validationMessage}
          </p>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          {selectedHostId ? (
            <div
              className="flex min-w-0 flex-[1_1_12rem] items-center gap-2.5"
              role="status"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md border text-muted-foreground">
                <Icon name="Folder" className="size-4" />
              </span>
              <div className="min-w-0 text-sm">
                <p
                  className={cn(
                    "truncate",
                    selectedPath ? "font-medium" : "text-muted-foreground",
                  )}
                >
                  {derivedProjectName ||
                    (selectedPath ? "Filesystem root" : "No folder selected")}
                </p>
                {selectedPath ? (
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={selectedPath}
                  >
                    {selectedPath}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
          <DialogFooter className="ml-auto max-w-full flex-row flex-wrap items-center justify-end gap-2">
            {canPickNatively && !useNativePicker ? (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => selectBrowser(false)}
              >
                System picker
              </Button>
            ) : null}
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={busy || !selectedPath || noMachineAvailable}
            >
              {getDialogSubmitLabel(target.kind)}
            </Button>
          </DialogFooter>
        </div>
      </form>
    </>
  );
}
