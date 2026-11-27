import { definePluginApp } from "@omnyo/plugin-sdk/app";
import { registerPromptPicker } from "./prompt-picker";
import { SkillLibraryPage } from "./library-page";
import { CuratedPicker, curatedPopupId } from "./curated-picker";
import "./app.css";

type IconArtworkProps = { className?: string };

function LibraryArtwork({ className }: IconArtworkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4v16M8 4v16M12 4v16M16 4l4 16" />
    </svg>
  );
}

function RefreshArtwork({ className }: IconArtworkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 7v5h-5M4 17v-5h5M6.2 6a8 8 0 0 1 13.5 4M4.3 14A8 8 0 0 0 17.8 18" />
    </svg>
  );
}

export default definePluginApp((app) => {
  registerPromptPicker(app);
  app.experimental_icons.register({ name: "skill-discovery-library", component: LibraryArtwork });
  app.experimental_icons.register({ name: "skill-discovery-refresh", component: RefreshArtwork });
  app.composer.customize({
    id: "curated-skills",
    scopes: ["new-thread", "thread"],
    experimental_popups: [{ id: curatedPopupId, label: "Find skills", component: CuratedPicker }],
    plusMenu: [
      {
        id: "find-skills",
        label: "Find skills",
        icon: "skill-discovery-library",
        run: ({ composer }) => {
          composer.experimental_openPopup(curatedPopupId);
        },
      },
    ],
  });
  app.slots.navPanel({
    id: "browse",
    title: "Skills",
    icon: "skill-discovery-library",
    path: "browse",
    component: SkillLibraryPage,
  });
});
