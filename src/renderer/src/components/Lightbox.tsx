import type React from 'react'
import { useEffect, useState } from 'react'

// A viewer for a post's photos, over the whole window. Any image anywhere opens it with openImages(); it closes on Escape or a click outside the picture.

type Show = { urls: string[]; index: number }
let listener: ((s: Show | null) => void) | null = null

export function openImages(urls: string[], index = 0): void {
  listener?.({ urls, index })
}

/** The largest copy of a photo: X serves its media at a chosen size; Bluesky's URLs are already full size. */
export function largeUrl(url: string): string {
  if (!/^https:\/\/pbs\.twimg\.com\/media\//.test(url)) return url
  const u = new URL(url)
  u.searchParams.set('name', 'large')
  return u.toString()
}

export default function Lightbox(): React.JSX.Element | null {
  const [show, setShow] = useState<Show | null>(null)
  useEffect(() => {
    listener = setShow
    return () => { listener = null }
  }, [])
  useEffect(() => {
    if (!show) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShow(null)
      else if (e.key === 'ArrowRight') setShow((s) => s && { ...s, index: (s.index + 1) % s.urls.length })
      else if (e.key === 'ArrowLeft') setShow((s) => s && { ...s, index: (s.index + s.urls.length - 1) % s.urls.length })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [show])
  if (!show) return null
  const many = show.urls.length > 1
  const step = (d: number): void => setShow((s) => s && { ...s, index: (s.index + d + s.urls.length) % s.urls.length })
  return (
    <div className="lightbox" onClick={() => setShow(null)} title="Close">
      <img src={largeUrl(show.urls[show.index])} alt="" onClick={(e) => e.stopPropagation()} />
      {many ? (
        <>
          <button className="lb-nav prev" onClick={(e) => { e.stopPropagation(); step(-1) }} title="Previous (←)">‹</button>
          <button className="lb-nav next" onClick={(e) => { e.stopPropagation(); step(1) }} title="Next (→)">›</button>
          <div className="lb-count">{show.index + 1} / {show.urls.length}</div>
        </>
      ) : null}
      <button className="lb-close" onClick={() => setShow(null)} title="Close (Esc)">×</button>
    </div>
  )
}
