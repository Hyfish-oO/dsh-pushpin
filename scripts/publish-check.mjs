/**
 * Release gate. Run with `node scripts/publish-check.mjs` before `npm publish`.
 *
 * It does not publish anything: it checks the things that are easy to forget
 * and embarrassing to ship — a version missing from the changelog, a
 * placeholder repository URL, a file the manifest promises but the directory
 * does not have.
 */

import { readFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const problems = []
const notes = []

if (manifest.private === true) problems.push('package.json still has "private": true')
if (typeof manifest.license !== 'string' || manifest.license === '') problems.push('package.json has no license')

const repositoryUrl = manifest.repository && manifest.repository.url ? manifest.repository.url : ''
if (repositoryUrl === '') problems.push('package.json has no repository.url')
else if (/USERNAME|your-name|example\.com/i.test(repositoryUrl)) {
  problems.push('repository.url still looks like a placeholder: ' + repositoryUrl)
}

const required = ['README.md', 'CHANGELOG.md', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'scripts/pin-server.ps1', 'locale/en.json']
for (const relative of required) {
  try {
    await access(join(ROOT, relative))
  } catch {
    problems.push('missing declared file: ' + relative)
  }
}

let changelog = ''
try {
  changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8')
} catch {
  problems.push('missing CHANGELOG.md')
}
if (changelog !== '' && changelog.indexOf(manifest.version) === -1) {
  problems.push('CHANGELOG.md has no entry for version ' + manifest.version)
}

if (manifest.files && manifest.files.indexOf('README.md') === -1) notes.push('README.md is not in "files"; npm includes it anyway')
if (manifest.scripts && manifest.scripts.test === undefined) notes.push('no "test" script')

console.log('[publish-check] ' + manifest.name + '@' + manifest.version)
for (const note of notes) console.log('  note: ' + note)

if (problems.length > 0) {
  for (const problem of problems) console.error('  FAIL: ' + problem)
  console.error('[publish-check] ' + problems.length + ' problem(s); not ready to publish')
  process.exit(1)
}

console.log('[publish-check] ok — next: npm test && npm publish')
