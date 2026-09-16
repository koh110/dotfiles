import { access, copyFile, constants, mkdir, readFile, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWSL } from './wsl.ts'
import { deployLayeredZshrc } from './zsh-layer.ts'

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE_DIR = join(REPO_DIR, 'templates', 'files')

function detectEnvironment() {
  if (isWSL()) {
    return 'wsl'
  }

  if (platform() === 'darwin') {
    return 'macos'
  }

  return 'linux'
}

function templateCandidates(path: string) {
  const environment = detectEnvironment()
  const environments = environment === 'wsl' ? ['wsl', 'linux'] : [environment]
  return environments.map((name) => join(TEMPLATE_DIR, name, path))
}

async function findExistingTemplate(path: string) {
  const candidates = templateCandidates(path)
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate)
        return candidate
      } catch {
        return null
      }
    })
  )

  return results.find((candidate) => candidate !== null) ?? null
}

function applyAdditionalLines(base: string, additional: string) {
  const lines = base.split('\n')
  const additionalLines = additional
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)

  for (const additionalLine of additionalLines) {
    if (lines.includes(additionalLine)) {
      continue
    }

    const commentedCandidates = [`# ${additionalLine}`, `#${additionalLine}`]
    const commentedIndex = lines.findIndex((line) => commentedCandidates.includes(line))

    if (commentedIndex >= 0) {
      lines[commentedIndex] = additionalLine
      continue
    }

    lines.push(additionalLine)
  }

  return `${lines.join('\n')}\n`
}

export async function deployDotfile(path: string, targetPath: string) {
  // zsh は raw な .zsh 断片を common -> OS -> WSL -> host の順で連結し、
  // 最終的な ~/.zshrc を1ファイルとして生成する。
  if (path === '.zshrc') {
    await deployLayeredZshrc(targetPath)
    return
  }

  const templatePath = await findExistingTemplate(path)
  await mkdir(dirname(targetPath), { recursive: true })

  if (!templatePath) {
    await copyFile(join(REPO_DIR, path), targetPath, constants.COPYFILE_FICLONE)
    return
  }

  const [base, additional] = await Promise.all([
    readFile(join(REPO_DIR, path), 'utf-8'),
    readFile(templatePath, 'utf-8')
  ])

  await writeFile(targetPath, applyAdditionalLines(base, additional), 'utf-8')
}

export async function backupDotfile(sourcePath: string, path: string) {
  const targetPath = join(REPO_DIR, path)
  await mkdir(dirname(targetPath), { recursive: true })
  await copyFile(sourcePath, targetPath, constants.COPYFILE_FICLONE)
}
