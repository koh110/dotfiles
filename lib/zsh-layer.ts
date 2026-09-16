import { copyFile, constants, mkdir, rm } from 'node:fs/promises'
import { hostname, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWSL } from './wsl.ts'

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE_DIR = join(REPO_DIR, 'templates', 'files')
const ENTRYPOINT = join(REPO_DIR, 'layers', 'zsh', 'entrypoint.zshrc')

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

async function copyOptional(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true })
  try {
    await copyFile(source, target, constants.COPYFILE_FICLONE)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    // レイヤーが消えた時に以前のdeploy結果を残さない。
    await rm(target, { force: true })
    return false
  }
}

export async function deployLayeredZshrc(targetPath: string) {
  const os = detectOsLayer()
  const host = detectHostLayer()
  const targetHome = dirname(targetPath)
  const deployDir = join(targetHome, '.config', 'dotfiles', 'zsh')

  await mkdir(deployDir, { recursive: true })

  // 現行rootの .zshrc を common の正本としてそのまま利用する。
  await copyFile(
    join(REPO_DIR, '.zshrc'),
    join(deployDir, '10-common.zsh'),
    constants.COPYFILE_FICLONE
  )

  // 移行途中は既存 templates/files の差分を raw fragment として再利用する。
  // 設定内容をNixやTypeScriptへ移さず、最終的には files/<os> 等へ移動できる。
  await copyOptional(
    join(TEMPLATE_DIR, os, '.zshrc'),
    join(deployDir, '20-os.zsh')
  )

  if (isWSL()) {
    await copyOptional(
      join(TEMPLATE_DIR, 'wsl', '.zshrc'),
      join(deployDir, '30-wsl.zsh')
    )
  } else {
    await rm(join(deployDir, '30-wsl.zsh'), { force: true })
  }

  await copyOptional(
    join(REPO_DIR, 'hosts', host, '.zshrc'),
    join(deployDir, '40-host.zsh')
  )

  // ~/.zshrc 自体は固定の薄いentrypoint。各設定はraw fileのまま保持する。
  await mkdir(dirname(targetPath), { recursive: true })
  await copyFile(ENTRYPOINT, targetPath, constants.COPYFILE_FICLONE)
}
