#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  options: {
    help: {
      type: 'boolean',
      short: 'h',
      default: false,
    },
    check: {
      type: 'boolean',
      default: false,
    },
  },
  allowPositionals: true,
})

const SKILL_LINT_DIR = join(import.meta.dirname, '..', 'lint')

const TARGET_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

const VITE_CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
]

const LINT_CONFIG_FILES = {
  vp: [
    '.oxlintrc.json',
    '.oxlintrc.jsonc',
    'oxlint.config.ts',
    'oxlint.config.mts',
    'oxlint.config.js',
    'oxlint.config.mjs',
  ],
  other: [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    'eslint.config.mts',
    'eslint.config.cts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    'biome.json',
    'biome.jsonc',
  ],
} as const

const FMT_CONFIG_FILES = {
  vp: [
    '.oxfmtrc.json',
    '.oxfmtrc.jsonc',
    'oxfmt.config.ts',
    'oxfmt.config.mts',
    'oxfmt.config.js',
    'oxfmt.config.mjs',
  ],
  other: [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.json5',
    '.prettierrc.yml',
    '.prettierrc.yaml',
    '.prettierrc.toml',
    '.prettierrc.js',
    '.prettierrc.mjs',
    '.prettierrc.cjs',
    '.prettierrc.ts',
    '.prettierrc.mts',
    '.prettierrc.cts',
    'prettier.config.js',
    'prettier.config.mjs',
    'prettier.config.cjs',
    'prettier.config.ts',
    'prettier.config.mts',
    'prettier.config.cts',
    'biome.json',
    'biome.jsonc',
    'dprint.json',
    'dprint.jsonc',
    '.dprint.json',
    '.dprint.jsonc',
  ],
} as const

const TOOLS = [
  {
    command: 'fmt',
    configFiles: FMT_CONFIG_FILES,
    viteConfigKey: /\bfmt\s*:/,
    packageJsonKey: 'prettier',
    otherPackages: ['prettier', '@biomejs/biome', 'dprint'],
    skillConfig: join(SKILL_LINT_DIR, 'oxfmt.json'),
  },
  {
    command: 'lint',
    configFiles: LINT_CONFIG_FILES,
    viteConfigKey: /\blint\s*:/,
    packageJsonKey: 'eslintConfig',
    otherPackages: ['eslint', '@biomejs/biome'],
    skillConfig: join(SKILL_LINT_DIR, 'oxlint.json'),
  },
] as const

function showHelp() {
  console.log(`Usage: check.ts [options] [files...]

projectのrootで実行し、vp(Vite+)でformatとlintを流す。
filesを省略した場合はgitの変更ファイル(未追跡を含む)を対象にする。
projectにlint/format設定がある場合はそれを優先し、無い場合だけskillの設定を使う。

Options:
  --check     formatを書き込まず差分の有無だけ確認する
  -h, --help  Show this help message`)
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function findGitRoot(cwd: string) {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return null
  }
}

// cwdからgit root(無ければcwdのみ)までのdirectoryを近い順に返す
function listSearchDirs(cwd: string, gitRoot: string | null) {
  const dirs = [cwd]
  if (gitRoot === null) {
    return dirs
  }
  let current = cwd
  while (current !== gitRoot && dirname(current) !== current) {
    current = dirname(current)
    dirs.push(current)
  }
  return dirs
}

function listTrackedChanges(gitRoot: string) {
  try {
    return git(gitRoot, ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'])
  } catch {
    // commitが1つも無いrepositoryではHEADが無いので、stage済みのファイルをすべて対象にする
    return git(gitRoot, ['ls-files', '--cached'])
  }
}

function listChangedFiles(gitRoot: string) {
  return [
    ...listTrackedChanges(gitRoot).split('\n'),
    ...git(gitRoot, ['ls-files', '--others', '--exclude-standard']).split('\n'),
  ]
    .filter((file) => {
      return file !== '' && !file.split('/').includes('node_modules')
    })
    .map((file) => {
      return join(gitRoot, file)
    })
}

function readPackageJson(dir: string) {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) {
    return null
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  return parsed
}

// projectのconfigを近いdirectoryから探す。vpで扱えるか(vp)、別toolのものか(other)を返す
function detectProjectConfig(searchDirs: string[], tool: (typeof TOOLS)[number]) {
  for (const dir of searchDirs) {
    for (const file of VITE_CONFIG_FILES) {
      const path = join(dir, file)
      if (existsSync(path) && tool.viteConfigKey.test(readFileSync(path, 'utf8'))) {
        return { kind: 'vp', path } as const
      }
    }
    for (const file of tool.configFiles.vp) {
      if (existsSync(join(dir, file))) {
        return { kind: 'vp', path: join(dir, file) } as const
      }
    }
    for (const file of tool.configFiles.other) {
      if (existsSync(join(dir, file))) {
        return { kind: 'other', path: join(dir, file) } as const
      }
    }
    const packageJson = readPackageJson(dir)
    if (packageJson === null) {
      continue
    }
    if (tool.packageJsonKey in packageJson) {
      return {
        kind: 'other',
        path: `${join(dir, 'package.json')} (${tool.packageJsonKey})`,
      } as const
    }
    // 設定ファイルを置かず既定値で運用しているtoolも、依存にあればprojectの設定として扱う
    for (const name of tool.otherPackages) {
      if (hasDependency(packageJson, name)) {
        return { kind: 'other', path: `${join(dir, 'package.json')} (${name})` } as const
      }
    }
  }
  return null
}

function hasDependency(packageJson: object, name: string) {
  for (const field of ['dependencies', 'devDependencies']) {
    const dependencies: unknown = Reflect.get(packageJson, field)
    if (typeof dependencies === 'object' && dependencies !== null && name in dependencies) {
      return true
    }
  }
  return false
}

// projectにvite-plusが入っていればそれを使い、無ければnpxで取得する
function resolveVpCommand(searchDirs: string[]) {
  for (const dir of searchDirs) {
    const local = join(dir, 'node_modules', '.bin', 'vp')
    if (existsSync(local)) {
      return { command: local, args: [] }
    }
  }
  return { command: 'npx', args: ['--yes', '-p', 'vite-plus@1', 'vp'] }
}

function run(command: string, args: string[]) {
  console.log(`$ ${[command, ...args].join(' ')}`)
  return spawnSync(command, args, { stdio: 'inherit' }).status ?? 1
}

function main() {
  if (values.help) {
    showHelp()
    return
  }
  const cwd = process.cwd()
  if (!existsSync(join(cwd, 'package.json'))) {
    console.error(
      'package.jsonのあるdirectoryで実行する(vpはpackage.jsonの無いdirectoryで動かない)',
    )
    process.exitCode = 1
    return
  }
  const gitRoot = findGitRoot(cwd)
  const searchDirs = listSearchDirs(cwd, gitRoot)
  if (positionals.length === 0 && gitRoot === null) {
    console.error('git repositoryの外ではfilesを指定する')
    process.exitCode = 1
    return
  }
  const candidates = (
    positionals.length > 0
      ? positionals.map((file) => {
          return resolve(cwd, file)
        })
      : listChangedFiles(gitRoot ?? cwd)
  )
    .filter((file) => {
      return (
        TARGET_EXTENSIONS.some((extension) => {
          return file.endsWith(extension)
        }) && existsSync(file)
      )
    })
    .map((file) => {
      return relative(cwd, file)
    })
  // vpはcwdの外(..を含むpath)を受け付けない
  const outside = candidates.filter((file) => {
    return file.startsWith('..')
  })
  if (outside.length > 0) {
    console.log(`cwdの外にあるため対象外: ${outside.join(', ')}`)
  }
  const files = candidates.filter((file) => {
    return !file.startsWith('..')
  })
  if (files.length === 0) {
    console.log('対象のファイルが無い')
    return
  }

  const vp = resolveVpCommand(searchDirs)
  let failed = false
  for (const tool of TOOLS) {
    const projectConfig = detectProjectConfig(searchDirs, tool)
    if (projectConfig !== null && tool.command === 'lint') {
      console.log(
        '[lint] skillのlint設定は適用されない。SKILL.mdのguideline全体を変更ファイルに照らして再確認する',
      )
    }
    if (projectConfig?.kind === 'other') {
      console.log(
        `[${tool.command}] projectの設定 ${projectConfig.path} があるため、projectのscriptで${tool.command}を実行する`,
      )
      continue
    }
    console.log(
      `[${tool.command}] ${projectConfig === null ? 'skillの設定' : `projectの設定 ${projectConfig.path} `}を使う`,
    )
    if (
      run(vp.command, [
        ...vp.args,
        tool.command,
        ...(projectConfig === null ? ['-c', tool.skillConfig] : []),
        ...(tool.command === 'fmt' && values.check ? ['--check'] : []),
        ...files,
      ]) !== 0
    ) {
      failed = true
    }
  }
  if (failed) {
    process.exitCode = 1
  }
}

main()
