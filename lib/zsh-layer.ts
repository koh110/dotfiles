import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWSL } from './wsl.ts'

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url))
const ZSH_DIR = join(REPO_DIR, 'zsh')

function detectOsLayer() {
  if (platform() === 'darwin') {
    return 'macos'
  }

  if (platform() === 'linux') {
    return 'linux'
  }

  throw new Error(`unsupported platform for zsh layer: ${platform()}`)
}

function detectHostLayer() {
  const name = process.env.DOTFILES_HOST || hostname().split('.')[0]
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`invalid DOTFILES_HOST: ${name}`)
  }
  return name
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function buildLayeredZshrc() {
  const os = detectOsLayer()
  const host = detectHostLayer()
  const common = await readFile(join(REPO_DIR, '.zshrc'), 'utf8')
  const optionalPaths = [
    join(ZSH_DIR, `${os}.zsh`),
    ...(isWSL() ? [join(ZSH_DIR, 'wsl.zsh')] : []),
    join(REPO_DIR, 'hosts', host, 'zsh.zsh')
  ]
  const optional = await Promise.all(optionalPaths.map(readOptional))
  const fragments = [common, ...optional].filter(
    (fragment): fragment is string => fragment !== null && fragment.trim().length > 0
  )

  return `${fragments.map((fragment) => fragment.trimEnd()).join('\n\n')}\n`
}

export async function deployLayeredZshrc(targetPath: string) {
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, await buildLayeredZshrc(), 'utf8')
}
