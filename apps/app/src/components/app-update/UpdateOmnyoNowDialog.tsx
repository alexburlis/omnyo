import type { SystemAppUpdateStatus } from "@omnyo/server-contract";
import { Button } from "@omnyo/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@omnyo/shared-ui/dialog";
import { useApplyAppUpdate } from "@/hooks/mutations/app-update-mutations";
import {
  formatAppUpdateTarget,
  updateNowDescription,
} from "./app-update-presentation";

export function UpdateOmnyoNowDialog({
  open,
  status,
  onOpenChange,
}: {
  open: boolean;
  status: SystemAppUpdateStatus;
  onOpenChange: (open: boolean) => void;
}) {
  const apply = useApplyAppUpdate();

  const target =
    status.available === null ? null : formatAppUpdateTarget(status.available);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {target === null
              ? "Update Omnyo now?"
              : `Update Omnyo to ${target}?`}
          </DialogTitle>
          <DialogDescription>{updateNowDescription(status)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={apply.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={apply.isPending}
            onClick={() =>
              apply.mutate(
                { confirmInterruptingThreads: true },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Update now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
