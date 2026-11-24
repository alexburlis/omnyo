import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@omnyo/shared-ui/confirm-delete-dialog";

export interface ProjectDeleteDialogTarget {
  id: string;
  name: string;
}

interface ProjectDeleteDialogProps {
  target: ProjectDeleteDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (projectId: string) => void;
}

export function ProjectDeleteDialog({
  target,
  pending,
  onOpenChange,
  onDelete,
}: ProjectDeleteDialogProps) {
  return (
    <ConfirmDeleteDialog open={target !== null} onOpenChange={onOpenChange}>
      {target ? (
        <ProjectDeleteDialogContent
          target={target}
          pending={pending}
          onDelete={onDelete}
          onCancel={() => onOpenChange(false)}
        />
      ) : null}
    </ConfirmDeleteDialog>
  );
}

interface ProjectDeleteDialogContentProps {
  target: ProjectDeleteDialogTarget;
  pending: boolean;
  onDelete: (projectId: string) => void;
  onCancel: () => void;
}

export function ProjectDeleteDialogContent({
  target,
  pending,
  onDelete,
  onCancel,
}: ProjectDeleteDialogContentProps) {
  return (
    <ConfirmDeleteDialogContent
      title="Remove project?"
      description={`Remove "${target.name}" and all of its threads? This cannot be undone.`}
      confirmLabel="Remove project"
      pending={pending}
      onCancel={onCancel}
      onConfirm={() => onDelete(target.id)}
    />
  );
}
