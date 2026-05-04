import asciidoctor from 'asciidoctor'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

const adoc = asciidoctor()

// Matches local include:: directives (relative path, no attribute references).
const INCLUDE_RE = /^include::([^{\[\s]+\.adoc)\[([^\]]*)\]\s*$/gm

// ---- Nav tree ----------------------------------------------------------

function fileToHref(file, docsDir) {
  const rel = path.relative(docsDir, file).replace(/\\/g, '/')
  if (path.basename(file) === 'index.adoc') {
    const dir = path.dirname(rel)
    return dir === '.' ? '/docs/' : `/docs/${dir}/`
  }
  return '/docs/' + rel.slice(0, -5)
}

function hrefToFile(pathname, docsDir) {
  let rel = pathname.slice('/docs'.length)
  if (rel === '' || rel === '/') {
    rel = 'index.adoc'
  } else {
    rel = rel.replace(/^\//, '')
    if (rel.endsWith('/')) rel += 'index.adoc'
    else if (!rel.endsWith('.adoc')) rel += '.adoc'
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

function readIncludes(file) {
  if (!existsSync(file)) return []
  const source = readFileSync(file, 'utf8')
  const results = []
  const re = new RegExp(INCLUDE_RE.source, 'gm')
  let m
  while ((m = re.exec(source)) !== null) {
    const childPath = path.resolve(path.dirname(file), m[1])
    if (!existsSync(childPath)) continue
    const label = m[2].trim() || readAdocTitle(childPath, path.basename(m[1], '.adoc'))
    results.push({ filePath: childPath, label })
  }
  return results
}

function buildNavTree(file, docsDir, labelOverride) {
  const label = labelOverride || readAdocTitle(file, path.basename(file, '.adoc'))
  return {
    label,
    href: fileToHref(file, docsDir),
    file,
    children: readIncludes(file).map(inc => buildNavTree(inc.filePath, docsDir, inc.label)),
  }
}

// ---- Preprocessing (index pages only) ----------------------------------

async function preprocessIncludes(source, dir, docsDir) {
  const re = new RegExp(INCLUDE_RE.source, 'gm')
  const matches = [...source.matchAll(re)]
  if (matches.length === 0) return source
  let result = source
  for (const m of matches) {
    const filePath = path.resolve(dir, m[1])
    if (!existsSync(filePath)) continue
    let label = m[2].trim()
    if (!label) {
      try {
        const t = (await fs.readFile(filePath, 'utf8')).match(/^= (.+)$/m)
        label = t ? t[1].trim() : path.basename(m[1], '.adoc')
      } catch { label = path.basename(m[1], '.adoc') }
    }
    result = result.replace(m[0], `link:${fileToHref(filePath, docsDir)}[${label}]`)
  }
  return result
}

// ---- Asciidoc rendering ------------------------------------------------

function extractDocSections(doc) {
  const items = []
  function walk(node, level) {
    for (const s of (node.getSections?.() ?? [])) {
      items.push({ label: s.getTitle(), href: '#' + s.getId(), level })
      walk(s, level + 1)
    }
  }
  walk(doc, 1)
  return items
}

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

function renderSidebar(navRoot, defaultLanding, currentPath, toc, siteTitle, logo) {
  function isActive(href) {
    return href.endsWith('/')
      ? currentPath === href || currentPath === href.slice(0, -1)
      : currentPath === href
  }

  function hasActiveChild(node) {
    return node.children.some(c => isActive(c.href) || hasActiveChild(c))
  }

  function tocBlock() {
    if (!toc.length) return ''
    return '<div class="toc-items">' + toc.map(t =>
      `<a href="${t.href}" class="nav-sublink toc-item toc-l${t.level}">${t.label}</a>`
    ).join('') + '</div>'
  }

  function renderNode(node, depth) {
    const active  = isActive(node.href)
    const anyOpen = active || hasActiveChild(node)

    if (node.children.length === 0) {
      return `<a href="${node.href}" class="nav-sublink${active ? ' active' : ''}">${node.label}</a>`
        + (active ? tocBlock() : '')
    }

    const cls      = depth === 1 ? 'nav-link' : 'nav-sublink'
    const nameAttr = depth === 1 ? ' name="adocserver-nav"' : ''
    const children = [
      `<a href="${node.href}" class="nav-sublink${active ? ' active' : ''}">Overview</a>`,
      ...(active ? [tocBlock()] : []),
      ...node.children.map(c => renderNode(c, depth + 1)),
    ].join('\n')

    return `<details class="nav-group"${anyOpen ? ' open' : ''}${nameAttr}>
      <summary class="${cls}${anyOpen ? ' active' : ''}">${node.label} <span class="nav-caret">▾</span></summary>
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
    <a class="site-brand" href="${defaultLanding}">
      ${brand}
    </a>
    <nav class="site-nav">
      ${items}
    </nav>
  </aside>
  <div class="sidebar-resizer" id="sidebar-resizer" title="Drag to resize"></div>`
}

// ---- Page shell --------------------------------------------------------

function renderPage(bodyHtml, title, currentPath, toc, navRoot, defaultLanding, siteConfig) {
  const { siteTitle, logo, accent, accentStrong } = siteConfig
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
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
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css" />
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

      .nav-caret { font-size: .7em; opacity: .6; margin-left: auto; transition: transform .15s; }
      details.nav-group[open] > summary .nav-caret { transform: rotate(180deg); }

      summary.nav-link, summary.nav-sublink {
        list-style: none; cursor: pointer; user-select: none;
      }
      summary.nav-link::-webkit-details-marker,
      summary.nav-sublink::-webkit-details-marker { display: none; }
      summary.nav-link::marker,
      summary.nav-sublink::marker { content: ''; }

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

      /* ---- inline TOC under active page ---- */
      .toc-items { display: flex; flex-direction: column; gap: .0625rem; padding: .125rem 0 .25rem 0; }
      .toc-item { font-size: .8rem; white-space: normal; line-height: 1.35; }
      .toc-item.toc-l1 { padding-left: 1rem; }
      .toc-item.toc-l2 { padding-left: 1.875rem; }
      .toc-item.toc-l3 { padding-left: 2.75rem; }
      .toc-item.toc-l4 { padding-left: 3.625rem; }

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
    </style>
  </head>
  <body>
    ${renderSidebar(navRoot, defaultLanding, currentPath, toc, siteTitle, logo)}
    <main class="site-main">
      <div id="content-wrap">
        ${bodyHtml}
      </div>
    </main>
    <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>
    <script>window.hljs?.highlightAll()</script>
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
    </script>
  </body>
</html>`
}

// ---- Vite plugin -------------------------------------------------------

export function createAdocPlugin({ docsDir, assetsDir, config }) {
  const siteTitle    = config.title        ?? 'Docs'
  const accent       = config.accent       ?? '#a81d2d'
  const accentStrong = config.accentStrong ?? '#7f1321'
  const logo         = config.logo         ?? null

  const siteConfig = { siteTitle, logo, accent, accentStrong }
  const DOCS_INDEX = path.resolve(docsDir, 'index.adoc')

  let navRoot, defaultLanding

  function rebuildNav() {
    navRoot        = buildNavTree(DOCS_INDEX, docsDir)
    defaultLanding = navRoot.children[0]?.href ?? '/docs/'
  }

  rebuildNav()

  return {
    name: 'adocserver',

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next()
        const pathname = new URL(req.url, 'http://localhost').pathname

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
        if (pathname === '/docs/_nav.json') {
          const strip = ({ label, href, children }) => ({ label, href, children: children.map(strip) })
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(strip(navRoot), null, 2))
          return
        }

        // Redirect root → first top-level section
        if (pathname === '/' || pathname === '/docs' || pathname === '/docs/') {
          res.writeHead(302, { Location: defaultLanding })
          res.end()
          return
        }

        if (!pathname.startsWith('/docs')) return next()

        const filePath = hrefToFile(pathname, docsDir)
        if (!filePath) return next()

        try {
          const rawSource = await fs.readFile(filePath, 'utf8')
          const source    = path.basename(filePath) === 'index.adoc'
            ? await preprocessIncludes(rawSource, path.dirname(filePath), docsDir)
            : rawSource
          const doc  = adoc.load(source, adocOptions(path.dirname(filePath)))
          const html = doc.convert()
          const toc  = extractDocSections(doc)
          const title = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) ?? [])[1] ?? siteTitle
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(renderPage(html, `${title} — ${siteTitle}`, pathname, toc, navRoot, defaultLanding, siteConfig))
        } catch { next() }
      })
    },

    handleHotUpdate({ file, server }) {
      if (file.endsWith('.adoc') && file.startsWith(docsDir + path.sep)) {
        rebuildNav()
        server.ws.send({ type: 'full-reload' })
      }
    },
  }
}
