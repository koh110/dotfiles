#!/usr/bin/env node
// ./deploy.ts --all | --claude [--check|--force]  (--check は --claude の drift guard、--force は managed skill の上書き許可)

import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { deployDotfile } from './lib/dotfile-template.ts'
import { deployCodexConfig } from './lib/codex-config.ts'
import {
  SkillDeployConflictError,
  deploySkillsSnapshot,
  reconcileRuntimeSkills,
} from './lib/agent-skills.mjs'

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

const SKILLS_SOURCE_DIR = join(import.meta.dirname, 'skills')
const AGENTS_ROOT = join(homedir(), '.agents')
const AGENT_SKILLS_DIR = join(AGENTS_ROOT, 'skills')
const AGENT_SKILLS_MANIFEST = join(AGENTS_ROOT, '.dotfiles-skills-manifest.json')

async function main() {
  if (values.check) {
    if (!values.claude) {
      console.error('--check は --claude 専用です: node deploy.ts --claude --check')
      process.exitCode = 1
      return
    }
    if (!await checkCanonicalSkills()) return
    await claude()
    return
  }

  const deployAgentSkills = values.all || values.copilot || values.claude || values.codex
  if (deployAgentSkills && !await deployCanonicalSkills()) return

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

async function deployCanonicalSkills() {
  try {
    await deploySkillsSnapshot({
      sourceDir: SKILLS_SOURCE_DIR,
      targetDir: AGENT_SKILLS_DIR,
      manifestPath: AGENT_SKILLS_MANIFEST,
      force: values.force,
    })
    console.log('copy: agent skills -> ~/.agents/skills')
    return true
  } catch (error) {
    if (error instanceof SkillDeployConflictError) {
      reportSkillConflicts('agent skills deploy conflict:', error.conflicts)
      process.exitCode = 1
      return false
    }
    throw error
  }
}

async function checkCanonicalSkills() {
  try {
    await deploySkillsSnapshot({
      sourceDir: SKILLS_SOURCE_DIR,
      targetDir: AGENT_SKILLS_DIR,
      manifestPath: AGENT_SKILLS_MANIFEST,
      check: true,
    })
    return true
  } catch (error) {
    if (error instanceof SkillDeployConflictError) {
      reportSkillConflicts('agent skills drift detected:', error.conflicts)
      process.exitCode = 1
      return false
    }
    throw error
  }
}

function reportSkillConflicts(title: string, conflicts: { path: string; reason: string }[]) {
  console.error(title)
  for (const conflict of conflicts) {
    console.error(`  ${conflict.path}: ${conflict.reason}`)
  }
  console.error('')
  console.error('source of truth は dotfiles/skills です。installed snapshot の変更を残す場合は source へ反映し、')
  console.error('破棄してよい変更だけ --force で上書きしてください。')
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
  await reconcileRuntimeSkills({
    canonicalDir: AGENT_SKILLS_DIR,
    runtimeSkillsDir: join(homedir(), '.copilot', 'skills'),
    mode: 'remove',
    force: true,
    replaceRealEntries: true,
  })
  console.log('skills: copilot uses ~/.agents/skills')
}

async function claude() {
  const entries = await claudeDeployEntries()
  const drift = await detectClaudeDrift(entries)
  if (drift.length > 0 && !values.force) {
    reportDrift(drift)
    process.exitCode = 1
    return
  }

  try {
    await reconcileRuntimeSkills({
      canonicalDir: AGENT_SKILLS_DIR,
      runtimeSkillsDir: join(homedir(), '.claude', 'skills'),
      mode: 'symlink',
      force: values.force,
      replaceRealEntries: true,
      check: values.check,
    })
  } catch (error) {
    if (error instanceof SkillDeployConflictError) {
      reportSkillConflicts('claude skill migration conflict:', error.conflicts)
      process.exitCode = 1
      return
    }
    throw error
  }

  if (values.check) {
    console.log('claude deploy: no drift')
    return
  }

  await clearClaudeSkillManifest()
  console.log('link: ~/.claude/skills/* -> ~/.agents/skills/*')
}

const CLAUDE_MANIFEST = join(homedir(), '.claude', '.deploy-manifest.json')

interface DeployEntry {
  rel: string // ~/.claude からの相対パス（manifest のキー）
  src: string
  dst: string
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return out
    throw error
  }

  for (const d of entries) {
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

// main branch の claude() は skills/ のみを deploy する（agents/hooks/settings.json は
// .worktree/mf (dev branch) にのみ存在し、この worktree では扱わない）。
async function claudeDeployEntries(): Promise<DeployEntry[]> {
  const home = join(homedir(), '.claude')
  const root = import.meta.dirname
  const entries: DeployEntry[] = []
  for (const f of await listFiles(join(root, 'skills'))) {
    const rel = join('skills', relative(join(root, 'skills'), f))
    entries.push({ rel, src: f, dst: join(home, rel) })
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

  // 旧copy配下に、現在のsourceにも過去manifestにも存在しないfileがあれば
  // symlink移行時に消してよい根拠がないためdriftとして扱う。
  const sourceRels = new Set(entries.map((entry) => entry.rel))
  const legacySkillsDir = join(homedir(), '.claude', 'skills')
  for (const file of await listFiles(legacySkillsDir)) {
    const rel = join('skills', relative(legacySkillsDir, file))
    if (sourceRels.has(rel)) continue

    const currentHash = await hashFile(file)
    const recorded = manifest[rel]
    if (recorded === undefined) {
      drift.push({ rel, reason: '旧 ~/.claude/skills 配下に由来不明のfileがある' })
    } else if (currentHash !== recorded) {
      drift.push({ rel, reason: 'sourceから削除済みだが旧deploy後に変更されたfileがある' })
    }
  }

  return drift
}

function reportDrift(drift: { rel: string; reason: string }[]) {
  console.error('claude legacy skill drift detected:')
  for (const d of drift) {
    console.error(`  ~/.claude/${d.rel}: ${d.reason}`)
  }
  console.error('')
  console.error('旧 ~/.claude/skills の変更を残す場合は dotfiles/skills へ反映してください。')
  console.error('破棄してよい変更だけ --force でsymlink移行してください。')
}

async function clearClaudeSkillManifest() {
  const manifest = await readManifest()
  let changed = false
  for (const key of Object.keys(manifest)) {
    if (key === 'skills' || key.startsWith('skills/') || key.startsWith('skills\\')) {
      delete manifest[key]
      changed = true
    }
  }
  if (changed) {
    await writeFile(CLAUDE_MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  }
}

async function codex() {
  await reconcileRuntimeSkills({
    canonicalDir: AGENT_SKILLS_DIR,
    runtimeSkillsDir: join(homedir(), '.codex', 'skills'),
    mode: 'remove',
    force: true,
    replaceRealEntries: true,
  })
  console.log('skills: codex uses ~/.agents/skills')

  await Promise.all([
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
