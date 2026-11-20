import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(homedir(), path)
}

export function shortHome(path: string): string {
  const home = homedir()
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}
