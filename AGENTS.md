# adocserver — Agent Rules

Persistent rules for any agent working on this project. Violating any of these is a regression.

## Nav pane (left sidebar) invariants

1. **Never reload the nav pane.**
   The sidebar HTML must be rendered once, on initial page load, and never replaced thereafter. SPA navigation must only swap `#content-wrap`. Any code that fetches a page and replaces the sidebar (or triggers a full page navigation that re-renders it) is a bug — the sidebar's user-controlled scroll position must be preserved across all in-app navigation.

2. **Never autoscroll the nav pane when the user clicks inside it.**
   No `scrollIntoView`, no `scrollTop = …`, no focus-driven scroll, no "smart" scroll-to-active. If the user clicked a sidebar item, they were already looking at it — moving the sidebar under their cursor is unacceptable. Any sidebar scrolling must be initiated exclusively by the user (mouse wheel, scrollbar, keyboard inside the sidebar).

3. **All nav items are expanded by default.**
   Every group in the tree renders as `<details open>`. Do not add collapse-by-default logic, do not persist collapsed state, do not auto-collapse non-active groups. The user can manually collapse via the caret if they want.

4. **`/docs/_nav.json` contains the entire TOC as a tree.**
   Every page, every section, every subsection — the full hierarchical table of contents in one JSON document. Shape: `{ label, href, children: [...] }`, recursive. This endpoint is the single source of truth for the navigation structure.

5. **The left pane just renders `_nav.json`.**
   The sidebar is a pure rendering of the nav tree — server-side or client-side, it must consume the same tree that `_nav.json` exposes. No alternate code path that builds nav from a different source. If you need to change what's in the sidebar, change the nav tree builder; the renderer stays a dumb function of the tree.

## Click handling in the sidebar

- Clicks on a `<summary>`'s label must navigate via SPA, **not** toggle the `<details>`. Use `e.preventDefault()` on the label click — never `e.stopPropagation()` (that bypasses the SPA handler and causes a full page reload, which violates rule #1).
- Clicks on the caret (or empty summary area) toggle the group as normal.
- The document-level SPA click handler must run for every in-app `<a href="/docs/...">` click, regardless of which other handlers ran first.
