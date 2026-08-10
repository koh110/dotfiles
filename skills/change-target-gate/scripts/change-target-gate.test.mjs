import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { canonicalRepository, verify } from './change-target-gate.mjs'

let repo
let metadata

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function manifest(targets, allowedChangedPaths = targets.map((target) => target.path)) {
  return {
    version: 1,
    repository: 'example-owner/example-repository',
    base: 'main',
    targets,
    allowedChangedPaths,
  }
}

function target(path, operation) {
  return { repository: 'example-owner/example-repository', path, operation }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'change-target-gate-'))
  metadata = mkdtempSync(join(tmpdir(), 'change-target-metadata-'))
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' })
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'change-target test')
  git('remote', 'add', 'origin', 'https://github.com/example-owner/example-repository.git')
  writeFileSync(join(repo, 'skills.md'), 'git workflow\n')
  git('add', '.')
  git('commit', '-m', 'base')
  git('switch', '-c', 'feature')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(metadata, { recursive: true, force: true })
})

test('remote URLをhost/pathのcanonical formへ正規化する', () => {
  assert.equal(canonicalRepository('git@github.com:example-owner/example-repository.git'), 'example-owner/example-repository')
  assert.equal(canonicalRepository('https://gitlab.example.com/group/project.git'), 'gitlab.example.com/group/project')
})


test('既存artifactへのpatchと宣言済み差分を受け入れる', () => {
  writeFileSync(join(repo, 'skills.md'), 'git workflow\nminimum diff\n')
  git('add', '.')
  git('commit', '-m', 'patch')
  const policy = join(metadata, 'policy.json')
  const manifestPath = join(metadata, 'manifest.json')
  writeFileSync(policy, JSON.stringify({ version: 1, repository: 'example-owner/example-repository', defaultBranch: 'main', allowedRepositories: ['example-owner/example-repository'] }))
  writeFileSync(manifestPath, JSON.stringify(manifest([target('skills.md', 'patch')])))

  assert.deepEqual(verify(repo, policy, manifestPath), {
    ok: true,
    repository: 'example-owner/example-repository',
    base: 'main',
    changed: ['skills.md'],
    errors: [],
  })
})

test('明示された既存target branchをbaseに使う', () => {
  git('branch', 'release/1.x')
  writeFileSync(join(repo, 'skills.md'), 'git workflow\nrelease change\n')
  git('add', '.')
  git('commit', '-m', 'target branch patch')
  const policy = join(metadata, 'policy.json')
  const manifestPath = join(metadata, 'manifest.json')
  writeFileSync(policy, JSON.stringify({ version: 1, repository: 'example-owner/example-repository', defaultBranch: 'main', allowedRepositories: ['example-owner/example-repository'] }))
  writeFileSync(manifestPath, JSON.stringify(manifest([target('skills.md', 'patch')])))

  assert.deepEqual(verify(repo, policy, manifestPath, 'release/1.x'), {
    ok: true,
    repository: 'example-owner/example-repository',
    base: 'release/1.x',
    changed: ['skills.md'],
    errors: [],
  })
})

test('既存artifactをcreate扱いした場合は拒否する', () => {
  writeFileSync(join(repo, 'skills.md'), 'changed\n')
  git('add', '.')
  git('commit', '-m', 'wrong operation')
  const policy = join(metadata, 'policy.json')
  const manifestPath = join(metadata, 'manifest.json')
  writeFileSync(policy, JSON.stringify({ version: 1, repository: 'example-owner/example-repository', defaultBranch: 'main', allowedRepositories: ['example-owner/example-repository'] }))
  writeFileSync(manifestPath, JSON.stringify(manifest([target('skills.md', 'create')])))

  const result = verify(repo, policy, manifestPath)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /create target already exists/)
})

test('manifest外の差分を拒否する', () => {
  writeFileSync(join(repo, 'skills.md'), 'changed\n')
  git('add', 'skills.md')
  git('commit', '-m', 'planned path')
  writeFileSync(join(repo, 'unplanned.txt'), 'not declared\n')
  const policy = join(metadata, 'policy.json')
  const manifestPath = join(metadata, 'manifest.json')
  writeFileSync(policy, JSON.stringify({ version: 1, repository: 'example-owner/example-repository', defaultBranch: 'main', allowedRepositories: ['example-owner/example-repository'] }))
  writeFileSync(manifestPath, JSON.stringify(manifest([target('skills.md', 'patch')])))

  const result = verify(repo, policy, manifestPath)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /outside manifest scope: unplanned.txt/)
})

test('repository ownership mismatchを拒否する', () => {
  writeFileSync(join(repo, 'skills.md'), 'changed\n')
  git('add', '.')
  git('commit', '-m', 'wrong repository')
  git('remote', 'set-url', 'origin', 'https://github.com/other/project.git')
  const policy = join(metadata, 'policy.json')
  const manifestPath = join(metadata, 'manifest.json')
  writeFileSync(policy, JSON.stringify({ version: 1, repository: 'example-owner/example-repository', defaultBranch: 'main', allowedRepositories: ['example-owner/example-repository'] }))
  writeFileSync(manifestPath, JSON.stringify(manifest([target('skills.md', 'patch')])))

  const result = verify(repo, policy, manifestPath)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /origin repository mismatch/)
  assert.match(result.errors.join('\n'), /not allowlisted/)
})
