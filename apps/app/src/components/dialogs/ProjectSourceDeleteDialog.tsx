import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@omnyo/shared-ui/confirm-delete-dialog";

export interface ProjectSourceDeleteDialogTarget {
  id: string;
  label: string;
}

interface ProjectSourceDeleteDialogProps {
  target: ProjectSourceDeleteDialogTarget | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (sourceId: string) => void;
}

export function ProjectSourceDeleteDialog({
  target,
  pending,
  onOpenChange,
  onDelete,
}: ProjectSourceDeleteDialogProps) {
  return (
    <ConfirmDeleteDialog open={target !== null} onOpenChange={onOpenChange}>
      {target ? (
        <ProjectSourceDeleteDialogContent
          target={target}
          pending={pending}
          onDelete={onDelete}
          onCancel={() => onOpenChange(false)}
        />
      ) : null}
    </ConfirmDeleteDialog>
  );
}

interface ProjectSourceDeleteDialogContentProps {
  target: ProjectSourceDeleteDialogTarget;
  pending: boolean;
  onDelete: (sourceId: string) => void;
  onCancel: () => void;
}

export function ProjectSourceDeleteDialogContent({
  target,
  pending,
  onDelete,
  onCancel,
}: ProjectSourceDeleteDialogContentProps) {
  return (
    <ConfirmDeleteDialogContent
      title="Remove source?"
      description={`Remove "${target.label}" from this project? This cannot be undone.`}
      confirmLabel="Remove source"
      pending={pending}
      onCancel={onCancel}
      onConfirm={() => onDelete(target.id)}
    />
  );
}
