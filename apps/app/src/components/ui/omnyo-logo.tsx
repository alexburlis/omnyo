import { cn } from "@omnyo/shared-ui/lib/utils";
import omnyoLogoUrl from "../../../../../assets/omnyo-logo.svg";
import omnyoDarkLogoUrl from "@/assets/omnyo-logo-dark.svg";

export function OmnyoLogo({ className = "size-4" }: { className?: string }) {
  return (
    <span className={cn("inline-block", className)} aria-hidden="true">
      <img
        src={omnyoLogoUrl}
        alt=""
        draggable={false}
        className="size-full object-contain dark:hidden"
      />
      <img
        src={omnyoDarkLogoUrl}
        alt=""
        draggable={false}
        className="hidden size-full object-contain dark:block"
      />
    </span>
  );
}
