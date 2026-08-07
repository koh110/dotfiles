#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const usage = `Usage:
  change-target-gate discover --repo <path> --query <terms>
  change-target-gate verify --policy <path> --manifest <path> [--base <ref>]
`

function fail(code, errors) {
  process.stderr.write(JSON.stringify({ ok: false, errors }, null, 2) + '\n')
  process.exitCode = code
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message
    throw new Error(`git ${args.join(' ')}: ${detail}`)
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let i = 0; i < rest.length; i += 1) {
    const value = rest[i]
    if (!value.startsWith('--')) throw new Error(`unexpected argument: ${value}`)
    const key = value.slice(2)
    if (key === 'help') options.help = true
    else options[key] = rest[++i]
  }
  return { command, options }
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'))
}

function canonicalRepository(url) {
  const value = url.trim().replace(/\.git$/, '')
  const scp = value.match(/^git@([^:]+):(.+)$/)
  if (scp) return scp[1] === 'github.com' ? scp[2] : `${scp[1]}/${scp[2]}`
  try {
    const parsed = new URL(value)
    const path = parsed.pathname.replace(/^\/+/, '')
    return parsed.hostname === 'github.com' ? path : `${parsed.hostname}/${path}`
  } catch {
    return value
  }
}

function repositoryForRepo(repo) {
  try {
    return canonicalRepository(git(['remote', 'get-url', 'origin'], repo))
  } catch {
    return null
  }
}

function existsAtRef(cwd, ref, path) {
  try {
    git(['cat-file', '-e', `${ref}:${path}`], cwd)
    return true
  } catch {
    return false
  }
}

function validateRelativePath(path) {
  const normalized = path.replaceAll('\\', '/')
  return normalized !== '' && !normalized.startsWith('/') && normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../')
}

function discover(repo, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const candidates = []
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'SKILL.md') {
        const rel = relative(repo, path).replaceAll('\\', '/')
        const content = readFileSync(path, 'utf8').toLowerCase()
        const score = terms.reduce((sum, term) => sum + (rel.toLowerCase().includes(term) ? 3 : 0) + (content.includes(term) ? 1 : 0), 0)
        if (score > 0) candidates.push({ path: rel, score })
      }
    }
  }
  walk(repo)
  return candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
}

function verify(repo, policyPath, manifestPath, baseOverride) {
  const policy = readJson(policyPath)
  const manifest = readJson(manifestPath)
  const errors = []
  if (policy.version !== 1 || manifest.version !== 1) errors.push('unsupported manifest or policy version')

  const remote = repositoryForRepo(repo)
  if (!remote) errors.push('origin repository is unavailable')
  else {
    if (remote !== policy.repository) errors.push(`origin repository mismatch: expected ${policy.repository}, observed ${remote}`)
    if (!policy.allowedRepositories?.includes(remote)) errors.push(`repository is not allowlisted: ${remote}`)
    if (manifest.repository !== remote) errors.push(`manifest repository mismatch: expected ${remote}, observed ${manifest.repository}`)
  }

  const base = baseOverride || manifest.base || `origin/${policy.defaultBranch}`
  try {
    git(['rev-parse', '--verify', base], repo)
  } catch {
    errors.push(`base ref is not resolvable: ${base}`)
  }

  const targets = manifest.targets || []
  if (targets.length === 0) errors.push('manifest has no targets')
  const allowed = new Set(manifest.allowedChangedPaths || targets.map((target) => target.path))
  for (const target of targets) {
    if (!validateRelativePath(target.path)) errors.push(`invalid target path: ${target.path}`)
    if (target.repository !== remote) errors.push(`target repository mismatch for ${target.path}: ${target.repository}`)
    if (!['patch', 'create'].includes(target.operation)) errors.push(`invalid operation for ${target.path}: ${target.operation}`)
    if (target.operation === 'patch' && existsAtRef(repo, base, target.path) === false) errors.push(`patch target does not exist at ${base}: ${target.path}`)
    if (target.operation === 'create' && existsAtRef(repo, base, target.path)) errors.push(`create target already exists at ${base}: ${target.path}`)
  }

  let changed = []
  try {
    const tracked = git(['diff', '--name-only', base], repo).split('\n').filter(Boolean)
    const untracked = git(['ls-files', '--others', '--exclude-standard'], repo).split('\n').filter(Boolean)
    changed = [...new Set([...tracked, ...untracked])].sort()
  } catch {
    errors.push(`unable to inspect working tree against ${base}`)
  }
  if (changed.length === 0) errors.push(`no changed files found against ${base}`)
  for (const path of changed) if (!allowed.has(path)) errors.push(`changed path is outside manifest scope: ${path}`)

  return { ok: errors.length === 0, repository: remote, base, changed, errors }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (!command || options.help) {
    process.stdout.write(usage)
    return
  }
  if (command === 'discover') {
    const repo = resolve(options.repo || '.')
    if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`repo does not exist: ${repo}`)
    const repository = repositoryForRepo(repo)
    process.stdout.write(JSON.stringify({ ok: true, repository, candidates: discover(repo, options.query || '') }, null, 2) + '\n')
    return
  }
  if (command === 'verify') {
    const repo = resolve(options.repo || '.')
    const policyPath = options.policy
    if (!policyPath) return fail(2, ['--policy is required'])
    const manifestPath = options.manifest
    if (!manifestPath) return fail(2, ['--manifest is required'])
    const result = verify(repo, policyPath, manifestPath, options.base)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (!result.ok) process.exitCode = 1
    return
  }
  return fail(2, [`unknown command: ${command}`])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => fail(2, [error.message]))

export { canonicalRepository, discover, verify }
