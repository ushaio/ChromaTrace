interface HistogramProps {
  values?: number[]
}

export function Histogram({ values }: HistogramProps) {
  const data = values?.length ? values : Array.from({ length: 24 }, (_, index) => 0.08 + Math.sin(index * 0.8) * 0.025)
  const max = Math.max(...data, 0.001)
  const points = data.map((value, index) => `${(index / (data.length - 1)) * 100},${40 - (value / max) * 36}`).join(' ')
  return (
    <svg className="histogram" viewBox="0 0 100 42" preserveAspectRatio="none" aria-label="亮度直方图">
      <defs>
        <linearGradient id="hist-fill" x1="0" x2="1"><stop stopColor="#7ae0d4"/><stop offset=".52" stopColor="#f0dbb4"/><stop offset="1" stopColor="#ff9978"/></linearGradient>
      </defs>
      <path d={`M0,42 L${points} L100,42 Z`} fill="url(#hist-fill)" opacity=".24" />
      <polyline points={points} fill="none" stroke="url(#hist-fill)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
