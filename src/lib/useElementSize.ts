import { useEffect, useState, type RefObject } from 'react'

export interface ElementSize {
  width: number
  height: number
}

/**
 * Track an element's content-box size (CSS pixels) via ResizeObserver.
 * Updates are rAF-coalesced; sub-pixel noise under 1px is ignored.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>, enabled = true): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 })

  useEffect(() => {
    if (!enabled) {
      setSize({ width: 0, height: 0 })
      return
    }
    const element = ref.current
    if (!element) return

    let frame = 0
    const apply = (width: number, height: number) => {
      setSize((previous) => {
        if (Math.abs(previous.width - width) < 1 && Math.abs(previous.height - height) < 1) {
          return previous
        }
        return { width, height }
      })
    }

    const rect = element.getBoundingClientRect()
    apply(rect.width, rect.height)

    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => {
        const next = element.getBoundingClientRect()
        apply(next.width, next.height)
      }
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        apply(entry.contentRect.width, entry.contentRect.height)
      })
    })
    observer.observe(element)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [enabled, ref])

  return size
}
