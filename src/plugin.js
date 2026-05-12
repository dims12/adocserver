import asciidoctor from 'asciidoctor'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

const adoc = asciidoctor()

// Matches local include:: directives (relative path, no attribute references).
// Path ends at the '[', so spaces and non-ASCII chars are valid in the path segment.
const INCLUDE_RE = /^include::([^{\[]+\.adoc)\[([^\]]*)\][ \t]*$/gm

function applyTemplate(tmpl, slots) {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => slots[k] ?? '')
}

// ---- Nav tree ----------------------------------------------------------

function fileToHref(file, docsDir, urlBase = '/docs') {
  const rel      = path.relative(docsDir, file).replace(/\\/g, '/')
  const segments = rel.split('/').map(encodeURIComponent)
  if (path.basename(file) === 'index.adoc') {
    const dirSegs = segments.slice(0, -1)
    return dirSegs.length === 0 ? `${urlBase}/` : `${urlBase}/${dirSegs.join('/')}/`
  }
  return `${urlBase}/${segments.join('/')}`
}

function hrefToFile(pathname, docsDir, urlBase = '/docs') {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { decoded = pathname }
  let rel = decoded.slice(urlBase.length)
  if (rel === '' || rel === '/') {
    rel = 'index.adoc'
  } else {
    rel = rel.replace(/^\//, '')
    if (rel.endsWith('/')) rel += 'index.adoc'
    else if (!rel.endsWith('.adoc')) rel = rel.replace(/\.html$/, '') + '.adoc'
  }
  const filePath = path.resolve(docsDir, rel)
  if (!filePath.startsWith(docsDir + path.sep)) return null
  return existsSync(filePath) ? filePath : null
}

function readAdocTitle(file, fallback) {
  try {
    const m = readFileSync(file, 'utf8').match(/^= (.+)$/m)
    return m ? m[1].trim() : fallback
  } catch { return fallback }
}

export function buildNavTree(file, docsDir, labelOverride, urlBase = '/docs') {
  const label = labelOverride || readAdocTitle(file, path.basename(file, '.adoc'))
  const href  = fileToHref(file, docsDir, urlBase)
  return {
    label,
    href,
    file,
    children: buildInterleavedChildren(file, docsDir, href, urlBase),
  }
}

// Parse the file as an ordered sequence of section headings and include
// directives so includes are nested under the section they appear in,
// not appended after all sections.
function buildInterleavedChildren(file, docsDir, href, urlBase = '/docs') {
  if (!existsSync(file)) return []
  const source = readFileSync(file, 'utf8')
  const dir = path.dirname(file)

  // Pass 1: scan raw source for section markers and include directives in
  // document order. Section titles are read from raw text (with markup),
  // but only the *level* and *position* matter -- the actual labels and
  // ids come from pass 2 (asciidoctor's parsed structure), since titles
  // can contain backticks, xrefs, attribute substitutions, etc. that
  // raw-text matching can't reconstruct.
  //
  // We also track the most recent block-attribute line (e.g. "[discrete]")
  // so we can skip headings marked discrete -- those render as standalone
  // headings, not as nav sections, and asciidoctor's section walker
  // correctly excludes them. If we picked them up here, the 1-to-1
  // pairing with pass 2 below would misalign and assign the wrong
  // labels and anchors to every later section.
  const events = []
  let pendingAttrs = null
  for (const line of source.split('\n')) {
    if (line.trim() === '') continue
    const attrM = line.match(/^\[(.*)\]\s*$/)
    if (attrM) {
      pendingAttrs = attrM[1]
      continue
    }
    const secM = line.match(/^(={2,})\s+(.+)$/)
    if (secM) {
      const isDiscrete = pendingAttrs !== null && /\bdiscrete\b/.test(pendingAttrs)
      if (!isDiscrete) {
        events.push({ type: 'section', level: secM[1].length })
      }
      pendingAttrs = null
      continue
    }
    const incM = line.match(/^include::([^{\[]+\.adoc)\[([^\]]*)\]\s*$/)
    if (incM) {
      const childPath = path.resolve(dir, incM[1])
      if (existsSync(childPath)) {
        // Brackets in include:: directives carry asciidoctor *attributes*
        // (leveloffset=+1, lines=1..5, tag=foo, indent=N, ...), NOT a
        // label override. The nav label must come from the included
        // file's "= Title" heading, never from bracket content.
        const label = readAdocTitle(childPath, path.basename(incM[1], '.adoc'))
        events.push({ type: 'include', filePath: childPath, label })
      }
      pendingAttrs = null
      continue
    }
    pendingAttrs = null
  }

  // Pass 2: walk asciidoctor's parsed document in document order and
  // collect (id, label) pairs. Strip includes from the source so the
  // loaded document only contains *this* file's sections; that keeps the
  // section list 1-1 with our raw-source section events.
  const parsedSections = []
  const previousLogger = adoc.LoggerManager.getLogger()
  try {
    adoc.LoggerManager.setLogger(adoc.NullLogger.create())
    const stripped = source.replace(/^include::[^\n]*$/gm, '')
    const doc = adoc.load(stripped, adocOptions(dir))
    function walk(node) {
      for (const s of (node.getSections?.() ?? [])) {
        // getTitle() returns the HTML-substituted title (e.g. with
        // <code>...</code> for backticks and <a href="..."> for xrefs);
        // strip tags + decode common entities to get a clean nav label.
        const html = s.getTitle() ?? ''
        const label = html
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim()
        parsedSections.push({ id: s.getId(), label })
        walk(s)
      }
    }
    walk(doc)
  } catch {
    // ignore parse errors -- sections will fall through to a sensible
    // fallback below
  } finally {
    adoc.LoggerManager.setLogger(previousLogger)
  }

  // Build tree using a level-aware stack so includes nest under their
  // section. Pair raw-source section events 1-1 with parsedSections (both
  // are in document order); if the asciidoctor pass produced nothing
  // (parse error), fall back to the file basename as the label and emit
  // an anchorless href so the entry is at least visible.
  const roots = []
  const stack = [] // [{ node, level }]
  let secIdx = 0

  for (const event of events) {
    if (event.type === 'section') {
      const meta = parsedSections[secIdx++] ?? { id: null, label: '' }
      const node = {
        label: meta.label || path.basename(file, '.adoc'),
        href:  meta.id ? href + '#' + meta.id : href,
        children: [],
      }
      while (stack.length > 0 && stack[stack.length - 1].level >= event.level) stack.pop()
      if (stack.length === 0) roots.push(node)
      else stack[stack.length - 1].node.children.push(node)
      stack.push({ node, level: event.level })
    } else {
      const node = buildNavTree(event.filePath, docsDir, event.label, urlBase)
      if (stack.length === 0) roots.push(node)
      else stack[stack.length - 1].node.children.push(node)
    }
  }

  return roots
}

// ---- Preprocessing (index pages only) ----------------------------------

export async function preprocessIncludes(source, dir, docsDir, urlBase = '/docs') {
  const re = new RegExp(INCLUDE_RE.source, 'gm')
  const matches = [...source.matchAll(re)]
  if (matches.length === 0) return source
  let result = source
  for (const m of matches) {
    const filePath = path.resolve(dir, m[1])
    if (!existsSync(filePath)) continue
    // Bracket content is asciidoctor include attributes (leveloffset=+1,
    // lines=1..5, tag=foo, ...), not a label. Always derive the label from
    // the included file's "= Title" heading.
    let label
    try {
      const t = (await fs.readFile(filePath, 'utf8')).match(/^= (.+)$/m)
      label = t ? t[1].trim() : path.basename(m[1], '.adoc')
    } catch { label = path.basename(m[1], '.adoc') }
    result = result.replace(m[0], `* link:${fileToHref(filePath, docsDir, urlBase)}[${label}]`)
  }
  return result
}

// ---- WebAssembly macro preprocessing ----------------------------------

const WASM_RE = /^wasm::([^\s\[]+)\[([^\]]*)\]\s*$/gm

function parseBlockAttrs(str) {
  const attrs = {}
  let pos = 1
  for (const part of str.split(',')) {
    const t = part.trim()
    if (!t) continue
    const kv = t.match(/^(\w[\w-]*)\s*=\s*(.+)$/)
    if (kv) {
      attrs[kv[1]] = kv[2].trim()
    } else {
      attrs[pos++] = t
    }
  }
  return attrs
}

export function preprocessWasm(source) {
  return source.replace(new RegExp(WASM_RE.source, 'gm'), (_, target, attrStr) => {
    const attrs = parseBlockAttrs(attrStr)
    const w = attrs.width || attrs[1] || 800
    const h = attrs.height || attrs[2] || 600
    const src = /^\//.test(target) ? target : `/wasm/${target}`
    const url = `/_adocserver/wasm-shell?src=${encodeURIComponent(src)}&w=${encodeURIComponent(w)}&h=${encodeURIComponent(h)}`
    return `++++\n<div class="wasm-embed"><iframe src="${url}" width="${w}" height="${h}" frameborder="0" scrolling="no" allow="autoplay; fullscreen; gamepad; clipboard-read; clipboard-write" style="display:block;border:0"></iframe></div>\n++++`
  })
}

// ---- Asciidoc rendering ------------------------------------------------

function adocOptions(baseDir) {
  return {
    safe: 'unsafe',
    base_dir: baseDir,
    attributes: {
      stem: 'latexmath',
      'source-highlighter': 'highlight.js',
      showtitle: true,
      icons: 'font',
      sectanchors: true,
      toc: 'left',
      imagesdir: '/images',
      doctype: 'book',
    },
  }
}

// ---- Sidebar -----------------------------------------------------------

function renderSidebar(navRoot, currentPath, currentHash, siteTitle, logo, urlBase = '/docs') {
  function pathOf(href) {
    const i = href.indexOf('#')
    return i >= 0 ? href.slice(0, i) : href
  }
  function hashOf(href) {
    const i = href.indexOf('#')
    return i >= 0 ? href.slice(i) : ''
  }

  function isActive(href) {
    const p = pathOf(href)
    const h = hashOf(href)
    const pathMatch = p.endsWith('/')
      ? currentPath === p || currentPath === p.slice(0, -1)
      : currentPath === p
    return pathMatch && h === currentHash
  }

  function renderNode(node, depth) {
    const active = isActive(node.href)
    const cls    = depth === 1 ? 'nav-link' : 'nav-sublink'

    if (node.children.length === 0) {
      return `<a href="${node.href}" class="${cls}${active ? ' active' : ''}">${node.label}</a>`
    }

    const children = node.children.map(c => renderNode(c, depth + 1)).join('\n')

    return `<details class="nav-group" open>
      <summary class="${cls}${active ? ' active' : ''}">
        <a href="${node.href}" class="nav-label">${node.label}</a>
        <span class="nav-caret">?</span>
      </summary>
      <div class="nav-children">
        ${children}
      </div>
    </details>`
  }

  const brand = logo
    ? `<img src="${logo}" alt="${siteTitle}" class="site-logo" />`
    : `<span class="site-title">${siteTitle}</span>`

  const items = navRoot.children.map(n => renderNode(n, 1)).join('\n')
  return `<aside class="site-sidebar" id="site-sidebar">
    <a class="site-brand" href="${urlBase}/">
      ${brand}
    </a>
    <nav class="site-nav">
      ${items}
    </nav>
  </aside>
  <div class="sidebar-resizer" id="sidebar-resizer" title="Drag to resize"></div>`
}

// ---- Page shell --------------------------------------------------------

// Functional head content: HMR client, math, syntax highlighting, favicon.
// Included in {{head}} for custom templates; merged into <head> for the built-in shell.
function buildHead() {
  return `<meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script type="module" src="/@vite/client"></script>
    <script>
      window.MathJax = {
        tex: {
          inlineMath: [['\\\\(', '\\\\)']],
          displayMath: [['\\\\[', '\\\\]']],
        },
      }
    </script>
    <script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"></script>
    <link rel="icon" type="image/svg+xml" href="/_adocserver/favicon.svg" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css" />`
}

// Body scripts: syntax highlighting init + sidebar resize handle.
// Included in {{scripts}} for custom templates; placed before </body> in built-in shell.
function buildScripts(urlBase = '/docs') {
  return `<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>
    <script>
      document.querySelectorAll('pre code:not([data-highlighted])').forEach(el => {
        try { window.hljs?.highlightElement(el) } catch {}
      })
    </script>
    <script>
      (function () {
        const sidebar = document.getElementById('site-sidebar')
        const resizer = document.getElementById('sidebar-resizer')
        if (!sidebar || !resizer) return
        const STORAGE_KEY = 'adocserver-sidebar-w'
        const MIN_W = 140, MAX_W = 480

        const saved = parseInt(localStorage.getItem(STORAGE_KEY) ?? '', 10)
        if (saved >= MIN_W && saved <= MAX_W) {
          sidebar.style.width = saved + 'px'
          document.documentElement.style.setProperty('--sidebar-w', saved + 'px')
        }

        let startX = null, startW = null
        resizer.addEventListener('mousedown', e => {
          startX = e.clientX
          startW = sidebar.getBoundingClientRect().width
          resizer.classList.add('dragging')
          document.body.style.userSelect = 'none'
          document.body.style.cursor = 'col-resize'
          e.preventDefault()
        })
        document.addEventListener('mousemove', e => {
          if (startX === null) return
          const w = Math.max(MIN_W, Math.min(MAX_W, startW + e.clientX - startX))
          sidebar.style.width = w + 'px'
          document.documentElement.style.setProperty('--sidebar-w', w + 'px')
        })
        document.addEventListener('mouseup', () => {
          if (startX === null) return
          localStorage.setItem(STORAGE_KEY, parseInt(sidebar.style.width, 10).toString())
          startX = null; startW = null
          resizer.classList.remove('dragging')
          document.body.style.userSelect = ''
          document.body.style.cursor = ''
        })
      })()

      ;(function () {
        const nav = document.querySelector('.site-nav')
        if (!nav) return
        const sidebar = document.getElementById('site-sidebar')

        // Prevent <details> toggle when the user clicks the label part of a
        // summary � let the document click handler do SPA navigation instead.
        // We must NOT stopPropagation here, otherwise the document handler
        // never runs, the link triggers a full page load, and the sidebar
        // gets re-rendered (losing its scroll position).
        nav.addEventListener('click', e => {
          if (e.target.closest('summary .nav-label')) e.preventDefault()
        })

        function syncNavActive() {
          const url = window.location.pathname + window.location.hash
          nav.querySelectorAll('.nav-link.active, .nav-sublink.active').forEach(el => el.classList.remove('active'))
          nav.querySelectorAll('a[href]').forEach(a => {
            const href = a.getAttribute('href')
            if (!href) return
            let parsed
            try { parsed = new URL(href, window.location.origin) } catch { return }
            if (parsed.pathname + parsed.hash === url) {
              const summary = a.closest('summary')
              ;(summary ?? a).classList.add('active')
            }
          })
        }

        // Frame-like isolation: lock the sidebar's scrollTop for a short
        // window across the SPA swap. The browser may try to move focus or
        // scroll the nearest overflow ancestor when the active <a> in the
        // content is removed; this loop overrides any such adjustment.
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

        // Track the pathname currently rendered in #content-wrap. We can't
        // use window.location.pathname for this comparison because on
        // popstate (Back/Forward) the browser has *already* updated
        // window.location to the popped URL by the time our handler fires �
        // so any check against window.location.pathname would falsely
        // report "same path" and skip the fetch+swap.
        let displayedPath = window.location.pathname

        async function navigate(href, push) {
          const url = new URL(href, window.location.origin)
          const samePath = url.pathname === displayedPath
          if (!samePath) {
            try {
              const res = await fetch(url.href, { headers: { accept: 'text/html' } })
              // Don't bail on non-OK status here: the server intentionally
              // serves a shell-wrapped 404 page (with a usable #content-wrap)
              // for missing /docs paths, and we want the SPA to swap it in
              // so the sidebar/scroll state is preserved. The fall-through
              // to a full page nav still happens below if the response has
              // no #content-wrap to swap.
              const html = await res.text()
              const dom = new DOMParser().parseFromString(html, 'text/html')
              const fresh = dom.getElementById('content-wrap')
              const here  = document.getElementById('content-wrap')
              if (!fresh || !here) { window.location.href = url.href; return }
              lockSidebarScroll(500)
              here.replaceWith(fresh)
              displayedPath = url.pathname
              if (dom.title) document.title = dom.title
              // Highlight only the new content, and only blocks that haven't
              // already been highlighted. Calling hljs.highlightAll() rescans
              // the entire document on every navigation � slow (hundreds of
              // ms) and triggers "unescaped HTML" warnings on re-highlights.
              if (window.hljs) {
                fresh.querySelectorAll('pre code:not([data-highlighted])').forEach(el => {
                  try { window.hljs.highlightElement(el) } catch {}
                })
              }
              // Scope MathJax to the new subtree so it doesn't re-typeset the
              // whole page.
              window.MathJax?.typesetPromise?.([fresh])
            } catch { window.location.href = url.href; return }
          }
          if (push) history.pushState(null, '', url.href)
          syncNavActive()
          if (url.hash) {
            const target = document.getElementById(decodeURIComponent(url.hash.slice(1)))
            // Scroll the main content scroller only � never let scrollIntoView
            // walk up into the sidebar's overflow ancestor.
            const main = document.querySelector('.site-main')
            if (target && main) {
              main.scrollTop = target.offsetTop - main.offsetTop
            } else {
              target?.scrollIntoView()
            }
          } else {
            // No hash: scroll main to top. This must run for both new-path
            // navigations AND same-path navigations -- e.g. user is on
            // /docs/quickstart#_installation and clicks the parent
            // "Quick Start" nav label (href=/docs/quickstart, no hash).
            // The path is unchanged but the target is the top of the page.
            const main = document.querySelector('.site-main')
            if (main) main.scrollTop = 0; else window.scrollTo(0, 0)
          }
        }

        // Prevent in-content links from grabbing focus on click. mousedown's
        // default action is to focus the target; once the link is focused,
        // removing it later (during SPA swap) makes the browser move focus
        // to the first tab stop in the document � the sidebar � and scroll
        // the sidebar to show it. Suppressing the focus shift up front
        // means the sidebar never has a reason to scroll.
        document.addEventListener('mousedown', e => {
          if (e.button !== 0) return
          const a = e.target.closest('a[href]')
          if (!a) return
          if (!a.closest('.site-main')) return
          e.preventDefault()
        })

        document.addEventListener('click', e => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          const a = e.target.closest('a[href]')
          if (!a) return
          if (a.target && a.target !== '_self') return
          // Use the DOM's already-resolved absolute URL (a.href). Resolving the
          // raw attribute against window.location.origin would drop the
          // document path, so a relative href like "../orphan.html" from
          // /docs/reference/config.html would wrongly resolve to /orphan.html
          // and miss the /docs prefix check below � bypassing SPA entirely
          // and causing a full page reload (which re-renders the sidebar).
          let url
          try { url = new URL(a.href) } catch { return }
          if (url.origin !== window.location.origin) return
          if (!url.pathname.startsWith(${JSON.stringify(urlBase)})) return
          e.preventDefault()
          navigate(url.href, true)
        })

        window.addEventListener('popstate', () => navigate(window.location.href, false))

        syncNavActive()
      })()
    </script>`
}

function renderPage(bodyHtml, title, currentPath, currentHash, navRoot, siteConfig, opts = {}) {
  const { customCss, templateContent, urlBase = '/docs' } = opts
  const { siteTitle, logo, accent, accentStrong } = siteConfig

  const sidebarHtml = renderSidebar(navRoot, currentPath, currentHash, siteTitle, logo, urlBase)
  const head        = buildHead()
  const scripts     = buildScripts(urlBase)

  if (templateContent) {
    return applyTemplate(templateContent, {
      title,
      head,
      sidebar: sidebarHtml,
      body:    bodyHtml,
      scripts,
    })
  }

  const customCssTag = customCss ? `\n    <link rel="stylesheet" href="${customCss}" />` : ''

  return `<!doctype html>
<html>
  <head>
    <title>${title}</title>
    ${head}
    <style>
      :root {
        --bg: #fff7f6;
        --surface: #ffffff;
        --surface-alt: #fff0ee;
        --text: #3f1116;
        --muted: #7c3a3f;
        --border: #e8c7c0;
        --accent: ${accent};
        --accent-strong: ${accentStrong};
        --sidebar-w: 220px;
      }

      *, *::before, *::after { box-sizing: border-box; }

      html, body { margin: 0; padding: 0; height: 100%; }
      body {
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        line-height: 1.5;
        background: var(--bg);
        color: var(--text);
        display: flex;
        min-height: 100vh;
      }

      a { color: var(--accent); }
      a:hover { color: var(--accent-strong); }

      /* ---- sidebar ---- */
      .site-sidebar {
        width: var(--sidebar-w);
        min-width: 140px;
        max-width: 480px;
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        background: var(--surface);
        border-right: 1px solid var(--border);
        height: 100vh;
        position: sticky;
        top: 0;
        overflow-y: auto;
        padding: .75rem 0 1.5rem;
      }

      .site-brand {
        display: inline-flex; align-items: center;
        text-decoration: none;
        padding: .25rem .75rem .5rem;
        margin-bottom: .25rem;
        border-bottom: 1px solid var(--border);
      }
      .site-logo { height: 4rem; width: auto; display: block; object-fit: contain; }
      .site-title {
        font-size: 1.05rem; font-weight: 700;
        color: var(--accent); letter-spacing: -.01em;
      }

      .site-nav {
        display: flex; flex-direction: column; gap: .125rem;
        font-size: .8125rem;
        padding: 0 .375rem;
      }

      .nav-link {
        display: flex; align-items: center;
        padding: .3rem .625rem;
        border-radius: .25rem;
        color: var(--muted);
        text-decoration: none;
        font-weight: 500;
        transition: background .15s, color .15s;
        width: 100%;
      }
      .nav-link:hover { background: var(--surface-alt); color: var(--text); }
      .nav-link.active { background: var(--accent); color: #fff; }
      .nav-link.active:hover { background: var(--accent-strong); color: #fff; }

      .nav-caret {
        font-size: .7em; opacity: .6; margin-left: auto;
        transition: transform .15s; flex-shrink: 0; padding: 0 .25rem;
        /* The caret is a UI glyph, not text -- don't let it be selected. */
        user-select: none;
      }
      details.nav-group[open] > summary .nav-caret { transform: rotate(90deg); }

      summary.nav-link, summary.nav-sublink {
        list-style: none;
        display: flex; align-items: center; gap: .25rem;
        padding: 0;
        /* Group labels (rendered inside <summary>) must be text-selectable
         * just like leaf nav entries. Earlier we set user-select: none on
         * the whole summary to keep the caret non-selectable, but that
         * also blocked label selection -- so user-select: none now lives
         * on .nav-caret only. */
      }
      summary.nav-link::-webkit-details-marker,
      summary.nav-sublink::-webkit-details-marker { display: none; }
      summary.nav-link::marker,
      summary.nav-sublink::marker { content: ''; }
      summary .nav-label {
        flex: 1; min-width: 0;
        padding: .3rem .625rem;
        border-radius: .25rem;
        color: inherit; text-decoration: none;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      summary .nav-label:hover { background: var(--surface-alt); color: var(--text); }
      summary.active .nav-label { background: var(--accent); color: #fff; }
      summary.active .nav-label:hover { background: var(--accent-strong); color: #fff; }

      .nav-sublink {
        display: block;
        padding: .275rem .625rem;
        border-radius: .25rem;
        color: var(--muted);
        text-decoration: none;
        font-weight: 500;
        transition: background .15s, color .15s;
        width: 100%;
      }
      .nav-sublink:hover { background: var(--surface-alt); color: var(--text); }
      .nav-sublink.active { background: var(--accent); color: #fff; }
      .nav-sublink.active:hover { background: var(--accent-strong); color: #fff; }

      .nav-children {
        display: flex; flex-direction: column; gap: .0625rem;
        padding: .125rem 0 .25rem .75rem;
      }

      /* ---- resize handle ---- */
      .sidebar-resizer {
        width: 5px; flex-shrink: 0; cursor: col-resize;
        background: transparent; transition: background .15s;
        position: relative; z-index: 10;
      }
      .sidebar-resizer:hover, .sidebar-resizer.dragging { background: var(--accent); }

      /* ---- main content ---- */
      .site-main { flex: 1; min-width: 0; overflow-y: auto; padding: 0; }

      #content-wrap {
        width: 960px;
        min-height: 100%;
        padding: 1.75rem 2rem 2.5rem;
        background: var(--surface);
      }

      #content-wrap h1, #content-wrap h2, #content-wrap h3,
      #content-wrap h4, #content-wrap h5, #content-wrap h6 {
        color: var(--text); font-weight: 600; letter-spacing: -.01em;
      }
      #content-wrap h1 { border-bottom: 1px solid var(--border); padding-bottom: .35em; }

      pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      pre {
        overflow: auto; padding: .9rem 1rem;
        background: var(--surface-alt); border: 1px solid var(--border); border-radius: .5rem;
      }
      code { background: var(--surface-alt); color: var(--text); padding: .1rem .35rem; border-radius: .25rem; }
      pre code { background: transparent; padding: 0; }

      blockquote {
        margin: 1rem 0; padding: .25rem 1rem;
        border-left: 3px solid var(--accent);
        background: var(--surface-alt); color: var(--muted);
        border-radius: 0 .5rem .5rem 0;
      }

      table { border-collapse: collapse; }
      table th, table td { border: 1px solid var(--border); padding: .35rem .6rem; }
      table th { background: var(--surface-alt); }

      hr { border: 0; border-top: 1px solid var(--border); }
      img { max-width: 100%; }

      #toc.toc2 { margin-bottom: 1.5rem; font-size: .875rem; }
      #toc .title { color: var(--muted); font-weight: 600; margin-bottom: .25rem; }
      #toc a { color: var(--muted); text-decoration: none; }
      #toc a:hover { color: var(--accent); }

      /* ---- landing link list ---- */
      #content-wrap ul.section-list { list-style: none; padding: 0; margin: 1rem 0; }
      #content-wrap ul.section-list li { margin: .35rem 0; }
      #content-wrap ul.section-list a {
        display: inline-block; padding: .35rem .75rem;
        border: 1px solid var(--border); border-radius: .375rem;
        background: var(--surface-alt); color: var(--text);
        text-decoration: none; font-weight: 500;
      }
      #content-wrap ul.section-list a:hover {
        background: var(--accent); color: #fff; border-color: var(--accent);
      }
    </style>${customCssTag}
  </head>
  <body>
    ${sidebarHtml}
    <main class="site-main">
      <div id="content-wrap">
        ${bodyHtml}
      </div>
    </main>
    ${scripts}
  </body>
</html>`
}

// ---- Vite plugin -------------------------------------------------------

export function createAdocPlugin({ docsDir, assetsDir, config, urlBase = '/docs' }) {
  const siteTitle    = config.title        ?? 'Docs'
  const accent       = config.accent       ?? '#a81d2d'
  const accentStrong = config.accentStrong ?? '#7f1321'
  const logo         = config.logo         ?? null

  // Explicit overrides from docserver.config.js
  const explicitCss      = config.css      ?? null
  const explicitTemplate = config.template ? path.resolve(docsDir, config.template) : null

  const siteConfig = { siteTitle, logo, accent, accentStrong }
  const DOCS_INDEX = path.resolve(docsDir, 'index.adoc')
  const DEFAULT_TEMPLATE = path.resolve(docsDir, 'template.html')
  const DEFAULT_CSS = path.resolve(docsDir, 'custom.css')

  let navRoot

  function rebuildNav() {
    navRoot = buildNavTree(DOCS_INDEX, docsDir, undefined, urlBase)
  }

  function classifyWatchedFile(file) {
    const abs = path.resolve(file)
    const isAdoc = abs.endsWith('.adoc') && (abs === DOCS_INDEX || abs.startsWith(docsDir + path.sep))
    const isCss  = abs === (explicitCss ? path.resolve(docsDir, explicitCss) : DEFAULT_CSS)
    const isTmpl = abs === (explicitTemplate ?? DEFAULT_TEMPLATE)
    return { isAdoc, isCss, isTmpl }
  }

  function triggerReload(server, file) {
    const { isAdoc, isCss, isTmpl } = classifyWatchedFile(file)
    if (isAdoc) rebuildNav()
    if (isAdoc || isCss || isTmpl) {
      server.ws.send({ type: 'full-reload' })
    }
  }

  rebuildNav()

  return {
    name: 'adocserver',

    configureServer(server) {
      server.watcher.add(path.join(docsDir, '**/*.adoc'))
      const onFsChange = changed => triggerReload(server, changed)
      server.watcher.on('add', onFsChange)
      server.watcher.on('change', onFsChange)
      server.watcher.on('unlink', onFsChange)

      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next()
        const pathname = new URL(req.url, 'http://localhost').pathname

        // WebAssembly iframe shell
        if (pathname === '/_adocserver/wasm-shell') {
          const params = new URL(req.url, 'http://localhost').searchParams
          const src    = params.get('src') || ''
          const w      = Math.max(1, Math.min(8192, parseInt(params.get('w') || '800', 10) || 800))
          const h      = Math.max(1, Math.min(8192, parseInt(params.get('h') || '600', 10) || 600))
          if (!src.startsWith('/wasm/') || !src.endsWith('.js') || src.includes('..')) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'text/plain')
            res.end('Invalid src')
            return
          }
          // Emscripten resolves .wasm / .data next to the *document* URL. This page
          // lives at /_adocserver/wasm-shell, so without locateFile the runtime
          // wrongly fetches /_adocserver/*.wasm ? prefix with the real /wasm/ dir.
          const slash       = src.lastIndexOf('/')
          const assetBase   = slash >= 0 ? src.slice(0, slash + 1) : '/wasm/'
          const assetBaseJs = JSON.stringify(assetBase)
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          // Pin the shell document to the embed?s pixel size so window.innerWidth/Height
          // are non-zero before raylib/GLFW run (iframes can report 0 during first layout).
          res.end(`<!doctype html>
<html lang="en" style="margin:0;width:${w}px;height:${h}px;overflow:hidden;box-sizing:border-box;background:#000;">
<head>
<meta charset="utf-8">
<style>
* { box-sizing: border-box; }
html, body { margin: 0; overflow: hidden; background: #000; }
body { width: ${w}px; height: ${h}px; }
canvas#canvas { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>
<canvas id="canvas" width="${w}" height="${h}" oncontextmenu="event.preventDefault()" tabindex="0"></canvas>
<script>
var Module = {
  canvas: document.getElementById('canvas'),
  locateFile: function (p) { return ${assetBaseJs} + p },
  print: function (t) { console.log('[wasm]', t) },
  printErr: function (t) { console.error('[wasm]', t) },
  onAbort: function (r) { console.error('[wasm] abort', r) },
  onExit: function (c) { console.warn('[wasm] exit', c) },
}
</script>
<script src="${src}"></script>
<script>
window.addEventListener('load', function () {
  var c = document.getElementById('canvas')
  if (c) c.focus()
})
</script>
</body>
</html>`)
          return
        }

        // Bundled package assets (favicon, etc.)
        if (pathname.startsWith('/_adocserver/')) {
          const rel      = pathname.slice('/_adocserver/'.length)
          const filePath = path.resolve(assetsDir, rel)
          if (filePath.startsWith(assetsDir + path.sep) && existsSync(filePath)) {
            const ext  = path.extname(filePath).toLowerCase()
            const mime = ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream'
            res.setHeader('Content-Type', mime)
            res.setHeader('Cache-Control', 'public, max-age=3600')
            res.end(await fs.readFile(filePath))
            return
          }
          return next()
        }

        // Debug: nav tree as JSON
        if (pathname === `${urlBase}/_nav.json`) {
          const strip = ({ label, href, children }) => ({ label, href, children: children.map(strip) })
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(strip(navRoot), null, 2))
          return
        }

        // Redirect root and any ancestor of urlBase to the docs home.
        // e.g. with urlBase=/adocserver/docs, redirect / and /adocserver/ too.
        const normalPath = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
        const isAncestor = normalPath === '' || urlBase.startsWith(normalPath + '/')
        const isUnderBase = pathname.startsWith(urlBase)
        if (isAncestor && !isUnderBase) {
          res.writeHead(302, { Location: `${urlBase}/` })
          res.end()
          return
        }

        if (!isUnderBase) {
          // Vite internal paths (HMR, module graph, etc.) must pass through.
          if (pathname.startsWith('/@') || pathname.startsWith('/__')) return next()
          // Real static files that exist in docsDir pass through to Vite.
          const staticPath = path.resolve(docsDir, pathname.slice(1))
          if (staticPath.startsWith(docsDir + path.sep) && existsSync(staticPath)) return next()
          // Everything else (missing files, unrecognised paths) → docs home.
          res.writeHead(302, { Location: `${urlBase}/` })
          res.end()
          return
        }

        // A request is doc-shaped if it has no explicit non-.html extension
        // -- i.e. /docs, /docs/, /docs/foo, /docs/foo/, /docs/foo.html.
        // Anything else (e.g. /docs/images/foo.png, /docs/custom.css) is a
        // static asset and must be deferred to Vite. Without this guard the
        // missing-page 404 below would shadow every static asset under /docs.
        const ext = path.extname(pathname)
        const isDocShaped = ext === '' || ext === '.html' || ext === '.adoc'
        if (!isDocShaped) return next()

        try {
          // Resolve custom CSS: explicit config wins, then auto-detect custom.css
          const customCss = explicitCss
            ?? (existsSync(path.resolve(docsDir, 'custom.css')) ? '/custom.css' : null)

          // Resolve template: explicit config wins, then auto-detect template.html
          const templateFile = explicitTemplate
            ?? (existsSync(path.resolve(docsDir, 'template.html')) ? path.resolve(docsDir, 'template.html') : null)
          const templateContent = templateFile ? await fs.readFile(templateFile, 'utf8') : null

          const filePath = hrefToFile(pathname, docsDir, urlBase)
          if (!filePath) {
            // Render a shell-wrapped 404 so the SPA can swap it in (sidebar
            // stays put, scroll position preserved). Without this, the SPA
            // fetch would 404 from Vite's static server with no usable
            // #content-wrap and the client would fall back to a full page
            // navigation -- defeating the SPA model for broken/typo links.
            const escapedPath = pathname
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
            const html = `<h1>Page not found</h1>
<p>No document is registered at <code>${escapedPath}</code>.</p>
<p>The link you followed may contain a typo, or the target file may have been moved or removed. Use the navigation on the left to find what you were looking for, or return to the <a href="${urlBase}/">documentation home</a>.</p>`
            res.statusCode = 404
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(renderPage(html, `Page not found - ${siteTitle}`, pathname, '', navRoot, siteConfig, { customCss, templateContent, urlBase }))
            return
          }

          const rawSource = await fs.readFile(filePath, 'utf8')
          const source    = preprocessWasm(
            path.basename(filePath) === 'index.adoc'
              ? await preprocessIncludes(rawSource, path.dirname(filePath), docsDir, urlBase)
              : rawSource
          )
          const doc  = adoc.load(source, adocOptions(path.dirname(filePath)))
          const html = doc.convert()
          const title = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) ?? [])[1] ?? siteTitle
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(renderPage(html, `${title} — ${siteTitle}`, pathname, '', navRoot, siteConfig, { customCss, templateContent, urlBase }))
        } catch { next() }
      })
    },
  }
}
