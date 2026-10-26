import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

for (const option of ['--claude', '--copilot', '--check', '--force']) {
  test(`deployment rejects legacy skill option ${option}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'dotfiles-legacy-skill-option-'))

    try {
      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', 'deploy.ts', option],
        {
          cwd: repositoryRoot,
          env: { ...process.env, HOME: home },
          encoding: 'utf8',
        },
      )

      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Unknown option/)
      assert.equal(existsSync(join(home, '.agents')), false)
      assert.equal(existsSync(join(home, '.claude')), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}
