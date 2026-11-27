Needs You is included in Omnyo's built-in `ask-user-question` plugin. This compatibility entry retains legacy preferences and adopts old attention records into native Omnyo state. It registers no UI and is no longer a separate store feature.

Update the built-in plugin before this companion. Update or disable older companion versions before enabling the merged UI, so only one sidebar overlay runs. Existing questions, pending interactions, callbacks and completion markers remain native and are not deleted.

Manage the merged features with `omnyo plugin config ask-user-question`.
