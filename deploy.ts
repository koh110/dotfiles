#!/usr/bin/env node --experimental-strip-types
// ./deploy.ts --all

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, copyFile, constants } from 'node:fs/promises'
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
    }
  }
})

async function main() {
  await Promise.all([
    (values.all || values.ssh) && ssh(),
    (values.all || values.git) && git(),
    (values.all || values.tmux) && tmux(),
    (values.all || values.zsh) && zsh(),
    (values.all || values.vim) && vim()
  ])
}
main().catch(console.error)

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
