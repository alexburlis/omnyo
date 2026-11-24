import { createContext, useState, type ReactNode } from "react";

export const PreviewAnnouncementContext = createContext<
  (message: string) => void
>(() => undefined);

export function PreviewAnnouncementsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [message, setMessage] = useState("");

  return (
    <PreviewAnnouncementContext.Provider value={setMessage}>
      {children}
      <span className="sr-only" role="status" aria-live="polite">
        {message}
      </span>
    </PreviewAnnouncementContext.Provider>
  );
}
