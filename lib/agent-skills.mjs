import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

export class SkillDeployConflictError extends Error {
  constructor(conflicts) {
    super('skill deployment conflicts detected')
    this.name = 'SkillDeployConflictError'
    this.conflicts = conflicts
  }
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function signature(path) {
  const stat = await lstat(path)
  if (stat.isDirectory()) return 'dir'
  if (stat.isSymbolicLink()) return 'link:' + await readlink(path)
  if (stat.isFile()) {
    const hash = createHash('sha256').update(await readFile(path)).digest('hex')
    return 'file:' + hash
  }
  throw new Error(`unsupported skill artifact: ${path}`)
}

async function snapshotPath(path, rel, out) {
  out[rel] = await signature(path)
  const stat = await lstat(path)
  if (!stat.isDirectory()) return

  const entries = await readdir(path, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    await snapshotPath(join(path, entry.name), join(rel, entry.name), out)
  }
}

async function snapshotEntries(root, names) {
  const out = {}
  for (const name of [...names].sort()) {
    const path = join(root, name)
    if (await exists(path)) await snapshotPath(path, name, out)
  }
  return out
}

async function topLevelSkillEntries(root) {
  const names = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await exists(join(root, entry.name, 'SKILL.md'))) {
      names.push(entry.name)
    }
  }
  return names.sort()
}

async function readManifest(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (
      parsed?.version !== 1 ||
      !Array.isArray(parsed.entries) ||
      typeof parsed.paths !== 'object' ||
      parsed.paths === null
    ) {
      throw new Error(`invalid skill deploy manifest: ${path}`)
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: 1, entries: [], paths: {} }
    }
    throw error
  }
}

function detectConflicts(source, target, previous) {
  const conflicts = []
  const paths = new Set([
    ...Object.keys(source),
    ...Object.keys(target),
    ...Object.keys(previous),
  ])

  for (const path of [...paths].sort()) {
    const src = source[path]
    const dst = target[path]
    const prev = previous[path]

    if (dst === undefined) continue
    if (prev !== undefined && dst === prev) continue
    if (src !== undefined && dst === src) continue

    conflicts.push({
      path,
      reason: prev === undefined && src === undefined
        ? 'managed skill directory contains an unmanaged artifact'
        : 'installed snapshot was modified outside deploy',
    })
  }

  return conflicts
}

export async function inspectSkillsSnapshot({
  sourceDir,
  targetDir,
  manifestPath,
}) {
  const currentEntries = await topLevelSkillEntries(sourceDir)
  const previous = await readManifest(manifestPath)
  const managedEntries = new Set([...currentEntries, ...previous.entries])
  const source = await snapshotEntries(sourceDir, currentEntries)
  const target = await snapshotEntries(targetDir, managedEntries)
  const conflicts = detectConflicts(source, target, previous.paths)

  return {
    conflicts,
    currentEntries,
    source,
    previous,
  }
}

export async function deploySkillsSnapshot({
  sourceDir,
  targetDir,
  manifestPath,
  force = false,
  check = false,
}) {
  const state = await inspectSkillsSnapshot({ sourceDir, targetDir, manifestPath })

  if (state.conflicts.length > 0 && !force) {
    throw new SkillDeployConflictError(state.conflicts)
  }
  if (check) return state

  const parent = dirname(targetDir)
  const currentEntries = new Set(state.currentEntries)
  const removedEntries = state.previous.entries.filter((name) => !currentEntries.has(name))

  await mkdir(parent, { recursive: true })
  if (await exists(targetDir)) {
    const targetStat = await lstat(targetDir)
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`skill install root must be a real directory: ${targetDir}`)
    }
  } else {
    await mkdir(targetDir, { recursive: true })
  }

  // package単位でmaterializeしてから置き換える。途中で停止しても、各packageは
  // previous manifest またはcurrent sourceのどちらかに一致するため次回deployで回復できる。
  for (const name of state.currentEntries) {
    const source = join(sourceDir, name)
    const target = join(targetDir, name)
    const next = join(targetDir, `.${name}.dotfiles-next-${process.pid}`)
    await rm(next, { recursive: true, force: true })
    await cp(source, next, { recursive: true })
    await rm(target, { recursive: true, force: true })
    await rename(next, target)
  }

  for (const name of removedEntries) {
    await rm(join(targetDir, name), { recursive: true, force: true })
  }

  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    entries: state.currentEntries,
    paths: state.source,
  }, null, 2) + '\n')

  return state
}

async function sameTree(a, b) {
  if (!await exists(a) || !await exists(b)) return false
  const left = {}
  const right = {}
  await snapshotPath(a, '.', left)
  await snapshotPath(b, '.', right)

  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  if (leftEntries.length !== rightEntries.length) return false

  return leftEntries.every(([path, value]) => right[path] === value)
}

async function pointsTo(linkPath, expectedPath) {
  const stat = await lstat(linkPath)
  if (!stat.isSymbolicLink()) return false
  const target = await readlink(linkPath)
  return resolve(dirname(linkPath), target) === resolve(expectedPath)
}

async function skillNames(canonicalDir) {
  return topLevelSkillEntries(canonicalDir)
}

export async function reconcileRuntimeSkills({
  canonicalDir,
  runtimeSkillsDir,
  mode,
  force = false,
  replaceRealEntries = false,
  check = false,
}) {
  const conflicts = []
  const changes = []
  const names = await skillNames(canonicalDir)

  if (await exists(runtimeSkillsDir)) {
    const rootStat = await lstat(runtimeSkillsDir)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`runtime skill root must be a real directory: ${runtimeSkillsDir}`)
    }
  } else if (!check && mode === 'symlink') {
    await mkdir(runtimeSkillsDir, { recursive: true })
  } else if (mode === 'remove') {
    return { conflicts, changes }
  }

  for (const name of names) {
    const expected = join(canonicalDir, name)
    const actual = join(runtimeSkillsDir, name)

    if (!await exists(actual)) {
      if (mode === 'symlink') {
        changes.push({ path: actual, action: 'create-symlink' })
        if (!check) await symlink(expected, actual, 'dir')
      }
      continue
    }

    const stat = await lstat(actual)
    if (stat.isSymbolicLink()) {
      const correct = await pointsTo(actual, expected)
      if (mode === 'symlink' && correct) continue
      if (!correct && !force) {
        conflicts.push({ path: actual, reason: 'existing symlink points to another target' })
        continue
      }

      changes.push({ path: actual, action: mode === 'symlink' ? 'replace-symlink' : 'remove-legacy' })
      if (!check) {
        await rm(actual, { force: true })
        if (mode === 'symlink') await symlink(expected, actual, 'dir')
      }
      continue
    }

    const identical = await sameTree(actual, expected)
    if (!identical && !replaceRealEntries && !force) {
      conflicts.push({ path: actual, reason: 'legacy runtime skill differs from canonical snapshot' })
      continue
    }

    changes.push({ path: actual, action: mode === 'symlink' ? 'replace-with-symlink' : 'remove-legacy' })
    if (!check) {
      await rm(actual, { recursive: true, force: true })
      if (mode === 'symlink') await symlink(expected, actual, 'dir')
    }
  }

  if (conflicts.length > 0 && !force) {
    throw new SkillDeployConflictError(conflicts)
  }

  return { conflicts, changes }
}


async function listFiles(dir, { includeSymlinks = true } = {}) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return out
    throw error
  }

  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await listFiles(path, { includeSymlinks }))
    } else if (entry.isFile() || (includeSymlinks && entry.isSymbolicLink())) {
      out.push(path)
    }
  }
  return out
}

async function hashFile(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch {
    return null
  }
}

async function readJsonObject(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

async function claudeLegacyEntries(sourceDir, homeDir) {
  const entries = []
  for (const file of await listFiles(sourceDir)) {
    const rel = join('skills', relative(sourceDir, file))
    entries.push({
      rel,
      src: file,
      dst: join(homeDir, '.claude', rel),
    })
  }
  return entries
}

async function detectClaudeLegacyDrift(sourceDir, homeDir) {
  const manifestPath = join(homeDir, '.claude', '.deploy-manifest.json')
  const manifest = await readJsonObject(manifestPath)
  const entries = await claudeLegacyEntries(sourceDir, homeDir)
  const drift = []

  for (const entry of entries) {
    const dstHash = await hashFile(entry.dst)
    if (dstHash === null) continue
    const srcHash = await hashFile(entry.src)
    if (dstHash === srcHash) continue

    const recorded = manifest[entry.rel]
    if (recorded !== undefined) {
      if (dstHash !== recorded) {
        drift.push({
          path: entry.dst,
          reason: 'legacy Claude skill was modified after the previous deploy',
        })
      }
    } else {
      drift.push({
        path: entry.dst,
        reason: 'legacy Claude skill differs from source and is not recorded in the manifest',
      })
    }
  }

  const sourceRels = new Set(entries.map((entry) => entry.rel))
  const legacySkillsDir = join(homeDir, '.claude', 'skills')

  // Correct canonical symlinks are the post-migration state, not legacy files.
  // Only inspect real files under old copied skill directories here.
  for (const file of await listFiles(legacySkillsDir, { includeSymlinks: false })) {
    const rel = join('skills', relative(legacySkillsDir, file))
    if (sourceRels.has(rel)) continue

    const currentHash = await hashFile(file)
    const recorded = manifest[rel]
    if (recorded === undefined) {
      drift.push({
        path: file,
        reason: 'legacy Claude skills contain an unmanaged file',
      })
    } else if (currentHash !== recorded) {
      drift.push({
        path: file,
        reason: 'source removed this file but the legacy deployed copy was modified',
      })
    }
  }

  return drift
}

async function clearClaudeSkillManifest(homeDir) {
  const manifestPath = join(homeDir, '.claude', '.deploy-manifest.json')
  const manifest = await readJsonObject(manifestPath)
  let changed = false

  for (const key of Object.keys(manifest)) {
    if (key === 'skills' || key.startsWith('skills/') || key.startsWith('skills\\')) {
      delete manifest[key]
      changed = true
    }
  }

  if (changed) {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
}

function reportConflicts(title, conflicts) {
  console.error(title)
  for (const conflict of conflicts) {
    console.error(`  ${conflict.path}: ${conflict.reason}`)
  }
  console.error('')
  console.error('source of truth は dotfiles/skills です。残す変更はsourceへ反映し、')
  console.error('破棄してよい変更だけ --force で上書きしてください。')
}

async function reconcileClaudeSkills({
  sourceDir,
  canonicalDir,
  homeDir,
  force,
  check,
}) {
  const drift = await detectClaudeLegacyDrift(sourceDir, homeDir)
  if (drift.length > 0 && !force) {
    reportConflicts('claude legacy skill drift detected:', drift)
    return false
  }

  try {
    await reconcileRuntimeSkills({
      canonicalDir,
      runtimeSkillsDir: join(homeDir, '.claude', 'skills'),
      mode: 'symlink',
      force,
      replaceRealEntries: true,
      check,
    })
  } catch (error) {
    if (error instanceof SkillDeployConflictError) {
      reportConflicts('claude skill migration conflict:', error.conflicts)
      return false
    }
    throw error
  }

  if (check) {
    console.log('claude deploy: no drift')
  } else {
    await clearClaudeSkillManifest(homeDir)
    console.log('link: ~/.claude/skills/* -> ~/.agents/skills/*')
  }
  return true
}

async function reconcileNativeRuntimeSkills(canonicalDir, homeDir, runtime) {
  await reconcileRuntimeSkills({
    canonicalDir,
    runtimeSkillsDir: join(homeDir, `.${runtime}`, 'skills'),
    mode: 'remove',
    force: true,
    replaceRealEntries: true,
  })
  console.log(`skills: ${runtime} uses ~/.agents/skills`)
}

export async function deployAgentSkills({
  sourceDir,
  homeDir,
  runtimes,
  force = false,
  check = false,
}) {
  const agentsRoot = join(homeDir, '.agents')
  const canonicalDir = join(agentsRoot, 'skills')
  const manifestPath = join(agentsRoot, '.dotfiles-skills-manifest.json')

  try {
    await deploySkillsSnapshot({
      sourceDir,
      targetDir: canonicalDir,
      manifestPath,
      force,
      check,
    })
  } catch (error) {
    if (error instanceof SkillDeployConflictError) {
      reportConflicts(
        check ? 'agent skills drift detected:' : 'agent skills deploy conflict:',
        error.conflicts,
      )
      return false
    }
    throw error
  }

  if (!check) {
    console.log('copy: agent skills -> ~/.agents/skills')
  }

  for (const runtime of runtimes) {
    if (runtime === 'claude') {
      if (!await reconcileClaudeSkills({
        sourceDir,
        canonicalDir,
        homeDir,
        force,
        check,
      })) {
        return false
      }
      continue
    }

    if (runtime === 'codex' || runtime === 'copilot') {
      if (!check) await reconcileNativeRuntimeSkills(canonicalDir, homeDir, runtime)
      continue
    }

    throw new Error(`unsupported agent skill runtime: ${runtime}`)
  }

  return true
}
