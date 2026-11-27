# Omnyo Customizer

Click the Omnyo Customizer toggle (a cursor selecting a dashed box) among the bottom-right footer icons, then click any visible part of Omnyo. A New chat dialog opens for that element: describe the change and send. The chat receives your request plus bounded visible text, element geometry and page context. Click the toggle again, choose Stop or press Escape to stop picking; Pick again in the dialog chooses another element. Form values and editable text are excluded.

Settings → Plugins → Omnyo Customizer → Chat defaults selects an existing ready folder and the default provider, model and reasoning level. Until you save defaults, the dialog uses the composer's usual project and model. In a folder that is not Omnyo's source code, the chat is asked to make the change with settings, a theme or a plugin.

CLI: `omnyo self-improvement config --json`, `omnyo self-improvement targets --json`, and `omnyo self-improvement configure '{"environmentId":"<env_id>","providerId":"<provider_id>","model":"<model_id>","reasoningLevel":"medium"}'`. The same operations are available through plugin RPC `config`, `targets`, and `save`.

Selection works in the Omnyo document. Embedded browser frames are separate documents. No agent runs until you send the draft.
