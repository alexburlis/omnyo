Show structured replies, HTML visualizations and Markdown documents directly in
Omnyo chat.

Native blocks include status tables, file cards, metrics, charts, comparison bars,
ordered steps, callouts, progress bars and badges. Values stay as supplied, while
charts and typography follow Omnyo's theme. File cards use Omnyo's file links and
can offer Pursue plan actions when that plugin is available.

For richer diagrams, mockups or interactive reports, a fenced `inline-vis` block
holds a self-contained HTML page without creating a file. Existing
`::inline-vis{file="…"}` directives show HTML or Markdown from the workspace or
thread storage. Relative assets resolve beside an HTML file. Markdown cards can
copy, expand and open the document in the sidebar.

HTML runs in an opaque-origin sandbox. The frame follows the app theme and its
content height, and user-clicked HTTP(S) links open through the host. Files must
be source-relative UTF-8 documents no larger than 5 MiB. Invalid previews show a
visible error. Empty or unfinished HTML fences remain ordinary code.

Inline UI 0.4.0 combines the native blocks and the former Inline Visualizations
plugin while preserving existing directive and fence syntax. Both authoring
skills are bundled. No account or external service is required.

## Credits

The HTML and Markdown renderer is based on the
[inline-vis plugin in bb](https://github.com/get-bb/bb/tree/main/plugins/inline-vis).
Thank you to Michael Yong and the bb contributors for the original work. Its
original MIT license and copyright notice are preserved in LICENSE and NOTICE.
