import type { EditionItem, Ordering } from '@shared/types'

/** Lays out an edition's posts: as ranked at build time, oldest first, or newest first. */
export function orderItems(items: EditionItem[], ordering: Ordering): EditionItem[] {
  if (ordering === 'priority') return items
  const at = (i: EditionItem): number => new Date(i.tweet.createdAt).getTime()
  return [...items].sort((a, b) => (ordering === 'newest' ? at(b) - at(a) : at(a) - at(b)))
}
