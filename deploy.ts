#!/usr/bin/env node
// ./deploy.ts --all

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, copyFile, constants, cp } from 'node:fs/promises'
import { parseArgs } from 'node:util'

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
  await mkdir(`${homedir()}/.ssh`, { recursive: true })
  await copyFile(
    join(import.meta.dirname, '.ssh/config'),
    `${homedir()}/.ssh/config`,
    constants.COPYFILE_FICLONE
  )
}

async function git() {
  console.log('copy: git')
  await copyFile(
    join(import.meta.dirname, '.gitconfig'),
    `${homedir()}/.gitconfig`,
    constants.COPYFILE_FICLONE
  )
}

async function tmux() {
  console.log('copy: tmux')
  await copyFile(
    join(import.meta.dirname, '.tmux.conf'),
    `${homedir()}/.tmux.conf`,
    constants.COPYFILE_FICLONE
  )
}

async function zsh() {
  console.log('copy: zsh')
  await Promise.all([
    copyFile(
      join(import.meta.dirname, '.zshenv'),
      `${homedir()}/.zshenv`,
      constants.COPYFILE_FICLONE
    ),
    copyFile(
      join(import.meta.dirname, '.zshrc'),
      `${homedir()}/.zshrc`,
      constants.COPYFILE_FICLONE
    )
  ])
}

async function vim() {
  console.log('copy: vim')
  const VIM_DIR = `${homedir()}/.vim`

  await 

  await Promise.all([
    copyFile(
      join(import.meta.dirname, '.vimrc'),
      join(homedir(), '.vimrc'),
      constants.COPYFILE_FICLONE
    ),
    mkdir(VIM_DIR, { recursive: true })
      .then(() =>
        copyFile(
          join(import.meta.dirname, '.vim/dein.toml'),
          join(VIM_DIR, 'dein.toml'),
          constants.COPYFILE_FICLONE
        )
      )
  ])
}
