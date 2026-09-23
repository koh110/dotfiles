#!/usr/bin/env node
// ./deploy.ts --all | --claude [--check|--force]  (--check は --claude の drift guard、--force は managed skill の上書き許可)

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, cp } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { deployDotfile } from './lib/dotfile-template.ts'
import { deployCodexConfig } from './lib/codex-config.ts'
import { deployAgentSkills } from './lib/agent-skills.mjs'

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

function selectedSkillRuntimes() {
  const runtimes: ('copilot' | 'claude' | 'codex')[] = []
  if (values.all || values.copilot) runtimes.push('copilot')
  if (values.all || values.claude) runtimes.push('claude')
  if (values.all || values.codex) runtimes.push('codex')
  return runtimes
}

async function main() {
  const skillRuntimes = selectedSkillRuntimes()

  if (values.check) {
    if (!values.claude) {
      console.error('--check は --claude 専用です: node deploy.ts --claude --check')
      process.exitCode = 1
      return
    }

    const ok = await deployAgentSkills({
      sourceDir: join(import.meta.dirname, 'skills'),
      homeDir: homedir(),
      runtimes: ['claude'],
      force: values.force,
      check: true,
    })
    if (!ok) process.exitCode = 1
    return
  }

  if (skillRuntimes.length > 0) {
    const ok = await deployAgentSkills({
      sourceDir: join(import.meta.dirname, 'skills'),
      homeDir: homedir(),
      runtimes: skillRuntimes,
      force: values.force,
    })
    if (!ok) {
      process.exitCode = 1
      return
    }
  }

  await Promise.all([
    (values.all || values.ssh) && ssh(),
    (values.all || values.git) && git(),
    (values.all || values.tmux) && tmux(),
    (values.all || values.zsh) && zsh(),
    (values.all || values.vim) && vim(),
    (values.all || values.ghostty) && ghostty(),
    (values.all || values.codex) && codex(),
  ])
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

async function deployCodexAgents() {
  console.log('copy: codex agents')
  const targetDir = join(homedir(), '.codex', 'agents')
  await mkdir(targetDir, { recursive: true })
  await cp(join(import.meta.dirname, '.codex', 'agents'), targetDir, {
    recursive: true
  })
}

async function codex() {
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
