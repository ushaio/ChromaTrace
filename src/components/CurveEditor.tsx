import { useId, useRef } from 'react'

interface CurveEditorProps {
  values: number[]
  color: string
  label: string
  onChange: (index: number, value: number) => void
}

const WIDTH = 260
const HEIGHT = 132
const PADDING = 10

export function CurveEditor({ values, color, label, onChange }: CurveEditorProps) {
  const activePoint = useRef<number | null>(null)
  const gradientId = `curve-fill-${useId().replace(/:/g, '')}`
  const safeValues = values.length === 5 ? values : [0, 0.25, 0.5, 0.75, 1]
  const pointX = (index: number) => PADDING + index * (WIDTH - PADDING * 2) / 4
  const pointY = (value: number) => PADDING + (1 - value) * (HEIGHT - PADDING * 2)
  const path = safeValues.map((value, index) => `${index === 0 ? 'M' : 'L'} ${pointX(index)} ${pointY(value)}`).join(' ')

  const updateFromPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (activePoint.current === null) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const normalized = 1 - (event.clientY - bounds.top - PADDING) / Math.max(1, bounds.height - PADDING * 2)
    const index = activePoint.current
    const lower = index === 0 ? 0 : safeValues[index - 1]
    const upper = index === safeValues.length - 1 ? 1 : safeValues[index + 1]
    onChange(index, Math.min(upper, Math.max(lower, normalized)))
  }

  return (
    <div className="curve-editor">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="group"
        aria-label={`${label}曲线编辑器`}
        onPointerMove={updateFromPointer}
        onPointerUp={(event) => {
          activePoint.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
        onPointerCancel={(event) => {
          activePoint.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor={color} stopOpacity="0" />
            <stop offset="1" stopColor={color} stopOpacity="0.18" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((line) => {
          const position = PADDING + line * (WIDTH - PADDING * 2) / 4
          const vertical = `M ${position} ${PADDING} V ${HEIGHT - PADDING}`
          const horizontalPosition = PADDING + line * (HEIGHT - PADDING * 2) / 4
          const horizontal = `M ${PADDING} ${horizontalPosition} H ${WIDTH - PADDING}`
          return <path key={line} className="curve-grid" d={`${vertical} ${horizontal}`} />
        })}
        <path className="curve-diagonal" d={`M ${PADDING} ${HEIGHT - PADDING} L ${WIDTH - PADDING} ${PADDING}`} />
        <path fill={`url(#${gradientId})`} d={`${path} L ${WIDTH - PADDING} ${HEIGHT - PADDING} L ${PADDING} ${HEIGHT - PADDING} Z`} />
        <path className="curve-line" stroke={color} d={path} />
        {safeValues.map((value, index) => (
          <circle
            key={index}
            className="curve-point"
            cx={pointX(index)}
            cy={pointY(value)}
            r="5"
            fill={color}
            role="slider"
            tabIndex={0}
            aria-label={`${label}曲线控制点 ${index + 1}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(value * 100)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              const direction = event.key === 'ArrowUp' ? 1 : -1
              const lower = index === 0 ? 0 : safeValues[index - 1]
              const upper = index === safeValues.length - 1 ? 1 : safeValues[index + 1]
              onChange(index, Math.min(upper, Math.max(lower, value + direction * 0.01)))
            }}
            onPointerDown={(event) => {
              activePoint.current = index
              event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
            }}
          />
        ))}
      </svg>
      <div className="curve-values" aria-hidden="true">
        {safeValues.map((value, index) => <span key={index}>{Math.round(value * 100)}</span>)}
      </div>
    </div>
  )
}
