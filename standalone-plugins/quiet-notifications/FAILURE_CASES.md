# Required behavior

- An idle parent with active workflow, agent, command, goal, plan mode, queued message or pending interaction must not emit a completion notification. Hidden, nested and paginated child work also blocks completion.
- Pending questions, approvals and terminal errors still notify. A later finished idle event may notify once work settles. Read, archived and deleted threads do not notify.
- Installing copies all four existing delivery settings once, preserves phone registrations, and disables the built-in sender before starting the replacement. Reloading preserves edited replacement settings.
- Native enrollment refreshes remain visible to the sender without restart; expired devices are removed through the built-in RPC. The SQLite attachment must reject writes. No token appears in CLI status or device summaries.
- Missing registration schema, unavailable activity or unavailable built-in RPC fails visibly instead of claiming successful completion.
- Client notification permission requires a click. Notifications deduplicate across windows and navigate on click. Disposal cancels timers, closes notifications and releases resources.

Existing sender and client integration cases were copied before production implementation. The upstream regression evidence demonstrates 13 failures on the original sender. New enrollment and reload coverage adds the boundary the upstream tests cannot reach.
