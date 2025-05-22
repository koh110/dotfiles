#!/usr/bin/env node
// ./deploy-code.ts --all
// ./deploy-code.ts --prompts --settings

import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { readdir, readFile, writeFile, copyFile, cp, constants, access, mkdir } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { isWSL, getWindowsHomeDir } from './lib/wsl.ts'

const { TARGET_DIR, TARGET_DIR_INSIDERS } = await (async () => {
  if (isWSL()) {
    const home = await getWindowsHomeDir()
    return {
      TARGET_DIR: `${home}/AppData/Roaming/Code/User`,
      TARGET_DIR_INSIDERS: `${home}/AppData/Roaming/Code - Insiders/User`
    }
  }

  return {
    TARGET_DIR: `${homedir()}/Library/Application Support/Code/User`,
    TARGET_DIR_INSIDERS: `${homedir()}/Library/Application Support/Code - Insiders/User`
  }
})()

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
    /*
    {
      from: join(import.meta.dirname, './code/settings.json'),
      to: join(TARGET_DIR_INSIDERS, 'settings.json'),
    },
    */
    // keybindings.json
    {
      from: join(import.meta.dirname, './code/keybindings.json'),
      to: join(TARGET_DIR, 'keybindings.json')
    },
    /*
    {
      from: join(import.meta.dirname, './code/keybindings.json'),
      to: join(TARGET_DIR_INSIDERS, 'keybindings.json')
    }
    */
  ]
  const directories = [
    // snippets
    {
      from: join(import.meta.dirname, './code/snippets'),
      to: join(TARGET_DIR, 'snippets')
    },
    /*
    {
      from: join(import.meta.dirname, './code/snippets'),
      to: join(TARGET_DIR_INSIDERS, 'snippets')
    }
    */
  ]

  const wslSettings = async () => {
    if (!isWSL()) {
      return
    }

    const settings = {
      "mcp": {
        "inputs": [],
        "servers": {
          "mcp-koh110": {
            "type": "stdio",
            "command": "node",
            "args": [
              "--experimental-strip-types",
              "--watch",
              `${homedir()}/dev/mcp-koh110/src/index.ts`
            ]
          }
        }
      }
    }
    await writeFile(join(homedir(), '.vscode-server/data/Machine/settings.json'), JSON.stringify(settings, null, 2))
  }

  await Promise.all([
    ...files.map(({ from, to }) => {
      return copyFile(from, to, constants.COPYFILE_FICLONE)
    }),
    ...directories.map(({ from, to }) => {
      return cp(from, to, {
        recursive: true
      })
    }),
    wslSettings()
  ])
}

async function prompts() {
  // https://code.visualstudio.com/docs/copilot/copilot-customization#_instruction-files
  console.log('deploy: prompts')
  const folder = resolve(join(import.meta.dirname, './code/prompts'))
  await cp(folder, join(TARGET_DIR, 'prompts'), {
    recursive: true
  })
}
