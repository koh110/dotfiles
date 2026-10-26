#!/usr/bin/env node
// ./deploy.ts --all | --ssh | --git | --tmux | --zsh | --vim | --ghostty | --codex

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, cp } from 'node:fs/promises'
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
    codex: {
      type: 'boolean',
      default: false,
    },
  }
})

async function main() {
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
