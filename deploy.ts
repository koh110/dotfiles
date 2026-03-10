#!/usr/bin/env node
// ./deploy.ts --all

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, cp } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { deployDotfile } from './lib/dotfile-template.ts'

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
    copilot: {
      type: 'boolean',
      short: 'c',
      default: false,
    },
    claude: {
      type: 'boolean',
      default: false,
    }
  }
})

async function main() {
  await Promise.all([
    (values.all || values.ssh) && ssh(),
    (values.all || values.git) && git(),
    (values.all || values.tmux) && tmux(),
    (values.all || values.zsh) && zsh(),
    (values.all || values.vim) && vim(),
    (values.all || values.copilot) && copilot(),
    (values.all || values.claude) && claude(),
  ])
}
main().catch(console.error)

async function copilot() {
  console.log('copy: copilot')
  const targetDir = join(homedir(), '.copilot')
  await mkdir(targetDir, { recursive: true })
  await cp(join(import.meta.dirname, '.copilot/skills'), join(targetDir, 'skills'), {
    recursive: true
  })
}

async function claude() {
  console.log('copy: claude')
  const targetDir = join(homedir(), '.claude')
  await mkdir(targetDir, { recursive: true })
  await cp(join(import.meta.dirname, '.copilot/skills'), join(targetDir, 'skills'), {
    recursive: true
  })
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
