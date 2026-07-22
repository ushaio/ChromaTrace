import { Columns2, FlipHorizontal2, Rows2, SquareSplitHorizontal } from 'lucide-react'
import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject } from 'react'

export type CompareMode = 'wipe' | 'side' | 'stack' | 'toggle'

const MODES: Array<{ id: CompareMode; label: string; short: string; icon: typeof Columns2 }> = [
  { id: 'wipe', label: '滑动对比', short: '滑动', icon: SquareSplitHorizontal },
  { id: 'side', label: '左右分屏', short: '左右', icon: Columns2 },
  { id: 'stack', label: '上下分屏', short: '上下', icon: Rows2 },
  { id: 'toggle', label: '切换对比', short: '切换', icon: FlipHorizontal2 },
]

interface CompareModeControlsProps {
  mode: CompareMode
  onChange: (mode: CompareMode) => void
  disabled?: boolean
}

export function CompareModeControls({ mode, onChange, disabled }: CompareModeControlsProps) {
  return (
    <div className="compare-mode" role="radiogroup" aria-label="预览对比方式">
      {MODES.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={mode === id}
          aria-label={label}
          title={label}
          disabled={disabled}
          className={`icon-button compare-mode__btn ${mode === id ? 'is-active' : ''}`}
          onClick={() => onChange(id)}
        >
          <Icon size={15} strokeWidth={1.9} />
        </button>
      ))}
    </div>
  )
}

interface CompareSliderProps {
  value: number
  onChange: (value: number) => void
  label?: string
  disabled?: boolean
}

/** Wipe position (0–100) or toggle polarity in toggle mode. */
export function CompareSlider({ value, onChange, label = '对比', disabled }: CompareSliderProps) {
  return (
    <div className={`view-switch ${disabled ? 'is-disabled' : ''}`}>
      <span>{label}</span>
      <input
        aria-label={label}
        type="range"
        min="0"
        max="100"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{value}%</output>
    </div>
  )
}

export function previewFrameClass(mode: CompareMode, hasImage: boolean, hasAfter: boolean) {
  const parts = ['preview-frame', `preview-frame--${mode}`]
  if (hasImage) parts.push('has-image')
  if (hasAfter) parts.push('has-after')
  return parts.join(' ')
}

/** Style for the after layer under each compare mode. */
export function afterLayerStyle(mode: CompareMode, compare: number, hasAfter: boolean): CSSProperties | undefined {
  if (!hasAfter) return { display: 'none' }
  if (mode === 'wipe') return { clipPath: `inset(0 0 0 ${compare}%)` }
  if (mode === 'toggle') return { opacity: compare >= 50 ? 1 : 0, pointerEvents: compare >= 50 ? 'auto' : 'none' }
  return undefined
}

export function compareDividerStyle(mode: CompareMode, compare: number): CSSProperties | undefined {
  if (mode === 'wipe') return { left: `${compare}%` }
  if (mode === 'side') return { left: '50%' }
  if (mode === 'stack') return { top: '50%', left: 0, right: 0, width: 'auto', height: 1 }
  return undefined
}


interface CompareDividerProps {
  mode: CompareMode
  value: number
  onChange: (value: number) => void
  frameRef: RefObject<HTMLDivElement | null>
}

function clampCompare(value: number) {
  return Math.min(100, Math.max(0, value))
}

export function CompareDivider({ mode, value, onChange, frameRef }: CompareDividerProps) {
  const draggable = mode === 'wipe'

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const frame = frameRef.current
    if (!frame) return
    const rect = frame.getBoundingClientRect()
    if (rect.width <= 0) return
    onChange(clampCompare(((event.clientX - rect.left) / rect.width) * 100))
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggable) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    updateFromPointer(event)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggable || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    updateFromPointer(event)
  }

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!draggable) return
    const step = event.shiftKey ? 5 : 1
    let next = value
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next -= step
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next += step
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = 100
    else return
    event.preventDefault()
    onChange(clampCompare(next))
  }

  return (
    <div
      className={`compare-line ${mode === 'stack' ? 'compare-line--horizontal' : ''} ${draggable ? 'compare-line--draggable' : ''}`}
      style={compareDividerStyle(mode, value)}
      role={draggable ? 'slider' : undefined}
      aria-label={draggable ? '前后对比分割线' : undefined}
      aria-valuemin={draggable ? 0 : undefined}
      aria-valuemax={draggable ? 100 : undefined}
      aria-valuenow={draggable ? Math.round(value) : undefined}
      aria-valuetext={draggable ? `分割位置 ${Math.round(value)}%` : undefined}
      tabIndex={draggable ? 0 : -1}
      title={draggable ? '拖动分割线对比前后' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onKeyDown={handleKeyDown}
    >
      <span><SquareSplitHorizontal size={13} /></span>
    </div>
  )
}

export function compareModeHint(mode: CompareMode) {
  if (mode === 'wipe') return '拖动分割线对比前后'
  if (mode === 'side') return '左右并排对比'
  if (mode === 'stack') return '上下并排对比'
  return '滑块 <50% 显示前 · ≥50% 显示后'
}
