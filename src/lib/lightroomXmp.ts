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
const CURVE_SAMPLE_X = [0, 0.25, 0.5, 0.75, 1]

const IMPACTFUL_UNSUPPORTED_FIELDS: Record<string, string> = {
  Texture: '纹理',
  Clarity: '清晰度',
  Clarity2012: '清晰度',
  Dehaze: '去朦胧',
  SharpenAmount: '锐化',
  SharpenRadius: '锐化半径',
  SharpenDetail: '锐化细节',
  SharpenEdgeMasking: '锐化蒙版',
  LuminanceSmoothing: '明亮度降噪',
  ColorNoiseReduction: '颜色降噪',
  LensProfileEnable: '镜头配置文件',
  LensManualDistortionAmount: '镜头畸变',
  PerspectiveVertical: '垂直透视',
  PerspectiveHorizontal: '水平透视',
  PerspectiveRotate: '透视旋转',
  UprightVersion: 'Upright 透视',
  VignetteAmount: '镜头暗角',
  PostCropVignetteAmount: '裁剪后暗角',
  PostCropVignetteMidpoint: '暗角中点',
  PostCropVignetteFeather: '暗角羽化',
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

function collectCrsFields(xml: string) {
  const fields = new Set<string>()
  const pattern = /\bcrs:([A-Za-z_][\w.-]*)\b/g
  for (const match of xml.matchAll(pattern)) fields.add(match[1])
  return fields
}

function unique(values: string[]) {
  return [...new Set(values)]
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
  const mappedFields: string[] = []
  const warnings: string[] = []

  const mapNumeric = (
    property: keyof Pick<Adjustments, 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks' | 'temperature' | 'tint' | 'vibrance' | 'saturation' | 'fade' | 'grain'>,
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
  mapNumeric('grain', '颗粒', 0, 100, 'GrainAmount')

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
