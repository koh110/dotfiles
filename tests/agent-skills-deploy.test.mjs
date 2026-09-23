import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SkillDeployConflictError,
  deploySkillsSnapshot,
  reconcileRuntimeSkills,
} from '../lib/agent-skills.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dotfiles-agent-skills-'))
  const sourceDir = join(root, 'source')
  const targetDir = join(root, '.agents', 'skills')
  const manifestPath = join(root, '.agents', '.dotfiles-skills-manifest.json')
  await mkdir(join(sourceDir, 'example'), { recursive: true })
  await writeFile(join(sourceDir, 'README.md'), '# skills\n')
  await writeFile(join(sourceDir, 'example', 'SKILL.md'), '# v1\n')
  return { root, sourceDir, targetDir, manifestPath }
}

test('snapshot deploy preserves unrelated skills and accepts source updates', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))

  await mkdir(join(f.targetDir, 'third-party'), { recursive: true })
  await writeFile(join(f.targetDir, 'third-party', 'SKILL.md'), '# keep\n')

  await deploySkillsSnapshot(f)
  assert.equal(await readFile(join(f.targetDir, 'example', 'SKILL.md'), 'utf8'), '# v1\n')
  assert.equal(await readFile(join(f.targetDir, 'third-party', 'SKILL.md'), 'utf8'), '# keep\n')
  await assert.rejects(() => lstat(join(f.targetDir, 'README.md')), /ENOENT/)

  await writeFile(join(f.sourceDir, 'example', 'SKILL.md'), '# v2\n')
  await deploySkillsSnapshot(f)
  assert.equal(await readFile(join(f.targetDir, 'example', 'SKILL.md'), 'utf8'), '# v2\n')
  assert.equal(await readFile(join(f.targetDir, 'third-party', 'SKILL.md'), 'utf8'), '# keep\n')
})

test('snapshot deploy fails closed on installed edits unless forced', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))

  await deploySkillsSnapshot(f)
  await writeFile(join(f.targetDir, 'example', 'SKILL.md'), '# local edit\n')
  await writeFile(join(f.sourceDir, 'example', 'SKILL.md'), '# v2\n')

  await assert.rejects(
    () => deploySkillsSnapshot(f),
    (error) => error instanceof SkillDeployConflictError
  )
  assert.equal(await readFile(join(f.targetDir, 'example', 'SKILL.md'), 'utf8'), '# local edit\n')

  await deploySkillsSnapshot({ ...f, force: true })
  assert.equal(await readFile(join(f.targetDir, 'example', 'SKILL.md'), 'utf8'), '# v2\n')
})

test('runtime cleanup removes managed legacy copy and preserves unrelated skill', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await deploySkillsSnapshot(f)

  const runtimeSkillsDir = join(f.root, '.codex', 'skills')
  await mkdir(join(runtimeSkillsDir, 'example'), { recursive: true })
  await mkdir(join(runtimeSkillsDir, 'other'), { recursive: true })
  await writeFile(join(runtimeSkillsDir, 'example', 'SKILL.md'), '# stale legacy\n')
  await writeFile(join(runtimeSkillsDir, 'other', 'SKILL.md'), '# keep\n')

  await reconcileRuntimeSkills({
    canonicalDir: f.targetDir,
    runtimeSkillsDir,
    mode: 'remove',
    replaceRealEntries: true,
  })

  await assert.rejects(() => lstat(join(runtimeSkillsDir, 'example')), /ENOENT/)
  assert.equal(await readFile(join(runtimeSkillsDir, 'other', 'SKILL.md'), 'utf8'), '# keep\n')
})

test('Claude migration replaces managed copy with symlink to canonical snapshot', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await deploySkillsSnapshot(f)

  const runtimeSkillsDir = join(f.root, '.claude', 'skills')
  await mkdir(join(runtimeSkillsDir, 'example'), { recursive: true })
  await writeFile(join(runtimeSkillsDir, 'example', 'SKILL.md'), '# v1\n')

  await reconcileRuntimeSkills({
    canonicalDir: f.targetDir,
    runtimeSkillsDir,
    mode: 'symlink',
  })

  const stat = await lstat(join(runtimeSkillsDir, 'example'))
  assert.equal(stat.isSymbolicLink(), true)
  assert.equal(
    await realpath(join(runtimeSkillsDir, 'example')),
    await realpath(join(f.targetDir, 'example')),
  )
})


test('remove mode does not create an empty legacy runtime directory', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  await deploySkillsSnapshot(f)

  const runtimeSkillsDir = join(f.root, '.copilot', 'skills')
  await reconcileRuntimeSkills({
    canonicalDir: f.targetDir,
    runtimeSkillsDir,
    mode: 'remove',
    replaceRealEntries: true,
  })

  await assert.rejects(() => lstat(runtimeSkillsDir), /ENOENT/)
})
