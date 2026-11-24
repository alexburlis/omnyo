import type { OmnyoProjectOption } from "../../shared/contract.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NO_LINK = "__none__";

export function OmnyoProjectLinkPicker({
  value,
  onChange,
  omnyoProjects,
  noneLabel = "Not linked",
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  omnyoProjects: readonly OmnyoProjectOption[];
  noneLabel?: string;
}) {
  const unavailableSelection =
    value !== null && !omnyoProjects.some((project) => project.id === value)
      ? value
      : null;

  return (
    <Select
      value={value ?? NO_LINK}
      onValueChange={(next) => onChange(next === NO_LINK ? null : next)}
    >
      <SelectTrigger aria-label="Linked Omnyo project" className="h-8">
        <SelectValue>
          {omnyoProjects.find((project) => project.id === value)?.name ??
            unavailableSelection ??
            noneLabel}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_LINK}>{noneLabel}</SelectItem>
        {unavailableSelection !== null ? (
          <SelectItem value={unavailableSelection}>
            Unavailable · {unavailableSelection}
          </SelectItem>
        ) : null}
        {omnyoProjects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
