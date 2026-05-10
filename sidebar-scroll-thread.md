# docserver — sidebar scroll resets on SPA navigation

## Repo
`/home/dims/Design/docserver` (Vite plugin, asciidoc dev server).
Test docs used: `/home/dims/Design/manyfold2/docs`.

## Bug
Left-hand TOC (`#site-sidebar`, `overflow-y: auto`) jumps to top when the user
clicks a link inside the content area. Repro:
1. Open `/docs/`.
2. Scroll the sidebar down to "Built demos", click ? `/docs/apps/#_built_demos`.
3. Click the in-content `ga_demo` xref ? `/docs/apps/ga_demo.html`.
4. Sidebar scrolls to top. Pressing Back does not restore the position.

## Constraints (`AGENTS.md`)
- Sidebar HTML must NEVER be re-rendered after initial load. SPA must only swap
  `#content-wrap`.
- No autoscroll of the sidebar from any code path.
- All groups render `<details open>`.
- `/docs/_nav.json` is the single source of truth.
- Bump version with `npm version patch`, not by editing `package.json`.

## Root cause (analysis)
SPA swap uses `here.replaceWith(fresh)` on `#content-wrap`. The clicked `<a>`
inside content has focus (mousedown's default action focuses the link).
Removing the focused element forces the browser to relocate focus to the next
tab stop in document order — that's `<a class="site-brand">` at the top of the
sidebar — and then the browser scrolls the nearest overflow ancestor (the
sidebar) to make it visible. Hence: TOC jumps to top.

## File touched
`src/plugin.js` — only the SPA `navigate()` IIFE inside `buildScripts()`.

## Fixes attempted (in order)

### Attempt 1 — focus `<main>` before swap, snapshot/restore sidebar scroll
- Set `tabIndex = -1` on `.site-main`, call `main.focus({ preventScroll: true })`
  before `replaceWith`.
- Snapshot `sidebar.scrollTop` before swap, reassign at end of `navigate()`.
- Stored outgoing scroll in `history.state` for back/forward restore via
  `replaceState` + `pushState`.

User feedback: still scrolls. "Don't drop and restore — stop the drop."

### Attempt 2 — focus `<main>` only, no restore
Removed all history/restore code; kept only the `main.focus` before swap.

User feedback: still scrolls.

### Attempt 3 (current) — frame-like isolation
Two changes inside the navigate IIFE:

1. **`mousedown` preventDefault on in-content links** so the `<a>` never
   receives focus in the first place:
   ```js
   document.addEventListener('mousedown', e => {
     if (e.button !== 0) return
     const a = e.target.closest('a[href]')
     if (!a) return
     if (!a.closest('.site-main')) return
     e.preventDefault()
   })
   ```

2. **`lockSidebarScroll(500)`** — snapshot `sidebar.scrollTop` and re-assert it
   on every animation frame for 500 ms across the SPA swap, overriding any
   focus/anchor/layout-induced scroll the browser tries during the swap:
   ```js
   function lockSidebarScroll(durationMs) {
     if (!sidebar) return
     const y = sidebar.scrollTop
     const deadline = performance.now() + durationMs
     const tick = () => {
       if (sidebar.scrollTop !== y) sidebar.scrollTop = y
       if (performance.now() < deadline) requestAnimationFrame(tick)
     }
     sidebar.scrollTop = y
     requestAnimationFrame(tick)
   }
   ```
   Called immediately before `here.replaceWith(fresh)`.

User has not yet confirmed whether attempt 3 works.

## Important reminder
`src/plugin.js` is a Vite plugin — **must restart the dev server** for changes
to take effect; HMR will not reload plugin code.

## Open questions / next steps
- Verify attempt 3 actually fixes the jump after a clean server restart.
- If it still scrolls, instrument with a `scroll` event listener on the
  sidebar to log who is scrolling it (focus, anchor target, layout shift).
- Consider Back/Forward sidebar position restore (deferred per user — only
  fix the drop first).
- Bump version with `npm version patch` once accepted.

## Key files / lines
- `src/plugin.js` — `buildScripts()` IIFE around the SPA `navigate()`
  function (~line 293–415 currently).
- `AGENTS.md` — sidebar invariants.
