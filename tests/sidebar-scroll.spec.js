import { test, expect } from '@playwright/test'

// Regression test for the sidebar-scroll-reset bug documented in
// sidebar-scroll-thread.md. Repro:
//   1. Open /docs/reference/config.html
//   2. Scroll the sidebar to the bottom
//   3. Click the "Orphan page" link in the content
//   4. Sidebar must NOT jump to the top (its scrollTop must be preserved)
//
// The orphan target (docs/orphan.adoc) is intentionally not in _nav.json,
// so it has no corresponding sidebar entry — the sidebar position has no
// "natural" reason to change and any movement is the bug we are testing for.

test.describe('sidebar scroll preservation across SPA navigation', () => {
  test('sidebar scrollTop is preserved when clicking an in-content link to an orphan page', async ({ page }) => {
    // Force a small viewport so the sidebar is guaranteed to overflow,
    // regardless of how much content the docs tree currently has.
    await page.setViewportSize({ width: 1024, height: 360 })

    await page.goto('/docs/reference/config.html')

    const sidebar = page.locator('#site-sidebar')
    await expect(sidebar).toBeVisible()

    // Sanity: the sidebar must actually be scrollable, otherwise the test
    // is meaningless.
    const overflow = await sidebar.evaluate(el => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))
    expect(overflow.scrollHeight,
      'sidebar must overflow for this regression test to be meaningful'
    ).toBeGreaterThan(overflow.clientHeight)

    // Scroll the sidebar to its bottom and snapshot the position.
    const scrollBefore = await sidebar.evaluate(el => {
      el.scrollTop = el.scrollHeight
      return el.scrollTop
    })
    expect(scrollBefore).toBeGreaterThan(0)

    // Find the in-content "Orphan page" link added at the bottom of
    // reference/config.adoc and click it.
    const orphanLink = page.locator('#content-wrap a', { hasText: 'Orphan page' })
    await expect(orphanLink).toBeVisible()
    await orphanLink.scrollIntoViewIfNeeded()
    await orphanLink.click()

    // SPA swap should land us on the orphan page.
    await expect(page).toHaveURL(/\/docs\/orphan(\.html)?$/)
    await expect(page.locator('#content-wrap h1')).toContainText('Orphan Page')

    // The fix in src/plugin.js installs a 500ms scrollTop lock across the
    // SPA swap. Wait past that window before sampling, so we measure the
    // *settled* position — not the locked one.
    await page.waitForTimeout(800)

    const scrollAfter = await sidebar.evaluate(el => el.scrollTop)
    expect(scrollAfter,
      `sidebar scrollTop must be preserved (was ${scrollBefore}, now ${scrollAfter})`
    ).toBe(scrollBefore)
  })

  test('sidebar HTML element identity is preserved across SPA navigation', async ({ page }) => {
    // AGENTS.md invariant #1: the sidebar must NEVER be re-rendered after
    // initial load. Verify by tagging the sidebar and checking the tag
    // survives a navigation.
    await page.goto('/docs/reference/config.html')

    await page.locator('#site-sidebar').evaluate(el => {
      el.setAttribute('data-test-tag', 'original')
    })

    const orphanLink = page.locator('#content-wrap a', { hasText: 'Orphan page' })
    await orphanLink.click()
    await expect(page).toHaveURL(/\/docs\/orphan/)

    const tag = await page.locator('#site-sidebar').getAttribute('data-test-tag')
    expect(tag).toBe('original')
  })

  test('browser Back restores previous page content, not just the URL', async ({ page }) => {
    // Repro for the back-button bug:
    //   1. From the docs root, scroll the sidebar to the bottom.
    //   2. Click "Configuration Reference" in the sidebar.
    //   3. Click the in-content "Orphan page" link.
    //   4. Press the browser's Back button.
    // Expected: content reverts to "Configuration Reference".
    // Bug: URL and sidebar update, but #content-wrap still shows "Orphan Page".
    await page.setViewportSize({ width: 1024, height: 360 })
    await page.goto('/docs/')

    const sidebar = page.locator('#site-sidebar')
    await sidebar.evaluate(el => { el.scrollTop = el.scrollHeight })

    const configLink = sidebar.locator('a', { hasText: 'Configuration Reference' }).first()
    await expect(configLink).toBeVisible()
    await configLink.click()

    await expect(page).toHaveURL(/\/docs\/reference\/config(\.html)?$/)
    await expect(page.locator('#content-wrap')).toContainText('Configuration Reference')

    const orphanLink = page.locator('#content-wrap a', { hasText: 'Orphan page' })
    await orphanLink.scrollIntoViewIfNeeded()
    await orphanLink.click()

    await expect(page).toHaveURL(/\/docs\/orphan(\.html)?$/)
    await expect(page.locator('#content-wrap h1')).toContainText('Orphan Page')

    await page.goBack()

    await expect(page).toHaveURL(/\/docs\/reference\/config(\.html)?$/)
    // The content area must reflect the URL — not still show the orphan page.
    await expect(page.locator('#content-wrap h1')).toContainText('Configuration Reference')
    await expect(page.locator('#content-wrap h1')).not.toContainText('Orphan Page')
  })

  test('clicking a no-hash nav link to the current page scrolls the main content to the top', async ({ page }) => {
    // Repro:
    //   1. On /docs/quickstart, click the sidebar "Installation" sub-link.
    //      URL → /docs/quickstart#_installation, main content scrolls down
    //      to the section anchor.
    //   2. Click the parent "Quick Start" nav label.
    //      URL → /docs/quickstart (no hash).
    // Expected: main content scrolls back to the top.
    // Bug: URL changes but main.scrollTop stays at the previous anchor
    // offset, so the page still appears scrolled to "Installation".
    await page.goto('/docs/quickstart.html')

    const main = page.locator('.site-main')
    await expect(main).toBeVisible()

    // Sanity: main must be tall enough to actually scroll, otherwise the
    // assertions below are vacuous.
    const overflow = await main.evaluate(el => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))
    expect(overflow.scrollHeight,
      'main content must overflow for this regression test to be meaningful'
    ).toBeGreaterThan(overflow.clientHeight)

    const installation = page.locator('.site-nav a', { hasText: 'Installation' }).first()
    await expect(installation).toBeVisible()
    await installation.click()

    await expect(page).toHaveURL(/\/docs\/quickstart(\.html)?#_installation$/)

    // After clicking the section link, main should be scrolled away from 0.
    await expect.poll(
      () => main.evaluate(el => el.scrollTop),
      { message: 'main should scroll to the section anchor' }
    ).toBeGreaterThan(0)

    // Click the parent "Quick Start" nav label (inside <summary>).
    const quickStartParent = page.locator('.site-nav summary .nav-label', { hasText: 'Quick Start' }).first()
    await expect(quickStartParent).toBeVisible()
    await quickStartParent.click()

    await expect(page).toHaveURL(/\/docs\/quickstart(\.html)?$/)

    await expect.poll(
      () => main.evaluate(el => el.scrollTop),
      { message: 'main should scroll to top when navigating to a no-hash URL on the current page' }
    ).toBe(0)
  })

  test('a missing /docs page is served as a shell-wrapped 404, sidebar preserved', async ({ page }) => {
    // The server should render a 404 page that still contains #content-wrap
    // and the sidebar, so the SPA can swap it in like any other page.
    const response = await page.goto('/docs/this/path/does/not/exist')
    expect(response?.status()).toBe(404)
    await expect(page.locator('#content-wrap h1')).toContainText('Page not found')
    await expect(page.locator('#site-sidebar')).toBeVisible()
    // The "documentation home" recovery link should be present.
    await expect(page.locator('#content-wrap a[href="/docs/"]')).toBeVisible()
  })

  test('clicking a broken in-content xref swaps a 404 page via SPA, sidebar identity preserved', async ({ page }) => {
    // Repro for the broken-link UX bug (cf. manyfold2 glossary's xref:api/...
    // typos that resolve to non-existent /docs/api/... URLs):
    //   - Before the fix: SPA fetch returned a non-OK status and the client
    //     fell back to window.location.href = url, causing a full page
    //     reload that re-rendered the sidebar (AGENTS.md invariant #1).
    //   - After the fix: server returns a shell-wrapped 404 with
    //     #content-wrap, SPA swaps it in, sidebar stays put.
    await page.goto('/docs/orphan.html')

    await page.locator('#site-sidebar').evaluate(el => {
      el.setAttribute('data-test-tag', 'original')
    })

    const brokenLink = page.locator('#content-wrap a', { hasText: 'broken cross-reference' })
    await expect(brokenLink).toBeVisible()
    await brokenLink.click()

    await expect(page).toHaveURL(/\/docs\/does-not-exist(\.html)?$/)
    await expect(page.locator('#content-wrap h1')).toContainText('Page not found')

    // Sidebar must be the same DOM element it was before (not re-rendered).
    const tag = await page.locator('#site-sidebar').getAttribute('data-test-tag')
    expect(tag).toBe('original')
  })

  test('static assets under /docs are still served by Vite (404 page must not shadow them)', async ({ page }) => {
    // Defensive test: the missing-page handler must only fire for doc-shaped
    // requests (no extension, .html, or .adoc) -- a request like
    // /docs/some-image.png must fall through to Vite's static server, not
    // get intercepted as a missing doc.
    const response = await page.request.get('/docs/never-going-to-exist.png')
    // We don't care what status Vite returns (likely 404), only that the
    // body is NOT our HTML 404 shell.
    const body = await response.text()
    expect(body).not.toContain('<h1>Page not found</h1>')
    expect(body).not.toContain('site-sidebar')
  })
})
