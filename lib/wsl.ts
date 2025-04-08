import { platform } from 'node:os'

export function isWSL() {
  return platform() === 'linux' && process.env.WSL_DISTRO_NAME
}

export async function getWindowsUsername() {
  try {
    const { execFile } = await import('node:child_process')
    return new Promise<string>((resolve, reject) => {
      execFile('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %USERNAME%'], (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout.trim())
      })
    })
  } catch (error) {
    console.error('Failed to get Windows username:', error)
    return 'unknown'
  }
}

export async function getWindowsHomeDir() {
  const username = await getWindowsUsername()
  return `/mnt/c/Users/${username}`
}
