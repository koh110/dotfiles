#!/usr/bin/env node --experimental-strip-types
// ./deploy-code.ts --all
// ./deploy-code.ts --prompts --settings

import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { readdir, readFile, writeFile, copyFile, cp, constants } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const TARGET_DIR = `${homedir()}/Library/Application Support/Code/User`
const TARGET_DIR_INSIDERS = `${homedir()}/Library/Application Support/Code - Insiders/User`

const { values } = parseArgs({
  options: {
    all: {
      type: 'boolean',
      short: 'a',
      default: false,
    },
    settings: {
      type: 'boolean',
      short: 's',
      default: false,
    },
    prompts: {
      type: 'boolean',
      short: 'p',
      default: false,
    }
  }
})

async function main() {
  await Promise.all([
    (values.all || values.settings) && settings(),
    (values.all || values.prompts) && prompts()
  ])
}
main().catch(console.error)

async function settings() {
  console.log('copy: settings')
  const files = [
    // settings.json
    {
      from: join(import.meta.dirname, './code/settings.json'),
      to: join(TARGET_DIR, 'settings.json'),
    },
    {
      from: join(import.meta.dirname, './code/settings.json'),
      to: join(TARGET_DIR_INSIDERS, 'settings.json'),
    },
    // keybindings.json
    {
      from: join(import.meta.dirname, './code/keybindings.json'),
      to: join(TARGET_DIR, 'keybindings.json')
    },
    {
      from: join(import.meta.dirname, './code/keybindings.json'),
      to: join(TARGET_DIR_INSIDERS, 'keybindings.json')
    }
  ]
  const directories = [
    // snippets
    {
      from: join(import.meta.dirname, './code/snippets'),
      to: join(TARGET_DIR, 'snippets')
    },
    {
      from: join(import.meta.dirname, './code/snippets'),
      to: join(TARGET_DIR_INSIDERS, 'snippets')
    }
  ]
  await Promise.all([
    ...files.map(({ from, to }) => {
      return copyFile(from, to, constants.COPYFILE_FICLONE)
    }),
    ...directories.map(({ from, to }) => {
      return cp(from, to, {
        recursive: true
      })
    })
  ])
}

async function prompts() {
  console.log('deploy: prompts')
  const folder = resolve(join(import.meta.dirname, './code/prompts'))
  const files = await readdir(folder)

  const strs = await Promise.all(files.map((file) => {
    const filePath = join(folder, file);
    return readFile(filePath, 'utf-8');
  }))

  await writeFile(join(TARGET_DIR_INSIDERS, 'prompts', 'koh110.prompt.md'), strs.join('\n\n'))
}
