import type { OmnyoDesktopServerChoice } from "@omnyo/desktop-contract";

export type ServerChoice = OmnyoDesktopServerChoice;

export interface ServerChoices {
  list(): Promise<ServerChoice[]>;
  subscribe(listener: (choices: ServerChoice[]) => void): () => void;
  select(id: string): void;
}

export function getServerChoices(): ServerChoices | null {
  const desktop =
    typeof window === "undefined" ? undefined : window.omnyoDesktop;

  if (
    desktop?.getServerChoices &&
    desktop.onServerChoicesChange &&
    desktop.selectServer
  ) {
    return {
      list: desktop.getServerChoices.bind(desktop),
      subscribe: desktop.onServerChoicesChange.bind(desktop),
      select: desktop.selectServer.bind(desktop),
    };
  }

  return null;
}
