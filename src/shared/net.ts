// Which network a post belongs to, and where it lives on the web. Shared by main and renderer.
import type { Network } from './types'

export const isBskyId = (id: string): boolean => id.startsWith('at://')

export function networkOf(t: { id: string; network?: Network }): Network {
  return t.network ?? (isBskyId(t.id) ? 'bsky' : 'x')
}

export const networkName = (n: Network): string => (n === 'bsky' ? 'Bluesky' : 'X')

/** The record key: the last segment of an at:// URI. */
export const rkeyOf = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1)

export function postUrl(t: { id: string; network?: Network; author: { handle: string } }): string {
  if (networkOf(t) === 'bsky') return `https://bsky.app/profile/${t.author.handle}/post/${rkeyOf(t.id)}`
  return `https://x.com/${t.author.handle}/status/${t.id}`
}
