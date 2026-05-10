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

test('preprocessIncludes: index page links use the included file title, not bracket attributes', async () => {
  const root = mkDocsTree({
    'lib/index.adoc': '= GA Library\n\nBody.\n',
  })
  const source = '= Top\n\ninclude::lib/index.adoc[leveloffset=+1]\n'

  const out = await preprocessIncludes(source, root, root)

  assert.match(out, /\* link:[^\[]+\[GA Library\]/, `expected "[GA Library]" link, got:\n${out}`)
  assert.doesNotMatch(out, /\[leveloffset=\+1\]/, `must not emit "[leveloffset=+1]" as the link label`)
})
