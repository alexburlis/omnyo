import { restoreNativeOriginSessionV1 } from "./lib/origin-native-session-restore-v1";
import { assertBrowserStorageMigrationV1 } from "./lib/legacy-browser-storage-v1";
import { importLegacyBrowserPreferences } from "./lib/legacy-browser-preferences";
import "./app.css";

function showStartupError(headingText: string, detailText: string): void {
  const root = document.getElementById("root");

  if (!root) return;
  const screen = document.createElement("main");
  screen.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = headingText;
  const detail = document.createElement("p");
  detail.textContent = detailText;
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => window.location.reload());
  screen.append(heading, detail, reload);
  root.replaceChildren(screen);
}

async function startApp(): Promise<void> {
  let confirmNativeEntry: (() => Promise<void>) | null = null;

  try {
    const nativeRestore = Reflect.get(window, "__omnyoOriginSessionRestoreV1");

    if (nativeRestore !== undefined) {
      confirmNativeEntry = await restoreNativeOriginSessionV1(nativeRestore, {
        currentOrigin: location.origin,
        local: localStorage,
        session: sessionStorage,
        nativeOwner: Reflect.get(window, "__omnyoNativeFirstEntryV1"),
      });

      const begin = Reflect.get(
        window,
        "__omnyoBeginBrowserStorageAdmissionV1",
      );

      if (typeof begin !== "function")
        throw new Error("Native browser admission owner is unavailable");
      Reflect.apply(begin, window, []);
    }

    const admission = Reflect.get(window, "__omnyoBrowserStorageAdmission");

    if (!(admission instanceof Promise))
      throw new Error("Browser storage admission is unavailable");
    await admission;
    assertBrowserStorageMigrationV1();
  } catch {
    showStartupError(
      "Saved browser data needs review",
      "The migration stopped and preserved your saved copies. Reload to try again.",
    );

    return;
  }

  importLegacyBrowserPreferences();

  try {
    await import("./app-entry");

    if (confirmNativeEntry)
      void confirmNativeEntry().catch(() => {
        console.warn("Native first-entry confirmation remains pending");
      });
  } catch {
    showStartupError("Could not start the app", "Reload to try again.");
  }
}

void startApp();
