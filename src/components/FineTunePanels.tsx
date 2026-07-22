import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react'
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
type ModuleId =
  | 'light'
  | 'color'
  | 'curve'
  | 'hsl'
  | 'grading'
  | 'calibration'
  | 'detail'
  | 'finish'

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

interface CollapsibleModuleProps {
  title: string
  meta?: ReactNode
  collapsed: boolean
  onToggle: () => void
  className?: string
  children: ReactNode
}

function CollapsibleModule({
  title,
  meta,
  collapsed,
  onToggle,
  className = '',
  children,
}: CollapsibleModuleProps) {
  return (
    <section className={`module ${collapsed ? 'is-collapsed' : ''} ${className}`.trim()}>
      <div className="module__heading">
        <button
          type="button"
          className="module__fold"
          title={collapsed ? '展开' : '折叠'}
          aria-label={collapsed ? `展开${title}` : `折叠${title}`}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <div
          className="module__title"
          title="双击折叠 / 展开"
          onDoubleClick={(event) => {
            event.preventDefault()
            onToggle()
          }}
        >
          <h3>{title}</h3>
        </div>
        {meta ? <div className="module__meta">{meta}</div> : null}
      </div>
      {!collapsed ? <div className="module__body">{children}</div> : null}
    </section>
  )
}

export function FineTunePanels({ adjustments, setAdjustments }: FineTunePanelsProps) {
  const [curveChannel, setCurveChannel] = useState<CurveChannel>('master')
  const [hslChannel, setHslChannel] = useState<HslChannel>('orange')
  const [gradeZone, setGradeZone] = useState<ColorGradeZoneName>('shadows')
  const [collapsed, setCollapsed] = useState<Partial<Record<ModuleId, boolean>>>({})

  const isCollapsed = (id: ModuleId) => Boolean(collapsed[id])
  const toggle = (id: ModuleId) => {
    setCollapsed((current) => ({ ...current, [id]: !current[id] }))
  }

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
      <CollapsibleModule
        title="基础明暗"
        collapsed={isCollapsed('light')}
        onToggle={() => toggle('light')}
      >
        {basicControls.map(([key, label, min, max, step]) => (
          <Control key={key} label={label} value={adjustments[key]} min={min} max={max} step={step} onChange={(value) => setNumeric(key, value)} />
        ))}
      </CollapsibleModule>

      <CollapsibleModule
        title="基础色彩"
        collapsed={isCollapsed('color')}
        onToggle={() => toggle('color')}
      >
        {colorControls.map(([key, label, min, max]) => (
          <Control key={key} label={label} value={adjustments[key]} min={min} max={max} onChange={(value) => setNumeric(key, value)} />
        ))}
      </CollapsibleModule>

      <CollapsibleModule
        title={`点曲线 · ${curveMeta[curveChannel].label}`}
        meta={(
          <button
            type="button"
            className="module-reset"
            aria-label="重置当前曲线"
            onClick={(event) => {
              event.stopPropagation()
              setAdjustments((current) => ({
                ...current,
                curves: { ...current.curves, [curveChannel]: [...CURVE_IDENTITY] },
              }))
            }}
          >
            <RotateCcw size={12}/>
          </button>
        )}
        collapsed={isCollapsed('curve')}
        onToggle={() => toggle('curve')}
        className="curve-module"
      >
        <div className="compact-tabs" role="tablist" aria-label="曲线通道">
          {(Object.keys(curveMeta) as CurveChannel[]).map((channel) => (
            <button
              key={channel}
              type="button"
              role="tab"
              aria-selected={curveChannel === channel}
              className={curveChannel === channel ? 'is-active' : ''}
              style={{ '--tab-color': curveMeta[channel].color } as CSSProperties}
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
      </CollapsibleModule>

      <CollapsibleModule
        title="分颜色调整"
        meta={<span>{hslMeta[hslChannel].label}</span>}
        collapsed={isCollapsed('hsl')}
        onToggle={() => toggle('hsl')}
      >
        <div className="hsl-tabs" role="tablist" aria-label="HSL 色相通道">
          {HSL_CHANNELS.map((channel) => (
            <button
              key={channel}
              type="button"
              role="tab"
              title={hslMeta[channel].label}
              aria-label={hslMeta[channel].label}
              aria-selected={hslChannel === channel}
              className={hslChannel === channel ? 'is-active' : ''}
              style={{ '--hsl-color': hslMeta[channel].color } as CSSProperties}
              onClick={() => setHslChannel(channel)}
            />
          ))}
        </div>
        <Control label="色相" value={adjustments.hsl[hslChannel].hue} min={-100} max={100} onChange={(value) => setHsl('hue', value)} />
        <Control label="饱和度" value={adjustments.hsl[hslChannel].saturation} min={-100} max={100} onChange={(value) => setHsl('saturation', value)} />
        <Control label="明度" value={adjustments.hsl[hslChannel].luminance} min={-100} max={100} onChange={(value) => setHsl('luminance', value)} />
      </CollapsibleModule>

      <CollapsibleModule
        title="三分区色轮"
        meta={<span>{gradeMeta[gradeZone].label}</span>}
        collapsed={isCollapsed('grading')}
        onToggle={() => toggle('grading')}
      >
        <div className="compact-tabs grade-tabs" role="tablist" aria-label="色彩分级区域">
          {(Object.keys(gradeMeta) as ColorGradeZoneName[]).map((zone) => (
            <button
              key={zone}
              type="button"
              role="tab"
              aria-selected={gradeZone === zone}
              className={gradeZone === zone ? 'is-active' : ''}
              onClick={() => setGradeZone(zone)}
            >
              {gradeMeta[zone].short}
            </button>
          ))}
        </div>
        <div className="grade-color-chip" style={{ '--grade-hue': adjustments.colorGrading[gradeZone].hue } as CSSProperties}>
          <span />{gradeMeta[gradeZone].label}色相
        </div>
        <Control label="色相" value={adjustments.colorGrading[gradeZone].hue} min={0} max={360} signed={false} suffix="°" onChange={(value) => setGrade('hue', value)} />
        <Control label="饱和度" value={adjustments.colorGrading[gradeZone].saturation} min={0} max={100} signed={false} onChange={(value) => setGrade('saturation', value)} />
        <Control label="明度" value={adjustments.colorGrading[gradeZone].luminance} min={-100} max={100} onChange={(value) => setGrade('luminance', value)} />
        <div className="module-divider" />
        <Control label="平衡" value={adjustments.colorGrading.balance} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, colorGrading: { ...current.colorGrading, balance: value } }))} />
        <Control label="混合" value={adjustments.colorGrading.blending} min={0} max={100} signed={false} onChange={(value) => setAdjustments((current) => ({ ...current, colorGrading: { ...current.colorGrading, blending: value } }))} />
      </CollapsibleModule>

      <CollapsibleModule
        title="三原色校准"
        collapsed={isCollapsed('calibration')}
        onToggle={() => toggle('calibration')}
      >
        <Control label="红原色色相" value={adjustments.calibration.redHue} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, redHue: value } }))} />
        <Control label="红原色饱和度" value={adjustments.calibration.redSaturation} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, redSaturation: value } }))} />
        <Control label="绿原色色相" value={adjustments.calibration.greenHue} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, greenHue: value } }))} />
        <Control label="绿原色饱和度" value={adjustments.calibration.greenSaturation} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, greenSaturation: value } }))} />
        <Control label="蓝原色色相" value={adjustments.calibration.blueHue} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, blueHue: value } }))} />
        <Control label="蓝原色饱和度" value={adjustments.calibration.blueSaturation} min={-100} max={100} onChange={(value) => setAdjustments((current) => ({ ...current, calibration: { ...current.calibration, blueSaturation: value } }))} />
      </CollapsibleModule>

      <CollapsibleModule
        title="细节与清晰"
        collapsed={isCollapsed('detail')}
        onToggle={() => toggle('detail')}
      >
        <Control label="纹理" value={adjustments.texture} min={-100} max={100} onChange={(value) => setNumeric('texture', value)} />
        <Control label="清晰度" value={adjustments.clarity} min={-100} max={100} onChange={(value) => setNumeric('clarity', value)} />
        <Control label="去朦胧" value={adjustments.dehaze} min={-100} max={100} onChange={(value) => setNumeric('dehaze', value)} />
        <div className="module-divider" />
        <Control label="锐化" value={adjustments.sharpen} min={0} max={150} signed={false} onChange={(value) => setNumeric('sharpen', value)} />
        <Control label="锐化半径" value={adjustments.sharpenRadius} min={0.5} max={3} step={0.1} signed={false} onChange={(value) => setNumeric('sharpenRadius', value)} />
        <Control label="锐化细节" value={adjustments.sharpenDetail} min={0} max={100} signed={false} onChange={(value) => setNumeric('sharpenDetail', value)} />
        <Control label="锐化蒙版" value={adjustments.sharpenMasking} min={0} max={100} signed={false} onChange={(value) => setNumeric('sharpenMasking', value)} />
        <div className="module-divider" />
        <Control label="明亮度降噪" value={adjustments.luminanceNoiseReduction} min={0} max={100} signed={false} onChange={(value) => setNumeric('luminanceNoiseReduction', value)} />
        <Control label="颜色降噪" value={adjustments.colorNoiseReduction} min={0} max={100} signed={false} onChange={(value) => setNumeric('colorNoiseReduction', value)} />
      </CollapsibleModule>

      <CollapsibleModule
        title="质感与输出"
        collapsed={isCollapsed('finish')}
        onToggle={() => toggle('finish')}
      >
        <Control label="暗角" value={adjustments.vignette} min={-100} max={100} onChange={(value) => setNumeric('vignette', value)} />
        <Control label="暗角中点" value={adjustments.vignetteMidpoint} min={0} max={100} signed={false} onChange={(value) => setNumeric('vignetteMidpoint', value)} />
        <Control label="暗角羽化" value={adjustments.vignetteFeather} min={0} max={100} signed={false} onChange={(value) => setNumeric('vignetteFeather', value)} />
        <div className="module-divider" />
        <Control label="褪色" value={adjustments.fade} min={0} max={100} signed={false} onChange={(value) => setNumeric('fade', value)} />
        <Control label="颗粒" value={adjustments.grain} min={0} max={100} signed={false} onChange={(value) => setNumeric('grain', value)} />
        <p className="module__hint">导出按原图像素全分辨率处理（优先 GPU）。裁剪、镜头与透视校正仍未纳入像素引擎。</p>
      </CollapsibleModule>
    </>
  )
}
