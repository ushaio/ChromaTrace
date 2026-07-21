interface ControlProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  signed?: boolean
  onChange: (value: number) => void
}

export function Control({ label, value, min, max, step = 1, suffix = '', signed = true, onChange }: ControlProps) {
  const percent = ((value - min) / (max - min)) * 100
  const prefix = signed && value > 0 ? '+' : ''
  return (
    <label className="control">
      <span className="control__head"><span>{label}</span><output>{prefix}{Number(value.toFixed(2))}{suffix}</output></span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ '--fill': `${percent}%` } as React.CSSProperties}
      />
    </label>
  )
}
