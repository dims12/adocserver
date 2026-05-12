import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildNavTree, preprocessIncludes } from '../../src/plugin.js'

function mkDocsTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adocserver-test-'))
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, contents)
  }
  return root
}

function findLabels(node, acc = []) {
  acc.push(node.label)
  for (const child of node.children ?? []) findLabels(child, acc)
  return acc
}

test('buildNavTree: include with [leveloffset=+1] uses the included file title, not the bracket attributes', () => {
  // Reproduces the bug seen in manyfold2/docs/libs/index.adoc, where
  //   include::ga/index.adoc[leveloffset=+1]
  // produced a TOC entry literally labeled "leveloffset=+1". The brackets
  // carry asciidoctor include attributes -- not a label override -- so the
  // nav label must come from the included file's "= Title" heading.
  const root = mkDocsTree({
    'index.adoc': [
      '= Top',
      '',
      '== API Reference',
      '',
      'include::lib/index.adoc[leveloffset=+1]',
      '',
    ].join('\n'),
    'lib/index.adoc': [
      '= GA Library',
      '',
      '== Requirements',
      '',
      'Body.',
    ].join('\n'),
  })

  const tree = buildNavTree(path.join(root, 'index.adoc'), root)
  const labels = findLabels(tree)

  assert.ok(
    !labels.some(l => /^[\w-]+\s*=/.test(l)),
    `no nav label may look like an asciidoctor attribute (got: ${JSON.stringify(labels)})`,
  )
  assert.ok(
    labels.includes('GA Library'),
    `nav must contain the included file's title (got: ${JSON.stringify(labels)})`,
  )
  assert.ok(
    !labels.includes('leveloffset=+1'),
    `nav must not contain raw bracket content as a label (got: ${JSON.stringify(labels)})`,
  )
})

test('buildNavTree: include with empty brackets still uses the included file title', () => {
  const root = mkDocsTree({
    'index.adoc': '= Top\n\ninclude::child.adoc[]\n',
    'child.adoc': '= Child Title\n\nBody.\n',
  })

  const tree = buildNavTree(path.join(root, 'index.adoc'), root)
  const labels = findLabels(tree)

  assert.ok(
    labels.includes('Child Title'),
    `expected "Child Title" in labels (got: ${JSON.stringify(labels)})`,
  )
})

test('buildNavTree: include attributes other than leveloffset (lines=, tag=) are also not labels', () => {
  const root = mkDocsTree({
    'index.adoc': [
      '= Top',
      '',
      'include::child.adoc[lines=1..3]',
      'include::other.adoc[tag=foo]',
      '',
    ].join('\n'),
    'child.adoc': '= Child One\n\nBody.\n',
    'other.adoc': '= Child Two\n\nBody.\n',
  })

  const tree = buildNavTree(path.join(root, 'index.adoc'), root)
  const labels = findLabels(tree)

  assert.ok(labels.includes('Child One'),  `expected "Child One" (got: ${JSON.stringify(labels)})`)
  assert.ok(labels.includes('Child Two'),  `expected "Child Two" (got: ${JSON.stringify(labels)})`)
  assert.ok(!labels.includes('lines=1..3'), `bracket attrs must not become labels`)
  assert.ok(!labels.includes('tag=foo'),    `bracket attrs must not become labels`)
})

test('buildNavTree: section titles with inline markup (backticks, xref) are rendered to plain text and get a working anchor href', () => {
  // Reproduces the bug seen in manyfold2/docs/libs/ga/index.adoc, where
  //   === `signature.hpp`  →  xref:signature.adoc[detail]
  // showed up in the TOC with the literal source text including the xref
  // markup, AND was not navigable (href had no #anchor) -- because the nav
  // builder was matching raw source titles against asciidoctor's
  // HTML-rendered titles, which never matched, so the section id lookup
  // missed.
  const root = mkDocsTree({
    'index.adoc': [
      '= Top',
      '',
      '== Entities',
      '',
      '=== `signature.hpp`  ->  xref:signature.adoc[detail]',
      '',
      'Body.',
      '',
      '=== `multivector.hpp`  ->  xref:multivector.adoc[detail]',
      '',
      'Body.',
    ].join('\n'),
    'signature.adoc': '= Signature\n\nBody.\n',
    'multivector.adoc': '= Multivector\n\nBody.\n',
  })

  const tree = buildNavTree(path.join(root, 'index.adoc'), root)

  // Find the Entities node and inspect its children.
  const entities = tree.children.find(c => c.label === 'Entities')
  assert.ok(entities, `expected an "Entities" section, got ${JSON.stringify(tree.children.map(c => c.label))}`)
  const childLabels = entities.children.map(c => c.label)

  for (const label of childLabels) {
    assert.doesNotMatch(label, /xref:/,    `nav label must not contain raw "xref:" markup (got: ${JSON.stringify(label)})`)
    assert.doesNotMatch(label, /\[detail\]/, `nav label must not contain raw "[detail]" markup (got: ${JSON.stringify(label)})`)
    assert.doesNotMatch(label, /^`|`$/,      `nav label must not contain raw backticks (got: ${JSON.stringify(label)})`)
  }

  for (const child of entities.children) {
    assert.match(
      child.href,
      /#./,
      `section nav entry must have a non-empty #anchor (got: ${JSON.stringify(child.href)} for label ${JSON.stringify(child.label)})`,
    )
  }

  // And the cleaned labels should preserve the readable text content.
  assert.ok(childLabels.some(l => l.includes('signature.hpp')), `expected a label mentioning "signature.hpp" (got: ${JSON.stringify(childLabels)})`)
  assert.ok(childLabels.some(l => l.includes('multivector.hpp')), `expected a label mentioning "multivector.hpp" (got: ${JSON.stringify(childLabels)})`)
})

test('buildNavTree: [discrete] sections are excluded from the nav (they are headings, not sections)', () => {
  // Reproduces the manyfold2/docs/libs/ga/index.adoc bug. That file has
  // [discrete] === Scope / Mathematical model / ... headings inside its
  // == Requirements section. Discrete headings render visually as headings
  // but are NOT part of the document's section hierarchy -- asciidoctor's
  // section walker correctly excludes them. Our raw-source regex used to
  // pick them up anyway, then the 1-to-1 pairing with the asciidoctor
  // pass misaligned everything: real sections got the wrong labels and
  // anchors, descendant nesting broke, and trailing events fell off the
  // parsed list and got "index" (the file basename) as a fallback label.
  const root = mkDocsTree({
    'index.adoc': [
      '= Top',
      '',
      '== Section A',
      '',
      '[discrete]',
      '=== Discrete inside A 1',
      '',
      'Body.',
      '',
      '[discrete]',
      '=== Discrete inside A 2',
      '',
      'Body.',
      '',
      '== Section B',
      '',
      '=== Real subsection of B',
      '',
      'Body.',
      '',
      '=== Another real subsection of B',
      '',
      'Body.',
    ].join('\n'),
  })

  const tree = buildNavTree(path.join(root, 'index.adoc'), root)
  const labels = findLabels(tree)

  assert.ok(labels.includes('Section A'),                   `expected "Section A" (got ${JSON.stringify(labels)})`)
  assert.ok(labels.includes('Section B'),                   `expected "Section B" (got ${JSON.stringify(labels)})`)
  assert.ok(labels.includes('Real subsection of B'),        `expected "Real subsection of B" (got ${JSON.stringify(labels)})`)
  assert.ok(labels.includes('Another real subsection of B'),`expected "Another real subsection of B" (got ${JSON.stringify(labels)})`)

  assert.ok(!labels.includes('Discrete inside A 1'), `[discrete] heading must not appear in nav`)
  assert.ok(!labels.includes('Discrete inside A 2'), `[discrete] heading must not appear in nav`)
  assert.ok(!labels.includes('index'),               `phantom "index" labels must not appear (was the symptom of misaligned pairing)`)

  const sectionA = tree.children.find(c => c.label === 'Section A')
  assert.ok(sectionA, `Section A should be a top-level child`)
  assert.deepEqual(sectionA.children.map(c => c.label), [],
    `Section A should have NO nav children -- its only headings are [discrete]`)

  const sectionB = tree.children.find(c => c.label === 'Section B')
  assert.ok(sectionB, `Section B should be a top-level child`)
  assert.deepEqual(
    sectionB.children.map(c => c.label),
    ['Real subsection of B', 'Another real subsection of B'],
    `Section B should hold its two real === subsections in order`,
  )

  // And the anchors should be working (non-empty #fragment).
  for (const node of [sectionA, sectionB, ...sectionB.children]) {
    assert.match(node.href, /#./, `${JSON.stringify(node.label)} must have a working #anchor (got ${JSON.stringify(node.href)})`)
  }
})

test('preprocessIncludes: index page links use the included file title, not bracket attributes', async () => {
  const root = mkDocsTree({
    'lib/index.adoc': '= GA Library\n\nBody.\n',
  })
  const source = '= Top\n\ninclude::lib/index.adoc[leveloffset=+1]\n'

  const out = await preprocessIncludes(source, root, root)

  assert.match(out, /\* link:[^\[]+\[GA Library\]/, `expected "[GA Library]" link, got:\n${out}`)
  assert.doesNotMatch(out, /\[leveloffset=\+1\]/, `must not emit "[leveloffset=+1]" as the link label`)
})

test('buildNavTree: include path with spaces and non-ASCII characters is matched', () => {
  const root = mkDocsTree({
    'index.adoc': '= Top\n\ninclude::10 Понятия и антиморфизмы/index.adoc[]\n',
    '10 Понятия и антиморфизмы/index.adoc': '= Понятия\n\nBody.\n',
  })

  const tree = buildNavTree(path.join(root, 'index.adoc'), root)
  const labels = findLabels(tree)

  assert.ok(labels.includes('Понятия'), `nav must include the Cyrillic child title (got: ${JSON.stringify(labels)})`)
})

test('preprocessIncludes: include path with spaces produces a percent-encoded link URL', async () => {
  const root = mkDocsTree({
    '15 Учебник/index.adoc': '= Учебник\n\nBody.\n',
  })
  const source = '= Top\n\ninclude::15 Учебник/index.adoc[]\n'

  const out = await preprocessIncludes(source, root, root)

  assert.doesNotMatch(out, /link:[^\[]*[ \t][^\[]*\[/, `link URL must not contain unencoded spaces (got:\n${out})`)
  assert.match(out, /\* link:[^\[]+\[Учебник\]/, `expected "[Учебник]" link, got:\n${out}`)
})
