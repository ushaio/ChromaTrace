import { useId, useRef } from 'react'

interface CurveEditorProps {
  values: number[]
  color: string
  label: string
  onChange: (values: number[]) => void
}

const WIDTH = 260
const HEIGHT = 132
const PADDING = 10
const EDIT_SAMPLES = 17

function clamp(value: number) {
  return Math.min(1, Math.max(0, value))
}

function resampleCurve(values: number[], count = EDIT_SAMPLES) {
  const source = values.length >= 2 && values.every(Number.isFinite)
    ? values.map(clamp)
    : [0, 0.25, 0.5, 0.75, 1]
  return Array.from({ length: count }, (_, index) => {
    const position = index / (count - 1) * (source.length - 1)
    const lower = Math.floor(position)
    const upper = Math.min(source.length - 1, lower + 1)
    return source[lower] + (source[upper] - source[lower]) * (position - lower)
  })
}

function normalizeMonotonic(values: number[]) {
  const normalized = values.map(clamp)
  for (let index = 1; index < normalized.length; index += 1) {
    normalized[index] = Math.max(normalized[index - 1], normalized[index])
  }
  return normalized
}

export function CurveEditor({ values, color, label, onChange }: CurveEditorProps) {
  const drag = useRef<{ x: number; y: number; values: number[] } | null>(null)
  const gradientId = `curve-fill-${useId().replace(/:/g, '')}`
  const displayValues = resampleCurve(values)
  const pointX = (index: number) => PADDING + index * (WIDTH - PADDING * 2) / (displayValues.length - 1)
  const pointY = (value: number) => PADDING + (1 - value) * (HEIGHT - PADDING * 2)
  const path = displayValues.map((value, index) => `${index === 0 ? 'M' : 'L'} ${pointX(index)} ${pointY(value)}`).join(' ')

  const pointerPosition = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: clamp((event.clientX - bounds.left - PADDING) / Math.max(1, bounds.width - PADDING * 2)),
      y: clamp(1 - (event.clientY - bounds.top - PADDING) / Math.max(1, bounds.height - PADDING * 2)),
    }
  }

  const updateFromPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return
    const next = pointerPosition(event)
    const delta = next.y - drag.current.y
    if (Math.abs(delta) < 0.0001) return
    const adjusted = drag.current.values.map((value, index) => {
      const x = index / (drag.current!.values.length - 1)
      const distance = (x - next.x) / 0.13
      return value + delta * Math.exp(-0.5 * distance * distance)
    })
    const normalized = normalizeMonotonic(adjusted)
    onChange(normalized)
    drag.current = { ...next, values: normalized }
  }

  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div className='curve-editor'>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role='slider'
        tabIndex={0}
        aria-label={`${label}曲线`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(displayValues[Math.floor(displayValues.length / 2)] * 100)}
        onPointerDown={(event) => {
          drag.current = { ...pointerPosition(event), values: displayValues }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={updateFromPointer}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <linearGradient id={gradientId} x1='0' y1='1' x2='0' y2='0'>
            <stop offset='0' stopColor={color} stopOpacity='0' />
            <stop offset='1' stopColor={color} stopOpacity='0.18' />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((line) => {
          const position = PADDING + line * (WIDTH - PADDING * 2) / 4
          const vertical = `M ${position} ${PADDING} V ${HEIGHT - PADDING}`
          const horizontalPosition = PADDING + line * (HEIGHT - PADDING * 2) / 4
          const horizontal = `M ${PADDING} ${horizontalPosition} H ${WIDTH - PADDING}`
          return <path key={line} className='curve-grid' d={`${vertical} ${horizontal}`} />
        })}
        <path className='curve-diagonal' d={`M ${PADDING} ${HEIGHT - PADDING} L ${WIDTH - PADDING} ${PADDING}`} />
        <path fill={`url(#${gradientId})`} d={`${path} L ${WIDTH - PADDING} ${HEIGHT - PADDING} L ${PADDING} ${HEIGHT - PADDING} Z`} />
        <path className='curve-line' stroke={color} d={path} />
      </svg>
    </div>
  )
}
