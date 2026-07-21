import { RotateCcw } from 'lucide-react'
import { useState, type Dispatch, type SetStateAction } from 'react'
import { CURVE_IDENTITY, HSL_CHANNELS } from '../lib/defaults'
import type {
  Adjustments, ColorGradeZoneName, CurveChannel, HslChannel,
} from '../lib/types'
import { Control } from './Control'
import { CurveEditor } from './CurveEditor'

interface FineTunePanelsProps {
  adjustments: Adjustments
  setAdjustments: Dispatch<SetStateAction<Adjustments>>
}

type NumericAdjustmentKey = Exclude<keyof Adjustments, 'curves' | 'hsl' | 'colorGrading' | 'calibration'>

const basicControls: Array<[NumericAdjustmentKey, string, number, number, number?]> = [
  ['exposure', '曝光', -3, 3, 0.05],
  ['contrast', '对比度', -100, 100],
  ['highlights', '高光', -100, 100],
  ['shadows', '阴影', -100, 100],
  ['whites', '白色', -100, 100],
  ['blacks', '黑色', -100, 100],
]

const colorControls: Array<[NumericAdjustmentKey, string, number, number]> = [
  ['temperature', '色温', -100, 100],
  ['tint', '色调', -100, 100],
  ['vibrance', '自然饱和度', -100, 100],
  ['saturation', '饱和度', -100, 100],
]

const curveMeta: Record<CurveChannel, { label: string; short: string; color: string }> = {
  master: { label: '总明度', short: 'M', color: '#d8ddd6' },
  red: { label: '红通道', short: 'R', color: '#f06f6f' },
  green: { label: '绿通道', short: 'G', color: '#74d69a' },
  blue: { label: '蓝通道', short: 'B', color: '#72a8ff' },
}

const hslMeta: Record<HslChannel, { label: string; color: string }> = {
  red: { label: '红', color: '#e95b5b' },
  orange: { label: '橙', color: '#e9974f' },
  yellow: { label: '黄', color: '#dfc84d' },
  green: { label: '绿', color: '#69b96f' },
  aqua: { label: '青', color: '#52b9b2' },
  blue: { label: '蓝', color: '#568dd6' },
  purple: { label: '紫', color: '#8b6fc8' },
  magenta: { label: '洋红', color: '#c963a2' },
}

const gradeMeta: Record<ColorGradeZoneName, { label: string; short: string }> = {
  shadows: { label: '阴影', short: 'S' },
  midtones: { label: '中间调', short: 'M' },
  highlights: { label: '高光', short: 'H' },
}

export function FineTunePanels({ adjustments, setAdjustments }: FineTunePanelsProps) {
  const [curveChannel, setCurveChannel] = useState<CurveChannel>('master')
  const [hslChannel, setHslChannel] = useState<HslChannel>('orange')
  const [gradeZone, setGradeZone] = useState<ColorGradeZoneName>('shadows')

  const setNumeric = (key: NumericAdjustmentKey, value: number) => {
    setAdjustments((current) => ({ ...current, [key]: value }))
  }

  const setCurvePoint = (index: number, value: number) => {
    setAdjustments((current) => ({
      ...current,
      curves: {
        ...current.curves,
        [curveChannel]: current.curves[curveChannel].map((point, pointIndex) => pointIndex === index ? value : point),
      },
    }))
  }

  const setHsl = (key: 'hue' | 'saturation' | 'luminance', value: number) => {
    setAdjustments((current) => ({
      ...current,
      hsl: {
        ...current.hsl,
        [hslChannel]: { ...current.hsl[hslChannel], [key]: value },
      },
    }))
  }

  const setGrade = (key: 'hue' | 'saturation' | 'luminance', value: number) => {
    setAdjustments((current) => ({
      ...current,
      colorGrading: {
        ...current.colorGrading,
        [gradeZone]: { ...current.colorGrading[gradeZone], [key]: value },
      },
    }))
  }

  return (
    <>
      <section className="module">
        <div className="module__heading"><div><span className="kicker">LIGHT</span><h3>基础明暗</h3></div><span>6 PARAMS</span></div>
        {basicControls.map(([key, label, min, max, step]) => (
          <Control key={key} label={label} value={adjustments[key]} min={min} max={max} step={step} onChange={(value) => setNumeric(key, value)} />
        ))}
      </section>

      <section className="module">
        <div className="module__heading"><div><span className="kicker">COLOR</span><h3>基础色彩</h3></div><span>4 PARAMS</span></div>
        {colorControls.map(([key, label, min, max]) => (
          <Control key={key} label={label} value={adjustments[key]} min={min} max={max} onChange={(value) => setNumeric(key, value)} />
        ))}
      </section>

      <section className="module curve-module">
        <div className="module__heading">
          <div><span className="kicker">CURVE</span><h3>点曲线 · {curveMeta[curveChannel].label}</h3></div>
          <button className="module-reset" aria-label="重置当前曲线" onClick={() => setAdjustments((current) => ({
            ...current,
            curves: { ...current.curves, [curveChannel]: [...CURVE_IDENTITY] },
          }))}><RotateCcw size={12}/></button>
        </div>
        <div className="compact-tabs" role="tablist" aria-label="曲线通道">
          {(Object.keys(curveMeta) as CurveChannel[]).map((channel) => (
            <button
              key={channel}
              role="tab"
              aria-selected={curveChannel === channel}
              className={curveChannel === channel ? 'is-active' : ''}
              style={{ '--tab-color': curveMeta[channel].color } as React.CSSProperties}
              onClick={() => setCurveChannel(channel)}
            >{curveMeta[channel].short}</button>
          ))}
        </div>
        <CurveEditor
          label={curveMeta[curveChannel].label}
          color={curveMeta[curveChannel].color}
          values={adjustments.curves[curveChannel]}
          onChange={setCurvePoint}
        />
        <p className="module__hint">自动分位数曲线作为基线；这里的点曲线用于二次精修。</p>
      </section>

      <section className="module">
        <div className="module__heading"><div><span className="kicker">HSL / 8 BAND</span><h3>分颜色调整</h3></div><span>{hslMeta[hslChannel].label}</span></div>
        <div className="hsl-tabs" role="tablist" aria-label="HSL 色相通道">
          {HSL_CHANNELS.map((channel) => (
            <button
              key={channel}
              role="tab"
              title={hslMeta[channel].label}
              aria-label={hslMeta[channel].label}
              aria-selected={hslChannel === channel}
              className={hslChannel === channel ? 'is-active' : ''}
              style={{ '--hsl-color': hslMeta[channel].color } as React.CSSProperties}
              onClick={() => setHslChannel(channel)}
            />
          ))}
        </div>
        <Control label="色相" value={adjustments.hsl[hslChannel].hue} min={-100} max={100} onChange={(value) => setHsl('hue', value)} />
        <Control label="饱和度" value={adjustments.hsl[hslChannel].saturation} min={-100} max={100} onChange={(value) => setHsl('saturation', value)} />
        <Control label="明度" value={adjustments.hsl[hslChannel].luminance} min={-100} max={100} onChange={(value) => setHsl('luminance', value)} />
      </section>

      <section className="module">
        <div className="module__heading"><div><span className="kicker">COLOR GRADING</span><h3>三分区色轮</h3></div><span>{gradeMeta[gradeZone].label}</span></div>
        <div className="compact-tabs grade-tabs" role="tablist" aria-label="色彩分级区域">
          {(Object.keys(gradeMeta) as ColorGradeZoneName[]).map((zone) => (
            <button key={zone} role="tab" aria-selected={gradeZone === zone} className={gradeZone === zone ? 'is-active' : ''} onClick={() => setGradeZone(zone)}>
              {gradeMeta[zone].short}
            </button>
          ))}
        </div>
        <div className="grade-color-chip" style={{ '--grade-hue': adjustments.colorGrading[gradeZone].hue } as React.CSSProperties}>
          <span />{gradeMeta[gradeZone].label}色相
        </div>
        <Control label="色相" value={adjustments.colorGrading[gradeZone].hue} min={0} max={360} signed={false} suffix="°" onChange={(value) => setGrade('hue', value)} />
        <Control label="饱和度" value={adjustments.colorGrading[gradeZone].saturation} min={0} max={100} signed={false} onChange={(value) => setGrade('saturation', value)} />
        <Control label="明度" value={adjustments.colorGrading[gradeZone].luminance} min={-100} max={100} onChange={(value) => setGrade('luminance', value)} />
        <div className="module-divider" />
        <Control label="平衡" value={adjustments.colorGrading.balance} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, colorGrading: { ...current.colorGrading, balance: value } }))} />
        <Control label="混合" value={adjustments.colorGrading.blending} min={0} max={100} signed={false} onChange={(value) => setAdjustments((current) => ({ ...current, colorGrading: { ...current.colorGrading, blending: value } }))} />
      </section>

      <section className="module">
        <div className="module__heading"><div><span className="kicker">CALIBRATION</span><h3>三原色校准</h3></div><span>CONSTRAINED</span></div>
        <Control label="红原色色相" value={adjustments.calibration.redHue} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, redHue: value } }))} />
        <Control label="红原色饱和度" value={adjustments.calibration.redSaturation} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, redSaturation: value } }))} />
        <Control label="绿原色色相" value={adjustments.calibration.greenHue} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, greenHue: value } }))} />
        <Control label="绿原色饱和度" value={adjustments.calibration.greenSaturation} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, greenSaturation: value } }))} />
        <Control label="蓝原色色相" value={adjustments.calibration.blueHue} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, blueHue: value } }))} />
        <Control label="蓝原色饱和度" value={adjustments.calibration.blueSaturation} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, blueSaturation: value } }))} />
      </section>

      <section className="module">
        <div className="module__heading"><div><span className="kicker">FINISH</span><h3>质感与输出</h3></div><span>JPEG</span></div>
        <Control label="褪色" value={adjustments.fade} min={0} max={100} signed={false} onChange={(value) => setNumeric('fade', value)} />
        <Control label="颗粒" value={adjustments.grain} min={0} max={100} signed={false} onChange={(value) => setNumeric('grain', value)} />
        <p className="module__hint">导出时会重新处理最长边不超过 2400px 的图片。</p>
      </section>
    </>
  )
}
