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

    /*
     * 首次测量必须与 ResizeObserver 同基准（content box）。
     *
     * 原先用 `getBoundingClientRect()`（border box），比 RO 回调里的 `contentRect` 多一个 border
     * 宽度，于是「稳定尺寸」会被更新两次：一次是这里的 border box，一次是 RO 随后回填的 content box。
     * 对预览框这类「尺寸一变就重栅格化」的消费方，等于每次进页面都白跑一次全图
     * `drawImage` + `getImageData`（视口级数百毫秒）。`clientWidth/Height` 与 contentRect 同基准，
     * 且本 hook 的两个调用点（追色 / 调色预览框）都没有 padding，两者数值一致。
     */
    apply(element.clientWidth, element.clientHeight)

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
