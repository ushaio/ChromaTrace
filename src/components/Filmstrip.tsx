import { Layers, LoaderCircle, Link2, ScanSearch, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspacePhoto } from '../lib/types'

/** 固定 72px 图片 + 左右内边距；缩略图栏高度固定 96px，不参与布局动画。 */
const ITEM_SIZE = 72
const ITEM_STRIDE = 80
const TRACK_PADDING = 12
/** 一屏内渲染可见项 ±20 个，够用且不引入虚拟列表依赖。 */
const OVERSCAN = 20
const EMPTY_SELECTION: string[] = []

export interface FilmstripProps {
  photos: WorkspacePhoto[]
  currentId: string | null
  selection: string[]
  thumbUrls: Record<string, string>
  busy?: boolean
  onSelect: (photoId: string) => void
  onSelectionChange: (photoIds: string[]) => void
  onApplyRecipe: () => void
  onClearWorkspace: () => void
  onFocusAbsentVolumes: () => void
}

function statusLabel(photo: WorkspacePhoto): string | null {
  if (photo.status === 'copying' || photo.status === 'pending') return '待复制'
  if (photo.status === 'failed') return '复制失败'
  if (photo.status === 'missing') return '断链'
  return null
}

/**
 * 缩略图导航栏。
 *
 * 硬约束：固定高度、绝不参与布局动画。预览框尺寸由 `useElementSize` 观测，而预览派生数据
 * 内含全图 `drawImage` + `getImageData` 并牵动 GPU 纹理重建——一旦这里的高度会随交互变化，
 * 鼠标每次扫过都会重跑一整轮。
 */
export function Filmstrip({
  photos, currentId, selection, thumbUrls, busy = false,
  onSelect, onSelectionChange, onApplyRecipe, onClearWorkspace, onFocusAbsentVolumes,
}: FilmstripProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const anchorIndex = useRef<number | null>(null)
  const [viewport, setViewport] = useState({ scrollLeft: 0, width: 0 })

  const selectedSet = useMemo(() => new Set(selection), [selection])
  const indexOf = useMemo(() => {
    const map = new Map<string, number>()
    photos.forEach((photo, index) => map.set(photo.id, index))
    return map
  }, [photos])

  /*
   * 读取滚动位置，并且只在真的变化时才 setState。
   * 旧实现每次都新建 { scrollLeft, width } 对象，于是滚动期间每一帧都要重渲染整条缩略图栏
   * （可见项 ±20，共几十个 button + img），把滚动和键盘切图拖成掉帧。
   */
  const measure = useCallback(() => {
    const node = scrollerRef.current
    if (!node) return
    const next = { scrollLeft: node.scrollLeft, width: node.clientWidth }
    setViewport((previous) => (
      previous.scrollLeft === next.scrollLeft && previous.width === next.width ? previous : next
    ))
  }, [])

  /** scroll 事件频率远高于渲染所需：合并到一帧里读一次，避免每个事件都触发一轮渲染。 */
  const measureFrame = useRef(0)
  const scheduleMeasure = useCallback(() => {
    if (measureFrame.current !== 0) return
    measureFrame.current = window.requestAnimationFrame(() => {
      measureFrame.current = 0
      measure()
    })
  }, [measure])
  useEffect(() => () => {
    if (measureFrame.current !== 0) window.cancelAnimationFrame(measureFrame.current)
  }, [])

  useEffect(() => {
    measure()
    const node = scrollerRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(node)
    return () => observer.disconnect()
  }, [measure, photos.length])

  /*
   * 选中变化时把当前图滚进可见范围。
   *
   * 目标可能落在虚拟窗口之外（还没渲染），那时 querySelector 取不到节点，所以先做一次瞬时粗调把
   * 它拉进渲染窗口；已经渲染则交给浏览器就近对齐。旧实现「先 smooth scrollTo、再 scrollIntoView」
   * 会让两个滚动动画互相打断，而滚动动画期间每一帧的 scroll 事件又反过来触发整条缩略图栏重渲染。
   */
  useEffect(() => {
    if (!currentId) return
    const index = indexOf.get(currentId)
    const node = scrollerRef.current
    if (index === undefined || !node) return
    const element = node.querySelector<HTMLElement>(`[data-photo-id="${CSS.escape(currentId)}"]`)
    if (element) {
      element.scrollIntoView({ inline: 'nearest', block: 'nearest' })
      return
    }
    node.scrollLeft = Math.max(0, TRACK_PADDING + index * ITEM_STRIDE - node.clientWidth / 2 + ITEM_SIZE / 2)
  }, [currentId, indexOf])

  const visibleIndexes = useMemo(() => {
    if (viewport.width === 0) {
      return photos.map((_, index) => index).slice(0, OVERSCAN * 2 + 8)
    }
    const first = Math.max(0, Math.floor(viewport.scrollLeft / ITEM_STRIDE) - OVERSCAN)
    const last = Math.min(
      photos.length - 1,
      Math.ceil((viewport.scrollLeft + viewport.width) / ITEM_STRIDE) + OVERSCAN,
    )
    const indexes = new Set<number>()
    for (let index = first; index <= last; index += 1) indexes.add(index)
    // 当前项与选中项永远渲染，保证 scrollIntoView / 高亮不会落空
    if (currentId) {
      const index = indexOf.get(currentId)
      if (index !== undefined) indexes.add(index)
    }
    for (const id of selection) {
      const index = indexOf.get(id)
      if (index !== undefined) indexes.add(index)
    }
    return [...indexes].sort((left, right) => left - right)
    // viewport 变化需要重算窗口
  }, [viewport, photos, currentId, selection, indexOf])

  const handleActivate = useCallback((event: React.MouseEvent, index: number, photo: WorkspacePhoto) => {
    const additive = event.ctrlKey || event.metaKey
    const ranged = event.shiftKey

    if (ranged && anchorIndex.current !== null) {
      const [start, end] = anchorIndex.current <= index
        ? [anchorIndex.current, index]
        : [index, anchorIndex.current]
      onSelectionChange(photos.slice(start, end + 1).map((item) => item.id))
      onSelect(photo.id)
      return
    }
    if (additive) {
      const next = selectedSet.has(photo.id)
        ? selection.filter((id) => id !== photo.id)
        : [...selection, photo.id]
      onSelectionChange(next.length > 0 ? next : [photo.id])
    }
    anchorIndex.current = index
    onSelect(photo.id)
  }, [onSelect, onSelectionChange, photos, selectedSet, selection])

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (photos.length === 0) return
    const current = currentId ? indexOf.get(currentId) ?? 0 : 0
    const move = (target: number) => {
      const next = Math.min(photos.length - 1, Math.max(0, target))
      const photo = photos[next]
      anchorIndex.current = next
      onSelect(photo.id)
      event.preventDefault()
    }
    if (event.key === 'ArrowLeft') move(current - 1)
    else if (event.key === 'ArrowRight') move(current + 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(photos.length - 1)
  }, [currentId, indexOf, onSelect, photos])

  if (photos.length === 0) return null

  const currentPhoto = currentId ? photos.find((photo) => photo.id === currentId) ?? null : null
  const canApply = selection.length > 1 && Boolean(currentPhoto?.develop)
  const readyCount = photos.filter((photo) => photo.status === 'ready').length

  return (
    <div className="filmstrip">
      <div
        className="filmstrip__scroller"
        ref={scrollerRef}
        onScroll={scheduleMeasure}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="tablist"
        aria-label="工作区图片"
      >
        <div
          className="filmstrip__track"
          style={{ width: photos.length * ITEM_STRIDE + TRACK_PADDING * 2 }}
        >
          {visibleIndexes.map((index) => {
            const photo = photos[index]
            if (!photo) return null
            const badge = statusLabel(photo)
            const isCurrent = photo.id === currentId
            const isSelected = selectedSet.has(photo.id)
            const url = thumbUrls[photo.id]
            return (
              <button
                key={photo.id}
                type="button"
                role="tab"
                data-photo-id={photo.id}
                aria-selected={isCurrent}
                title={`${photo.relativeSourcePath}${badge ? ` · ${badge}` : ''}`}
                className={[
                  'filmstrip__item',
                  isCurrent ? 'is-active' : '',
                  isSelected ? 'is-selected' : '',
                  photo.status !== 'ready' ? 'is-unavailable' : '',
                ].filter(Boolean).join(' ')}
                style={{ left: index * ITEM_STRIDE + TRACK_PADDING, width: ITEM_SIZE }}
                onClick={(event) => handleActivate(event, index, photo)}
              >
                {url
                  ? <img src={url} alt="" draggable={false} />
                  : (
                    <span className="filmstrip__placeholder" aria-hidden="true">
                      {photo.status === 'ready' ? <LoaderCircle className="spin" size={14} /> : null}
                    </span>
                  )}
                {photo.isRaw ? <i className="filmstrip__badge filmstrip__badge--raw">RAW</i> : null}
                {badge ? <i className="filmstrip__badge filmstrip__badge--status">{badge}</i> : null}
                {photo.editedAt !== null ? <i className="filmstrip__dot filmstrip__dot--edited" title="已修" /> : null}
                {photo.referenceOverride ? <i className="filmstrip__dot filmstrip__dot--override" title="专属参考" /> : null}
                {photo.origin === 'copy' ? null : <i className="filmstrip__badge filmstrip__badge--link"><Link2 size={9} /></i>}
              </button>
            )
          })}
        </div>
      </div>

      <div className="filmstrip__tools">
        <span className="filmstrip__count">
          <Layers size={13} />
          {readyCount}/{photos.length}
          {selection.length > 1 ? ` · 已选 ${selection.length}` : ''}
        </span>
        {photos.some((photo) => photo.status === 'missing') ? (
          <button type="button" className="filmstrip__link" onClick={onFocusAbsentVolumes}>
            <ScanSearch size={13} /> 查看不可用设备
          </button>
        ) : null}
        <button
          type="button"
          className="button button--dark button--compact"
          disabled={!canApply || busy}
          title={canApply ? '把当前配方套用到所选图片' : '需要选中多张图片，且当前图已有配方'}
          onClick={onApplyRecipe}
        >
          套用到所选
        </button>
        <button
          type="button"
          className="button button--dark button--compact filmstrip__danger"
          disabled={busy}
          onClick={onClearWorkspace}
        >
          <Trash2 size={14} /> 清空工作区
        </button>
      </div>
    </div>
  )
}

/** 供上层沿用同一份空数组，避免每次渲染都新建 Set 依赖。 */
export const EMPTY_FILMSTRIP_SELECTION = EMPTY_SELECTION
