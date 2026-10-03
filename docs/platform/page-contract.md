# Artifact page contract (excerpt, as read 2026-10-03)

Copied from the Artifact tool's quickstart output in the session that produced the ShapeCast
spec. Authoritative for what a published page may do.

- External scripts load ONLY from https://cdnjs.cloudflare.com (preferred),
  https://cdn.jsdelivr.net/npm/, https://unpkg.com, https://cdn.tailwindcss.com and
  https://code.jquery.com; external stylesheets only from https://fonts.googleapis.com.
  Everything else is blocked with no visible error, including fetch/XHR/WebSocket to any
  other host.
- The viewer's sandbox blocks any download the page starts itself (`<a download>`, data: or
  blob: hrefs, script-driven saves). Files reach the viewer only through the `downloads`
  capability.
- Camera, microphone, screen capture, location, Web Share and similar device APIs are
  refused without a prompt. File inputs, drag-and-drop of files and FileReader work, so
  photos are taken as uploaded files.
- `alert()`, `confirm()` and `prompt()` are never shown; `confirm()` returns false.
- `window.print()` does nothing. Other sites cannot be embedded. Web Workers work from own
  files or blob: URLs; service workers and WebRTC do not.
- localStorage/sessionStorage/IndexedDB work per viewer and per artifact origin, may throw
  or come back empty; wrap in try/catch.
- Page must be 16 MB or smaller, work at about 400 px width, and define colours as tokens
  on `:root` with dark-mode redefinitions under `prefers-color-scheme` and `[data-theme]`.
