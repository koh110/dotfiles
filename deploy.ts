#!/usr/bin/env node
// ./deploy.ts --all | --claude [--check|--force]  (--check/--force は --claude の drift ガード専用)

import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { deployDotfile } from './lib/dotfile-template.ts'
import { deployCodexConfig } from './lib/codex-config.ts'

const { values } = parseArgs({
  options: {
    all: {
      type: 'boolean',
      short: 'a',
      default: false,
    },
    ssh: {
      type: 'boolean',
      short: 's',
      default: false,
    },
    git: {
      type: 'boolean',
      short: 'g',
      default: false,
    },
    tmux: {
      type: 'boolean',
      short: 't',
      default: false,
    },
    zsh: {
      type: 'boolean',
      short: 'z',
      default: false,
    },
    vim: {
      type: 'boolean',
      short: 'v',
      default: false,
    },
    ghostty: {
      type: 'boolean',
      default: false,
    },
    copilot: {
      type: 'boolean',
      short: 'c',
      default: false,
    },
    claude: {
      type: 'boolean',
      default: false,
    },
    codex: {
      type: 'boolean',
      default: false,
    },
    check: {
      type: 'boolean',
      default: false,
    },
    force: {
      type: 'boolean',
      default: false,
    },
  }
})

async function main() {
  if (values.check) {
    if (!values.claude) {
      console.error('--check は --claude 専用です: npx tsx deploy.ts --claude --check')
      process.exitCode = 1
      return
    }
    await claude() // --check 時は他ターゲットを一切実行しない（--all 併用でも claude の drift 報告のみ）
    return
  }
  await Promise.all([
    (values.all || values.ssh) && ssh(),
    (values.all || values.git) && git(),
    (values.all || values.tmux) && tmux(),
    (values.all || values.zsh) && zsh(),
    (values.all || values.vim) && vim(),
    (values.all || values.ghostty) && ghostty(),
    (values.all || values.copilot) && copilot(),
    (values.all || values.claude) && claude(),
    (values.all || values.codex) && codex(),
  ])
}
main().catch(console.error)

const AGENT_RESOURCE_DIRS = ['skills'] as const

async function deployAgentResources(name: string, targetDirName: string) {
  console.log('copy: ' + name)
  const targetDir = join(homedir(), targetDirName)
  await mkdir(targetDir, { recursive: true })
  for (const dir of AGENT_RESOURCE_DIRS) {
    await cp(join(import.meta.dirname, dir), join(targetDir, dir), {
      recursive: true
    })
  }
}

async function deployRuntimeSkillAdapters(
  runtime: string,
  targetDirName: string,
  targetName: string
) {
  const targetDir = join(homedir(), targetDirName)
  const targetPath = join(targetDir, targetName)
  const sourceContent = await collectSkillAdapters(runtime)
  let targetContent = ''

  await mkdir(targetDir, { recursive: true })
  try {
    targetContent = await readFile(targetPath, 'utf8')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
  }

  const marker = `dotfiles managed skill adapters ${runtime}`
  await writeFile(targetPath, mergeManagedMarkdown(targetContent, sourceContent, marker))
}

async function collectSkillAdapters(runtime: string) {
  const skillsDir = join(import.meta.dirname, 'skills')
  const skillNames = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const fragments: string[] = []
  for (const skillName of skillNames) {
    const adapterPath = join(skillsDir, skillName, 'adapters', `${runtime}.md`)
    try {
      const content = await readFile(adapterPath, 'utf8')
      fragments.push(`## Skill package: ${skillName}\n\n${content.trim()}`)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
    }
  }

  return [
    '# Managed skill adapters',
    'The sections below are generated from skills/*/adapters and should not be edited here.',
    ...fragments,
  ].join('\n\n')
}

function mergeManagedMarkdown(target: string, source: string, marker: string) {
  const begin = `<!-- BEGIN ${marker} -->`
  const end = `<!-- END ${marker} -->`
  const beginIndex = target.indexOf(begin)
  const endIndex = target.indexOf(end)

  if ((beginIndex === -1) !== (endIndex === -1) || (beginIndex !== -1 && endIndex < beginIndex)) {
    throw new Error(`invalid managed markdown block: ${marker}`)
  }

  let unmanaged = target
  if (beginIndex !== -1) {
    unmanaged = target.slice(0, beginIndex) + target.slice(endIndex + end.length)
  }

  const managed = [begin, source.trim(), end].join('\n')
  return [managed, unmanaged.trim()].filter(Boolean).join('\n\n') + '\n'
}

async function deployCodexAgents() {
  console.log('copy: codex agents')
  const targetDir = join(homedir(), '.codex', 'agents')
  await mkdir(targetDir, { recursive: true })
  await cp(join(import.meta.dirname, '.codex', 'agents'), targetDir, {
    recursive: true
  })
}

async function copilot() {
  await deployAgentResources('copilot', '.copilot')
}

async function claude() {
  const entries = await claudeDeployEntries()
  const drift = await detectClaudeDrift(entries)
  if (values.check) {
    if (drift.length > 0) {
      reportDrift(drift)
      process.exitCode = 1
    } else {
      console.log('claude deploy: no drift')
    }
    return
  }
  if (drift.length > 0 && !values.force) {
    reportDrift(drift)
    process.exitCode = 1
    return
  }
  await Promise.all([
    deployAgentResources('claude', '.claude'),
    deployRuntimeSkillAdapters('claude-code', '.claude', 'CLAUDE.md'),
  ])
  // manifest はportable resource以外のキー(claude/agents・hooks・settings.json等)を
  // 保持したままマージする。ここで書き込むのはmainが実際にdeployした
  // skills/の範囲だけで、他のmanaged keyは消さない。
  const manifest = await readManifest()
  for (const e of entries) {
    const h = await hashFile(e.src)
    if (h !== null) manifest[e.rel] = h
  }
  await writeFile(CLAUDE_MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
}

const CLAUDE_MANIFEST = join(homedir(), '.claude', '.deploy-manifest.json')

interface DeployEntry {
  rel: string // ~/.claude からの相対パス（manifest のキー）
  src: string
  dst: string
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name)
    if (d.isDirectory()) out.push(...(await listFiles(p)))
    else if (d.isFile()) out.push(p)
  }
  return out
}

async function hashFile(path: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch {
    return null
  }
}

// main branch の claude() はportable agent resourcesとglobal routerだけをdeployする。
// agents/hooks/settings.json は .worktree/mf (dev branch) 側の責務とする。
async function claudeDeployEntries(): Promise<DeployEntry[]> {
  const home = join(homedir(), '.claude')
  const root = import.meta.dirname
  const entries: DeployEntry[] = []
  for (const dir of AGENT_RESOURCE_DIRS) {
    for (const f of await listFiles(join(root, dir))) {
      const rel = join(dir, relative(join(root, dir), f))
      entries.push({ rel, src: f, dst: join(home, rel) })
    }
  }
  return entries
}

async function readManifest(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(CLAUDE_MANIFEST, 'utf8'))
  } catch {
    return {}
  }
}

// ~/.claude 側が「前回 deploy 時の内容」から変わっているファイルを検出する。
// deploy は無条件上書きコピーのため、ここで検出された変更は deploy で失われる。
// 判定順序が重要:
//   1. dst 不在 → 未 deploy。上書きで失われるものが無いので drift ではない。
//   2. dst == src（byte 同一）→ deploy しても内容が変わらないので drift ではない。
//      これにより「~/.claude 側の変更を cp で worktree 正本へ同期する」という正規の解消手順が
//      --force なしで通る（この短絡が無いと、同期後も recorded≠dstHash で恒久拒否になる）。
//   3. manifest 記録あり → 前回 deploy 時から dst が変わっていれば drift（deploy で失われる変更）。
//      recorded == dstHash（src だけ更新された正当な deploy 前状態）は drift ではない。
//   4. manifest 未記録（初回 or 新規ファイル）→ src と不一致なら由来不明 drift として fail-closed。
async function detectClaudeDrift(
  entries: DeployEntry[]
): Promise<{ rel: string; reason: string }[]> {
  const manifest = await readManifest()
  const drift: { rel: string; reason: string }[] = []
  for (const e of entries) {
    const dstHash = await hashFile(e.dst)
    if (dstHash === null) continue // 未 deploy: 上書きで失われるものが無い
    const srcHash = await hashFile(e.src)
    if (dstHash === srcHash) continue // 正本と byte 同一: deploy で失われるものが無い
    const recorded = manifest[e.rel]
    if (recorded !== undefined) {
      if (dstHash !== recorded) {
        drift.push({ rel: e.rel, reason: '前回 deploy 後に ~/.claude 側が直接変更されている（worktree 正本とも不一致）' })
      }
    } else {
      drift.push({ rel: e.rel, reason: 'manifest 未記録かつ worktree 正本と内容が異なる（由来不明の drift）' })
    }
  }
  return drift
}

function reportDrift(drift: { rel: string; reason: string }[]) {
  console.error('claude deploy drift detected:')
  for (const d of drift) {
    console.error(`  ~/.claude/${d.rel}: ${d.reason}`)
  }
  console.error('')
  console.error('deploy は ~/.claude 側の上記変更を無言で上書きします。次のいずれかで解消してください:')
  console.error('  1. 残すべき変更の場合: diff を確認し、~/.claude 側の内容を worktree 正本へ byte 同一に')
  console.error('     コピーする（cp ~/.claude/<上記rel> <worktree の対応 src>）。同期後は --force 不要で deploy が通る。')
  console.error('  2. worktree 側へ意味的に取り込み済みで byte が異なる場合（settings.json のキー順差等）:')
  console.error('     当該変更が正本に反映済みであることを diff で確認した上で --force で上書きする。')
  console.error('  3. ~/.claude 側の変更を破棄してよい場合のみ、そのまま --force で上書きする。')
}

async function codex() {
  await Promise.all([
    deployAgentResources('codex', '.codex'),
    deployRuntimeSkillAdapters('codex', '.codex', 'AGENTS.md'),
    deployCodexAgents(),
    deployCodexConfig(
      join(import.meta.dirname, '.codex/config.toml'),
      join(homedir(), '.codex/config.toml')
    ),
  ])
}

async function ssh() {
  console.log('copy: ssh')
  await deployDotfile('.ssh/config', `${homedir()}/.ssh/config`)
}

async function git() {
  console.log('copy: git')
  await deployDotfile('.gitconfig', `${homedir()}/.gitconfig`)
}

async function tmux() {
  console.log('copy: tmux')
  await deployDotfile('.tmux.conf', `${homedir()}/.tmux.conf`)
}

async function zsh() {
  console.log('copy: zsh')
  await Promise.all([
    deployDotfile('.zshenv', `${homedir()}/.zshenv`),
    deployDotfile('.zshrc', `${homedir()}/.zshrc`)
  ])
}

async function vim() {
  console.log('copy: vim')
  const VIM_DIR = `${homedir()}/.vim`

  await Promise.all([
    deployDotfile('.vimrc', join(homedir(), '.vimrc')),
    mkdir(VIM_DIR, { recursive: true })
      .then(() =>
        deployDotfile('.vim/dein.toml', join(VIM_DIR, 'dein.toml'))
      )
  ])
}

async function ghostty() {
  console.log('copy: ghostty')
  await deployDotfile(
    '.config/ghostty/config',
    join(homedir(), '.config/ghostty/config')
  )
}
