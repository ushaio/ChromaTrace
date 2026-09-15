import { createDefaultAdjustments } from './defaults'
import type { Adjustments, CurveChannel, HslChannel } from './types'

export interface LightroomXmpPreset {
  name: string
  fileName: string
  processVersion?: string
  profile?: string
  adjustments: Adjustments
  mappedFields: string[]
  unsupportedFields: string[]
  warnings: string[]
}

const XMP_MAX_BYTES = 2 * 1024 * 1024
const CURVE_SAMPLE_X = Array.from({ length: 17 }, (_, index) => index / 16)

/** Geometric / optics transforms still outside the pixel grading engine. */
const IMPACTFUL_UNSUPPORTED_FIELDS: Record<string, string> = {
  LensProfileEnable: '镜头配置文件',
  LensManualDistortionAmount: '镜头畸变',
  PerspectiveVertical: '垂直透视',
  PerspectiveHorizontal: '水平透视',
  PerspectiveRotate: '透视旋转',
  PerspectiveScale: '透视缩放',
  PerspectiveAspect: '透视纵横比',
  PerspectiveX: '透视 X',
  PerspectiveY: '透视 Y',
  UprightVersion: 'Upright 透视',
  UprightCenterMode: 'Upright 中心',
  AutoLateralCA: '色差校正',
  CropTop: '裁剪',
  CropLeft: '裁剪',
  CropBottom: '裁剪',
  CropRight: '裁剪',
  CropAngle: '裁剪角度',
}

const HSL_CHANNELS: Array<[HslChannel, string, string]> = [
  ['red', 'Red', '红色'],
  ['orange', 'Orange', '橙色'],
  ['yellow', 'Yellow', '黄色'],
  ['green', 'Green', '绿色'],
  ['aqua', 'Aqua', '青色'],
  ['blue', 'Blue', '蓝色'],
  ['purple', 'Purple', '紫色'],
  ['magenta', 'Magenta', '洋红'],
]

const CURVE_CHANNELS: Array<[CurveChannel, string, string]> = [
  ['master', 'ToneCurvePV2012', '总曲线'],
  ['red', 'ToneCurvePV2012Red', '红色曲线'],
  ['green', 'ToneCurvePV2012Green', '绿色曲线'],
  ['blue', 'ToneCurvePV2012Blue', '蓝色曲线'],
]

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectAttributes(xml: string) {
  const values = new Map<string, string>()
  const pattern = /(?:^|\s)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (const match of xml.matchAll(pattern)) {
    values.set(match[1], decodeXml(match[2] ?? match[3] ?? ''))
  }
  return values
}

function elementBody(xml: string, localName: string) {
  const name = escapeRegExp(localName)
  const pattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${name}>`, 'i')
  return pattern.exec(xml)?.[1] || ''
}

function elementText(xml: string, localName: string) {
  const body = elementBody(xml, localName)
  if (!body) return ''
  return decodeXml(body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
}

function fieldValue(xml: string, attributes: Map<string, string>, ...keys: string[]) {
  for (const key of keys) {
    const attribute = attributes.get(key)
    if (attribute !== undefined && attribute !== '') return attribute
    const text = elementText(xml, key)
    if (text) return text
  }
  return undefined
}

function numericField(xml: string, attributes: Map<string, string>, ...keys: string[]) {
  const raw = fieldValue(xml, attributes, ...keys)
  if (raw === undefined) return undefined
  const value = Number.parseFloat(raw.replace(',', '.'))
  return Number.isFinite(value) ? value : undefined
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function parseCurve(xml: string, localName: string) {
  const body = elementBody(xml, localName)
  if (!body) return null
  const points: Array<[number, number]> = []
  const itemPattern = /<(?:[A-Za-z_][\w.-]*:)?li\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?li>/gi
  for (const match of body.matchAll(itemPattern)) {
    const values = decodeXml(match[1].replace(/<[^>]+>/g, '')).split(',').map((part) => Number.parseFloat(part.trim()))
    if (values.length >= 2 && values.every(Number.isFinite)) points.push([clamp(values[0], 0, 255), clamp(values[1], 0, 255)])
  }
  if (points.length < 2) return null
  points.sort((left, right) => left[0] - right[0])

  return CURVE_SAMPLE_X.map((sample) => {
    const target = sample * 255
    if (target <= points[0][0]) return points[0][1] / 255
    if (target >= points[points.length - 1][0]) return points[points.length - 1][1] / 255
    const rightIndex = points.findIndex(([x]) => x >= target)
    const left = points[rightIndex - 1]
    const right = points[rightIndex]
    const distance = right[0] - left[0]
    const mix = distance ? (target - left[0]) / distance : 0
    return clamp((left[1] + (right[1] - left[1]) * mix) / 255, 0, 1)
  })
}

function applyParametricCurve(base: number[], amounts: readonly number[]) {
  const centers = [0.16, 0.36, 0.64, 0.84]
  const widths = [0.2, 0.22, 0.22, 0.2]
  return CURVE_SAMPLE_X.map((x) => {
    const position = x * (base.length - 1)
    const lower = Math.floor(position)
    const upper = Math.min(base.length - 1, lower + 1)
    const value = base[lower] + (base[upper] - base[lower]) * (position - lower)
    const endpointProtection = 4 * x * (1 - x)
    const shift = amounts.reduce((sum, amount, zone) => {
      const distance = (x - centers[zone]) / widths[zone]
      const weight = Math.exp(-0.5 * distance * distance)
      return sum + clamp(amount, -100, 100) / 100 * 0.16 * weight * endpointProtection
    }, 0)
    return clamp(value + shift, 0, 1)
  })
}

function collectCrsFields(xml: string) {
  const fields = new Set<string>()
  const pattern = /\bcrs:([A-Za-z_][\w.-]*)\b/g
  for (const match of xml.matchAll(pattern)) fields.add(match[1])
  return fields
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function encodeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xmpNumber(value: number) {
  if (!Number.isFinite(value)) return '0'
  return Number(value.toFixed(4)).toString()
}

export function sanitizeXmpPresetName(name: string) {
  return name
    .trim()
    .replace(/[<>:"|?*\\/\u0000-\u001f]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .trim() || '\u65b0\u9884\u8bbe'
}

export function serializeLightroomXmp(adjustments: Adjustments, name: string) {
  const presetName = sanitizeXmpPresetName(name)
  const attributes: Array<[string, number | string]> = [
    ['crs:Name', presetName],
    ['crs:PresetType', 'Normal'],
    ['crs:ProcessVersion', '15.4'],
    ['crs:HasSettings', 'True'],
    ['crs:Exposure2012', adjustments.exposure],
    ['crs:Contrast2012', adjustments.contrast],
    ['crs:Highlights2012', adjustments.highlights],
    ['crs:Shadows2012', adjustments.shadows],
    ['crs:Whites2012', adjustments.whites],
    ['crs:Blacks2012', adjustments.blacks],
    ['crs:IncrementalTemperature', adjustments.temperature],
    ['crs:IncrementalTint', adjustments.tint],
    ['crs:Vibrance', adjustments.vibrance],
    ['crs:Saturation', adjustments.saturation],
    ['crs:Texture', adjustments.texture],
    ['crs:Clarity2012', adjustments.clarity],
    ['crs:Dehaze', adjustments.dehaze],
    ['crs:SharpenAmount', adjustments.sharpen],
    ['crs:SharpenRadius', adjustments.sharpenRadius],
    ['crs:SharpenDetail', adjustments.sharpenDetail],
    ['crs:SharpenEdgeMasking', adjustments.sharpenMasking],
    ['crs:LuminanceSmoothing', adjustments.luminanceNoiseReduction],
    ['crs:ColorNoiseReduction', adjustments.colorNoiseReduction],
    ['crs:PostCropVignetteAmount', adjustments.vignette],
    ['crs:PostCropVignetteMidpoint', adjustments.vignetteMidpoint],
    ['crs:PostCropVignetteFeather', adjustments.vignetteFeather],
    ['crs:GrainAmount', adjustments.grain],
    ['ct:Fade', adjustments.fade],
  ]

  for (const [channel, suffix] of HSL_CHANNELS) {
    attributes.push(
      [`crs:HueAdjustment${suffix}`, adjustments.hsl[channel].hue],
      [`crs:SaturationAdjustment${suffix}`, adjustments.hsl[channel].saturation],
      [`crs:LuminanceAdjustment${suffix}`, adjustments.hsl[channel].luminance],
    )
  }

  const gradeZones = [
    ['shadows', 'Shadow'],
    ['midtones', 'Midtone'],
    ['highlights', 'Highlight'],
  ] as const
  for (const [zone, suffix] of gradeZones) {
    attributes.push(
      [`crs:ColorGrade${suffix}Hue`, adjustments.colorGrading[zone].hue],
      [`crs:ColorGrade${suffix}Sat`, adjustments.colorGrading[zone].saturation],
      [`crs:ColorGrade${suffix}Lum`, adjustments.colorGrading[zone].luminance],
    )
  }
  attributes.push(
    ['crs:ColorGradeBalance', adjustments.colorGrading.balance],
    ['crs:ColorGradeBlending', adjustments.colorGrading.blending],
    ['crs:RedPrimaryHue', adjustments.calibration.redHue],
    ['crs:RedPrimarySaturation', adjustments.calibration.redSaturation],
    ['crs:GreenPrimaryHue', adjustments.calibration.greenHue],
    ['crs:GreenPrimarySaturation', adjustments.calibration.greenSaturation],
    ['crs:BluePrimaryHue', adjustments.calibration.blueHue],
    ['crs:BluePrimarySaturation', adjustments.calibration.blueSaturation],
  )

  const attributeText = attributes
    .map(([key, value]) => `      ${key}="${encodeXml(typeof value === 'number' ? xmpNumber(value) : value)}"`)
    .join('\n')
  const curves = CURVE_CHANNELS.map(([channel, key]) => {
    const points = adjustments.curves[channel].map((value, index) => {
      const x = Math.round(index / Math.max(1, adjustments.curves[channel].length - 1) * 255)
      const y = Math.round(clamp(value, 0, 1) * 255)
      return `          <rdf:li>${x}, ${y}</rdf:li>`
    }).join('\n')
    return `      <crs:${key}>\n        <rdf:Seq>\n${points}\n        </rdf:Seq>\n      </crs:${key}>`
  }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:ct="https://chroma-trace.local/xmp/1.0/"
${attributeText}>
${curves}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
`
}

export function validateXmpFile(file: Pick<File, 'name' | 'size'>) {
  if (!file.name.toLowerCase().endsWith('.xmp')) throw new Error('请选择 Lightroom 导出的 .xmp 预设文件。')
  if (file.size > XMP_MAX_BYTES) throw new Error('XMP 文件不能超过 2 MB。')
}

export function parseLightroomXmp(xml: string, fileName = 'Lightroom preset.xmp'): LightroomXmpPreset {
  if (!xml.trim()) throw new Error('XMP 文件内容为空。')
  if (!/<(?:[A-Za-z_][\w.-]*:)?(?:xmpmeta|RDF|Description)\b/i.test(xml) || !/\bcrs:/i.test(xml)) {
    throw new Error('未识别到 Lightroom / Camera Raw 预设数据。')
  }

  const attributes = collectAttributes(xml)
  const adjustments = createDefaultAdjustments()
  // Lightroom presets do not implicitly protect skin. The application default is
  // intended for AI recipes and would otherwise weaken selective color controls.
  adjustments.skinProtect = 0
  const mappedFields: string[] = []
  const warnings: string[] = []

  type NumericProperty = keyof Pick<
    Adjustments,
    | 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'
    | 'temperature' | 'tint' | 'vibrance' | 'saturation' | 'fade' | 'grain'
    | 'texture' | 'clarity' | 'dehaze' | 'sharpen' | 'sharpenRadius' | 'sharpenDetail'
    | 'sharpenMasking' | 'luminanceNoiseReduction' | 'colorNoiseReduction'
    | 'vignette' | 'vignetteMidpoint' | 'vignetteFeather'
  >

  const mapNumeric = (
    property: NumericProperty,
    label: string,
    minimum: number,
    maximum: number,
    ...keys: string[]
  ) => {
    const value = numericField(xml, attributes, ...keys)
    if (value === undefined) return false
    adjustments[property] = clamp(value, minimum, maximum)
    mappedFields.push(label)
    return true
  }

  mapNumeric('exposure', '曝光', -3, 3, 'Exposure2012', 'Exposure')
  mapNumeric('contrast', '对比度', -100, 100, 'Contrast2012', 'Contrast')
  mapNumeric('highlights', '高光', -100, 100, 'Highlights2012', 'Highlights')
  mapNumeric('shadows', '阴影', -100, 100, 'Shadows2012', 'Shadows')
  mapNumeric('whites', '白色', -100, 100, 'Whites2012', 'Whites')
  mapNumeric('blacks', '黑色', -100, 100, 'Blacks2012', 'Blacks')

  const incrementalTemperature = numericField(xml, attributes, 'IncrementalTemperature')
  if (incrementalTemperature !== undefined) {
    adjustments.temperature = clamp(incrementalTemperature, -100, 100)
    mappedFields.push('色温')
  } else {
    const absoluteTemperature = numericField(xml, attributes, 'Temperature')
    if (absoluteTemperature !== undefined && absoluteTemperature > 0) {
      adjustments.temperature = clamp(Math.log2(absoluteTemperature / 5500) * 75, -100, 100)
      mappedFields.push('色温')
      warnings.push('固定白平衡色温已按 5500K 中性点近似换算。')
    }
  }
  mapNumeric('tint', '色调', -100, 100, 'IncrementalTint', 'Tint')
  mapNumeric('vibrance', '自然饱和度', -100, 100, 'Vibrance')
  mapNumeric('saturation', '饱和度', -100, 100, 'Saturation')
  mapNumeric('fade', '褪色', 0, 100, 'Fade')
  const convertToGrayscale = fieldValue(xml, attributes, 'ConvertToGrayscale')
  if (convertToGrayscale && /^(true|1)$/i.test(convertToGrayscale)) {
    adjustments.vibrance = 0
    adjustments.saturation = -100
    mappedFields.push('黑白')
  }
  mapNumeric('grain', '颗粒', 0, 100, 'GrainAmount')
  mapNumeric('texture', '纹理', -100, 100, 'Texture')
  mapNumeric('clarity', '清晰度', -100, 100, 'Clarity2012', 'Clarity')
  mapNumeric('dehaze', '去朦胧', -100, 100, 'Dehaze')
  mapNumeric('sharpen', '锐化', 0, 150, 'SharpenAmount')
  mapNumeric('sharpenRadius', '锐化半径', 0.5, 3, 'SharpenRadius')
  mapNumeric('sharpenDetail', '锐化细节', 0, 100, 'SharpenDetail')
  mapNumeric('sharpenMasking', '锐化蒙版', 0, 100, 'SharpenEdgeMasking')
  mapNumeric('luminanceNoiseReduction', '明亮度降噪', 0, 100, 'LuminanceSmoothing')
  mapNumeric('colorNoiseReduction', '颜色降噪', 0, 100, 'ColorNoiseReduction')

  const postCropVignette = numericField(xml, attributes, 'PostCropVignetteAmount')
  const lensVignette = numericField(xml, attributes, 'VignetteAmount')
  if (postCropVignette !== undefined) {
    adjustments.vignette = clamp(postCropVignette, -100, 100)
    mappedFields.push('暗角')
  } else if (lensVignette !== undefined) {
    adjustments.vignette = clamp(lensVignette, -100, 100)
    mappedFields.push('暗角')
  }
  mapNumeric('vignetteMidpoint', '暗角中点', 0, 100, 'PostCropVignetteMidpoint', 'VignetteMidpoint')
  mapNumeric('vignetteFeather', '暗角羽化', 0, 100, 'PostCropVignetteFeather', 'VignetteFeather')

  for (const [channel, suffix, label] of HSL_CHANNELS) {
    const hue = numericField(xml, attributes, `HueAdjustment${suffix}`)
    const saturation = numericField(xml, attributes, `SaturationAdjustment${suffix}`)
    const luminance = numericField(xml, attributes, `LuminanceAdjustment${suffix}`)
    if (hue !== undefined) adjustments.hsl[channel].hue = clamp(hue, -100, 100)
    if (saturation !== undefined) adjustments.hsl[channel].saturation = clamp(saturation, -100, 100)
    if (luminance !== undefined) adjustments.hsl[channel].luminance = clamp(luminance, -100, 100)
    if (hue !== undefined || saturation !== undefined || luminance !== undefined) mappedFields.push(`${label} HSL`)
  }

  for (const [channel, key, label] of CURVE_CHANNELS) {
    const curve = parseCurve(xml, key)
    if (!curve) continue
    adjustments.curves[channel] = curve
    mappedFields.push(label)
  }

  const parametricCurve = [
    numericField(xml, attributes, 'ParametricShadows') ?? 0,
    numericField(xml, attributes, 'ParametricDarks') ?? 0,
    numericField(xml, attributes, 'ParametricLights') ?? 0,
    numericField(xml, attributes, 'ParametricHighlights') ?? 0,
  ]
  if (parametricCurve.some((value) => value !== 0)) {
    adjustments.curves.master = applyParametricCurve(adjustments.curves.master, parametricCurve)
    mappedFields.push('参数曲线')
  }

  const gradeZones = [
    ['shadows', 'Shadow', '阴影分级'],
    ['midtones', 'Midtone', '中间调分级'],
    ['highlights', 'Highlight', '高光分级'],
  ] as const
  let modernColorGrade = false
  for (const [zone, key, label] of gradeZones) {
    const hue = numericField(xml, attributes, `ColorGrade${key}Hue`)
    const saturation = numericField(xml, attributes, `ColorGrade${key}Sat`)
    const luminance = numericField(xml, attributes, `ColorGrade${key}Lum`)
    if (hue !== undefined) adjustments.colorGrading[zone].hue = clamp(hue, 0, 360)
    if (saturation !== undefined) adjustments.colorGrading[zone].saturation = clamp(saturation, 0, 100)
    if (luminance !== undefined) adjustments.colorGrading[zone].luminance = clamp(luminance, -100, 100)
    if (hue !== undefined || saturation !== undefined || luminance !== undefined) {
      modernColorGrade = true
      mappedFields.push(label)
    }
  }

  if (!modernColorGrade) {
    const shadowHue = numericField(xml, attributes, 'SplitToningShadowHue')
    const shadowSaturation = numericField(xml, attributes, 'SplitToningShadowSaturation')
    const highlightHue = numericField(xml, attributes, 'SplitToningHighlightHue')
    const highlightSaturation = numericField(xml, attributes, 'SplitToningHighlightSaturation')
    if (shadowHue !== undefined) adjustments.colorGrading.shadows.hue = clamp(shadowHue, 0, 360)
    if (shadowSaturation !== undefined) adjustments.colorGrading.shadows.saturation = clamp(shadowSaturation, 0, 100)
    if (highlightHue !== undefined) adjustments.colorGrading.highlights.hue = clamp(highlightHue, 0, 360)
    if (highlightSaturation !== undefined) adjustments.colorGrading.highlights.saturation = clamp(highlightSaturation, 0, 100)
    if ([shadowHue, shadowSaturation, highlightHue, highlightSaturation].some((value) => value !== undefined)) mappedFields.push('分离色调')
  }

  const balance = numericField(xml, attributes, 'ColorGradeBalance', 'SplitToningBalance')
  if (balance !== undefined) {
    adjustments.colorGrading.balance = clamp(balance, -100, 100)
    mappedFields.push('色彩分级平衡')
  }
  const blending = numericField(xml, attributes, 'ColorGradeBlending')
  if (blending !== undefined) {
    adjustments.colorGrading.blending = clamp(blending, 0, 100)
    mappedFields.push('色彩分级混合')
  }

  const calibrationFields: Array<[keyof Adjustments['calibration'], string, string]> = [
    ['redHue', 'RedPrimaryHue', '红原色色相'],
    ['redSaturation', 'RedPrimarySaturation', '红原色饱和度'],
    ['greenHue', 'GreenPrimaryHue', '绿原色色相'],
    ['greenSaturation', 'GreenPrimarySaturation', '绿原色饱和度'],
    ['blueHue', 'BluePrimaryHue', '蓝原色色相'],
    ['blueSaturation', 'BluePrimarySaturation', '蓝原色饱和度'],
  ]
  for (const [property, key, label] of calibrationFields) {
    const value = numericField(xml, attributes, key)
    if (value === undefined) continue
    adjustments.calibration[property] = clamp(value, -100, 100)
    mappedFields.push(label)
  }

  const crsFields = collectCrsFields(xml)
  const unsupportedFields = unique(Object.entries(IMPACTFUL_UNSUPPORTED_FIELDS)
    .filter(([key]) => crsFields.has(key))
    .map(([, label]) => label))

  if (!mappedFields.length) {
    const detail = unsupportedFields.length ? `；当前仅检测到暂不支持的参数：${unsupportedFields.join('、')}` : ''
    throw new Error(`这个 XMP 中没有可映射的调色参数${detail}。`)
  }

  if (unsupportedFields.length) warnings.push(`有 ${unsupportedFields.length} 类参数暂未应用。`)

  const rawName = fieldValue(xml, attributes, 'Name')
  const fallbackName = fileName.replace(/\.xmp$/i, '') || 'Lightroom 预设'
  const profile = fieldValue(xml, attributes, 'CameraProfile', 'Profile')

  return {
    name: rawName || fallbackName,
    fileName,
    processVersion: fieldValue(xml, attributes, 'ProcessVersion'),
    profile,
    adjustments,
    mappedFields: unique(mappedFields),
    unsupportedFields,
    warnings: unique(warnings),
  }
}
