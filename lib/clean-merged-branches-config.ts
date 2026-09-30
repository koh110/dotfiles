import path from 'node:path'
import process from 'node:process'

export function loadCleanMergedWorktreesConfig() {
  const configuredRoot = process.env.GIT_REPOSITORIES_ROOT || process.env.HERMES_DEV_ROOT || (process.env.HOME ? path.join(process.env.HOME, 'dev') : null)
  return {
    configuredRoot,
    environment: { ...process.env },
  }
}
