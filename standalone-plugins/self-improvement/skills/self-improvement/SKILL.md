---
name: self-improvement
description: Inspect or configure the Omnyo Customizer element picker defaults in Omnyo.
---

Use `omnyo self-improvement config --json` to read the default environment, provider, model and reasoning level; it prints `null` until defaults are saved. Use `omnyo self-improvement targets --json` to list ready registered folders and `omnyo provider models` to find model IDs. Save a complete configuration with `omnyo self-improvement configure '{"environmentId":"<env_id>","providerId":"<provider_id>","model":"<model_id>","reasoningLevel":"medium"}' --json`.

In Omnyo, click the Omnyo Customizer toggle among the bottom-right footer icons, then click a visible element. Clicking the toggle again, choosing Stop or pressing Escape stops picking. A New chat dialog opens for the element; type the requested change there. On send, the chat receives the request followed by bounded visible text, geometry, element selector, page path and source chat identity. Input values and editable contents are excluded. The dialog uses the configured folder and model, or the composer's usual project and model when no defaults are saved; no agent starts until submission.

When the chat's folder is not Omnyo's source code, make the requested change with Omnyo settings, `omnyo theme` or a plugin (see the omnyo-plugin-authoring skill). Never edit the installed Omnyo app.

Settings → Plugins → Omnyo Customizer → Chat defaults offers the folder selector and the host model picker. Folder choices are existing ready environments. Picking within embedded browser frames is outside the Omnyo document picker.
