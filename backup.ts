#!/usr/bin/env node
// ./backup.ts --all
// ./backup.ts --vim --tmux

import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { homedir } from 'node:os'
import { copyFile, cp, constants, writeFile } from 'node:fs/promises'
import { execFile as _execFile } from 'node:child_process'
import { isWSL, getWindowsHomeDir } from './lib/wsl.ts'

const execFile = promisify(_execFile)

const { values } = parseArgs({
  options: {
    all: {
      type: 'boolean',
      short: 'a',
      default: false,
    },
    vim: {
      type: 'boolean',
      short: 'v',
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
    code: {
      type: 'boolean',
      short: 'c',
      default: false,
    },
  }
})

async function main() {
  await Promise.all([
    (values.all || values.vim) && vim(),
    (values.all || values.tmux) && tmux(),
    (values.all || values.zsh) && zsh(),
    (values.all || values.code) && code(),
    (values.all || values.code) && codeExtension()
  ])
}
main().catch(console.error)

async function code() {
  console.log('backup: code')
  const { FILE_DIR } = await (async () => {
    if (isWSL()) {
      const home = await getWindowsHomeDir()
      return {
        FILE_DIR: `${home}/AppData/Roaming/Code/User`
      }
    }

    return {
      FILE_DIR: `${homedir()}/Library/Application Support/Code/User`
    }
  })()
  const TARGET_DIR = `${import.meta.dirname}/code`

  const files = [
    {
      from: join(FILE_DIR, 'settings.json'),
      to: join(TARGET_DIR, 'settings.json')
    },
    {
      from: join(FILE_DIR, 'keybindings.json'),
      to: join(TARGET_DIR, 'keybindings.json')
    }
  ]

  const directories = [
    {
      from: join(FILE_DIR, 'snippets'),
      to: join(TARGET_DIR, 'snippets')
    }
  ]

  await Promise.all([
    ...files.map(({ from, to }) => {
      return copyFile(from,to, constants.COPYFILE_FICLONE)
    }),
    ...directories.map(({ from, to }) => {
      return cp(from, to, {
        recursive: true
      })
    })
  ])
}

async function codeExtension() {
  console.log('backup: code extensions')
  const TARGET_DIR = `${import.meta.dirname}/code`
  const { stdout, stderr } = await execFile('code', ['--list-extensions'], {
    encoding: 'utf-8'
  })
  if (stderr) {
    throw new Error(`Error: ${stderr}`)
  }
  await writeFile(
    join(TARGET_DIR, 'extensions.txt'),
    stdout,
    { encoding: 'utf-8' }
  )
}

async function vim() {
  console.log('backup: vim')
  const files = [
    {
      from: join(homedir(), '.vimrc'),
      to: join(import.meta.dirname, '.vimrc')
    },
    {
      from: join(homedir(), '.vim/dein.toml'),
      to: join(homedir(), '.vim/dein.toml')
    }
  ]

  await Promise.all(
    files.map(({ from, to }) => {
      return copyFile(from,to, constants.COPYFILE_FICLONE)
    })
  )
}

async function zsh() {
  console.log('backup: zsh')
  const files = [
    {
      from: join(homedir(), '.zshrc'),
      to: join(import.meta.dirname, '.zshrc')
    },
    {
      from: join(homedir(), '.zshenv'),
      to: join(import.meta.dirname, '.zshenv')
    }
  ]

  await Promise.all(
    files.map(({ from, to }) => {
      return copyFile(from,to, constants.COPYFILE_FICLONE)
    })
  )
}

async function tmux() {
  console.log('backup: tmux')
  await copyFile(
    join(homedir(), '.tmux.conf'),
    join(import.meta.dirname, '.tmux.conf'),
    constants.COPYFILE_FICLONE
  )
}
