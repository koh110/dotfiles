import { dirname } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const CODEX_CONFIG_BEGIN = '# BEGIN dotfiles managed codex config'
const CODEX_CONFIG_END = '# END dotfiles managed codex config'

export async function deployCodexConfig(sourcePath: string, targetPath: string) {
  console.log('merge: codex config')
  const source = await readFile(sourcePath, 'utf8')
  let target = ''

  await mkdir(dirname(targetPath), { recursive: true })

  try {
    target = await readFile(targetPath, 'utf8')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
  }

  await writeFile(targetPath, mergeManagedToml(target, source))
}

export function mergeManagedToml(target: string, source: string) {
  const managedKeys = getTopLevelKeys(source)
  const managedTables = getTableNames(source)
  const unmanagedTarget = removeManagedToml(removeManagedBlock(target), managedKeys, managedTables).trim()
  const managedBlock = [
    CODEX_CONFIG_BEGIN,
    source.trim(),
    CODEX_CONFIG_END,
  ].join('\n')

  return [managedBlock, unmanagedTarget]
    .filter(Boolean)
    .join('\n\n') + '\n'
}

function removeManagedBlock(config: string) {
  const lines = config.split('\n')
  const result: string[] = []
  let inManagedBlock = false

  for (const line of lines) {
    if (line.trim() === CODEX_CONFIG_BEGIN) {
      inManagedBlock = true
      continue
    }

    if (line.trim() === CODEX_CONFIG_END) {
      inManagedBlock = false
      continue
    }

    if (!inManagedBlock) {
      result.push(line)
    }
  }

  return result.join('\n')
}

function getTopLevelKeys(config: string) {
  let inTable = false
  return new Set(config
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (line.startsWith('[')) {
        inTable = true
        return false
      }
      return !inTable && line && !line.startsWith('#')
    })
    .map((line) => line.match(/^([A-Za-z0-9_-]+)\s*=/)?.[1])
    .filter((key): key is string => Boolean(key)))
}

function getTableNames(config: string) {
  return new Set(config
    .split('\n')
    .map((line) => line.trim().match(/^\[([^\]]+)\]$/)?.[1])
    .filter((table): table is string => Boolean(table)))
}

function removeManagedToml(config: string, keys: Set<string>, tables: Set<string>) {
  const result: string[] = []
  let currentTable: string | null = null
  let skippingTable = false

  for (const line of config.split('\n')) {
    const table = line.trim().match(/^\[([^\]]+)\]$/)?.[1]

    if (table) {
      currentTable = table
      skippingTable = tables.has(table)

      if (!skippingTable) {
        result.push(line)
      }
      continue
    }

    if (skippingTable) {
      continue
    }

    const key = line.trim().match(/^([A-Za-z0-9_-]+)\s*=/)?.[1]
    if (currentTable === null && key && keys.has(key)) {
      continue
    }

    result.push(line)
  }

  return result.join('\n')
}
