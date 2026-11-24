import {
  definePluginApp,
  experimental_Icon as Icon,
} from "@omnyo/plugin-sdk/app";

function PluginApiTesterPanel() {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-4 md:p-5">
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-10 text-center shadow-card">
        <span className="grid size-11 place-items-center rounded-full bg-state-hover text-muted-foreground ring-1 ring-border">
          <Icon name="Beaker" className="size-5" aria-hidden />
        </span>
        <div className="flex max-w-sm flex-col gap-1">
          <p className="text-base font-semibold text-foreground">
            Plugin API Tester is active
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            This placeholder panel proves a plugin panel can mount. It is on by
            default in development and off by default in production.
          </p>
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "plugin-api-tester",
    title: "Plugin API Tester",
    icon: "Beaker",
    path: "plugin-api-tester",
    component: PluginApiTesterPanel,
  });
});
