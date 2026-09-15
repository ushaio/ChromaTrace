import { applyCubeLutRgb, type CubeLut3D } from './cubeLut'
import type {
  Adjustments, ColorStats, CrossImageTransfer, HslChannel, MatchControls, MatchProfile, RGB, ToneZoneStats,
} from './types'

type OKLab = [number, number, number]
type ColorSample = {
  lightness: number
  a: number
  b: number
  chroma: number
  castWeight: number
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const TONE_BINS = 256
const ZONE_CENTERS = [1 / 6, 0.5, 5 / 6] as const
const TONE_PERCENTILES = [0.01, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95, 0.99] as const

export function srgbToLinear(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function linearToSrgb(value: number) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
}

function encodedLuma(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function rgbToOklab(rgb: RGB): OKLab {
  const r = srgbToLinear(rgb[0])
  const g = srgbToLinear(rgb[1])
  const b = srgbToLinear(rgb[2])

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

export function oklabToRgb(lab: OKLab): RGB {
  const lRoot = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]
  const mRoot = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]
  const sRoot = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2]
  const l = lRoot ** 3
  const m = mRoot ** 3
  const s = sRoot ** 3

  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function castWeight(chroma: number) {
  return 1 / (1 + (chroma / 0.085) ** 2)
}

export function analyzeImageData(imageData: ImageData, maxSamples = 60000): ColorStats {
  const { data, width, height } = imageData
  const total = width * height
  const stride = Math.max(1, Math.floor(total / maxSamples))
  const sum: RGB = [0, 0, 0]
  const sumSq: RGB = [0, 0, 0]
  const histogram = Array.from({ length: 24 }, () => 0)
  const toneHistogram = Array.from({ length: TONE_BINS }, () => 0)
  const samples: ColorSample[] = []
  let labLightness = 0
  let weightedA = 0
  let weightedB = 0
  let totalCastWeight = 0
  let saturation = 0
  let labChroma = 0
  let count = 0

  for (let pixel = 0; pixel < total; pixel += stride) {
    const index = pixel * 4
    const alpha = data[index + 3] / 255
    if (alpha < 0.2) continue
    const r = data[index] / 255
    const g = data[index + 1] / 255
    const b = data[index + 2] / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const lab = rgbToOklab([r, g, b])
    const chroma = Math.hypot(lab[1], lab[2])
    const weight = castWeight(chroma)

    sum[0] += r; sum[1] += g; sum[2] += b
    sumSq[0] += r * r; sumSq[1] += g * g; sumSq[2] += b * b
    labLightness += lab[0]
    weightedA += lab[1] * weight
    weightedB += lab[2] * weight
    totalCastWeight += weight
    labChroma += chroma
    saturation += max === 0 ? 0 : (max - min) / max
    samples.push({ lightness: lab[0], a: lab[1], b: lab[2], chroma, castWeight: weight })

    const displayLuma = encodedLuma(r, g, b)
    histogram[Math.min(23, Math.floor(clamp(displayLuma) * 24))] += 1
    toneHistogram[Math.min(TONE_BINS - 1, Math.floor(clamp(lab[0]) * TONE_BINS))] += 1
    count += 1
  }

  const safeCount = Math.max(1, count)
  const mean = sum.map((value) => value / safeCount) as RGB
  const std = sumSq.map((value, channel) => Math.sqrt(Math.max(0.0001, value / safeCount - mean[channel] ** 2))) as RGB
  const normalizedHistogram = histogram.map((value) => value / safeCount)
  const normalizedToneHistogram = toneHistogram.map((value) => value / safeCount)
  const zoneSums = Array.from({ length: 3 }, () => ({
    weightedA: 0, weightedB: 0, castWeight: 0, chroma: 0, count: 0,
  }))

  samples.sort((left, right) => left.lightness - right.lightness)
  samples.forEach((sample, rank) => {
    const zoneIndex = Math.min(2, Math.floor(rank * 3 / Math.max(1, samples.length)))
    const zone = zoneSums[zoneIndex]
    zone.weightedA += sample.a * sample.castWeight
    zone.weightedB += sample.b * sample.castWeight
    zone.castWeight += sample.castWeight
    zone.chroma += sample.chroma
    zone.count += 1
  })

  const toneZones = zoneSums.map((zone): ToneZoneStats => ({
    meanA: zone.weightedA / Math.max(0.0001, zone.castWeight),
    meanB: zone.weightedB / Math.max(0.0001, zone.castWeight),
    chroma: zone.chroma / Math.max(1, zone.count),
    sampledPixels: zone.count,
  })) as [ToneZoneStats, ToneZoneStats, ToneZoneStats]

  return {
    mean,
    std,
    luma: encodedLuma(...mean),
    saturation: saturation / safeCount,
    warmBias: mean[0] - mean[2],
    tintBias: (mean[0] + mean[2]) / 2 - mean[1],
    labMean: [
      labLightness / safeCount,
      weightedA / Math.max(0.0001, totalCastWeight),
      weightedB / Math.max(0.0001, totalCastWeight),
    ],
    labChroma: labChroma / safeCount,
    histogram: normalizedHistogram,
    toneHistogram: normalizedToneHistogram,
    toneZones,
    sampledPixels: count,
  }
}

export function suggestAdjustments(profile: MatchProfile): Partial<Adjustments> {
  const { source, reference } = profile
  const lumaRatio = reference.luma / Math.max(0.03, source.luma)
  const contrastRatio = average(reference.std) / Math.max(0.02, average(source.std))
  return {
    exposure: clamp(Math.log2(lumaRatio), -2, 2),
    contrast: clamp((contrastRatio - 1) * 70, -45, 45),
    temperature: clamp((reference.warmBias - source.warmBias) * 150, -55, 55),
    tint: clamp((reference.tintBias - source.tintBias) * 180, -45, 45),
    saturation: clamp((reference.saturation - source.saturation) * 110, -35, 35),
    vibrance: clamp((reference.saturation - source.saturation) * 65, -25, 25),
  }
}

const average = (values: number[]) => values.reduce((sum, item) => sum + item, 0) / values.length

function quantile(histogram: number[], target: number) {
  const total = histogram.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return clamp(target)
  const targetMass = clamp(target) * total
  let cumulative = 0

  for (let index = 0; index < histogram.length; index += 1) {
    const binMass = histogram[index]
    if (binMass <= 0) continue
    if (cumulative + binMass >= targetMass) {
      const fraction = clamp((targetMass - cumulative) / binMass)
      return clamp((index + fraction) / histogram.length)
    }
    cumulative += binMass
  }
  return 1
}

function addToneAnchor(anchors: Array<{ x: number; y: number }>, x: number, y: number) {
  const previous = anchors.at(-1)
  if (previous && Math.abs(previous.x - x) < 1 / TONE_BINS) {
    previous.y = (previous.y + y) / 2
    return
  }
  anchors.push({ x, y })
}

function buildToneCurve(source: ColorStats, reference: ColorStats) {
  const sourceMedian = quantile(source.toneHistogram, 0.5)
  const referenceMedian = quantile(reference.toneHistogram, 0.5)
  const medianShift = clamp(referenceMedian - sourceMedian, -0.12, 0.12) * 0.3
  const anchors: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }]

  for (const percentile of TONE_PERCENTILES) {
    const sourceTone = quantile(source.toneHistogram, percentile)
    const referenceTone = quantile(reference.toneHistogram, percentile)
    const alignedReference = sourceMedian + medianShift + referenceTone - referenceMedian
    const targetTone = sourceTone + (alignedReference - sourceTone) * 0.62
    addToneAnchor(anchors, sourceTone, clamp(targetTone))
  }
  addToneAnchor(anchors, 1, 1)

  for (let index = 1; index < anchors.length; index += 1) {
    anchors[index].y = Math.max(anchors[index - 1].y, anchors[index].y)
  }

  const curve = new Float32Array(TONE_BINS)
  let segment = 0
  for (let index = 0; index < TONE_BINS; index += 1) {
    const input = index / (TONE_BINS - 1)
    while (segment < anchors.length - 2 && input > anchors[segment + 1].x) segment += 1
    const left = anchors[segment]
    const right = anchors[Math.min(anchors.length - 1, segment + 1)]
    const fraction = clamp((input - left.x) / Math.max(0.0001, right.x - left.x))
    curve[index] = clamp(left.y + (right.y - left.y) * fraction)
  }
  return curve
}

function buildTargetZones(source: ColorStats, reference: ColorStats) {
  const globalA = clamp(reference.labMean[1] - source.labMean[1], -0.035, 0.035) * 0.3
  const globalB = clamp(reference.labMean[2] - source.labMean[2], -0.035, 0.035) * 0.3

  return source.toneZones.map((sourceZone, index): ToneZoneStats => {
    const referenceZone = reference.toneZones[index]
    if (sourceZone.sampledPixels === 0 || referenceZone.sampledPixels === 0) return { ...sourceZone }

    const sourceRelativeA = sourceZone.meanA - source.labMean[1]
    const sourceRelativeB = sourceZone.meanB - source.labMean[2]
    const referenceRelativeA = referenceZone.meanA - reference.labMean[1]
    const referenceRelativeB = referenceZone.meanB - reference.labMean[2]
    const relativeA = clamp(referenceRelativeA - sourceRelativeA, -0.055, 0.055) * 0.55
    const relativeB = clamp(referenceRelativeB - sourceRelativeB, -0.055, 0.055) * 0.55
    const chromaRatio = clamp(referenceZone.chroma / Math.max(0.012, sourceZone.chroma), 0.72, 1.38)

    return {
      meanA: sourceZone.meanA + globalA + relativeA,
      meanB: sourceZone.meanB + globalB + relativeB,
      chroma: sourceZone.chroma * (1 + (chromaRatio - 1) * 0.42),
      sampledPixels: sourceZone.sampledPixels,
    }
  }) as [ToneZoneStats, ToneZoneStats, ToneZoneStats]
}

function createCrossImageTransfer(source: ColorStats, reference: ColorStats): CrossImageTransfer {
  return {
    toneCurve: buildToneCurve(source, reference),
    zones: buildTargetZones(source, reference),
    sourceZones: source.toneZones,
  }
}

export function createMatchProfile(source: ColorStats, reference: ColorStats): MatchProfile {
  return { source, reference, transfer: createCrossImageTransfer(source, reference) }
}


const MODEL_CONTEXT_PERCENTILES = [0.05, 0.25, 0.5, 0.75, 0.95] as const

function rounded(value: number, digits = 4) {
  return Number(value.toFixed(digits))
}

function tonePercentiles(stats: ColorStats) {
  return Object.fromEntries(MODEL_CONTEXT_PERCENTILES.map((percentile) => [
    `p${String(Math.round(percentile * 100)).padStart(2, '0')}`,
    rounded(quantile(stats.toneHistogram, percentile)),
  ]))
}

export function suggestMatchControls(profile: MatchProfile): MatchControls {
  const sourceTones = MODEL_CONTEXT_PERCENTILES.map((percentile) => quantile(profile.source.toneHistogram, percentile))
  const referenceTones = MODEL_CONTEXT_PERCENTILES.map((percentile) => quantile(profile.reference.toneHistogram, percentile))
  const toneDistance = average(sourceTones.map((value, index) => Math.abs(value - referenceTones[index])))
  const sourceRange = sourceTones[4] - sourceTones[0]
  const referenceRange = referenceTones[4] - referenceTones[0]
  const rangeDistance = Math.abs(sourceRange - referenceRange)
  const neutralCastDistance = Math.hypot(
    profile.reference.labMean[1] - profile.source.labMean[1],
    profile.reference.labMean[2] - profile.source.labMean[2],
  )
  const chromaDistance = Math.abs(Math.log(
    Math.max(0.005, profile.reference.labChroma) / Math.max(0.005, profile.source.labChroma),
  ))
  const divergence = clamp(
    toneDistance / 0.22 * 0.45
      + rangeDistance / 0.18 * 0.2
      + neutralCastDistance / 0.08 * 0.2
      + chromaDistance / 0.7 * 0.15,
  )

  return {
    toneMatchStrength: Math.round(94 - divergence * 16),
    colorMatchStrength: Math.round(92 - divergence * 16),
    preserveLuma: Math.round(34 + divergence * 28),
    skinProtect: Math.round(66 + divergence * 6),
  }
}

function compactStats(stats: ColorStats) {
  return {
    luma: rounded(stats.luma),
    saturation: rounded(stats.saturation),
    warmBias: rounded(stats.warmBias),
    tintBias: rounded(stats.tintBias),
    labMean: stats.labMean.map((value) => rounded(value)),
    labChroma: rounded(stats.labChroma),
    tonePercentiles: tonePercentiles(stats),
    toneZones: stats.toneZones.map((zone) => ({
      meanA: rounded(zone.meanA),
      meanB: rounded(zone.meanB),
      chroma: rounded(zone.chroma),
      sampleShare: rounded(zone.sampledPixels / Math.max(1, stats.sampledPixels)),
    })),
  }
}

export function createModelMatchContext(profile: MatchProfile, controls = suggestMatchControls(profile)) {
  const source = compactStats(profile.source)
  const reference = compactStats(profile.reference)
  return JSON.stringify({
    measurementVersion: 1,
    units: 'normalized sRGB and OKLab; tone percentiles are OKLab L',
    source,
    reference,
    differences: {
      luma: rounded(profile.reference.luma - profile.source.luma),
      saturation: rounded(profile.reference.saturation - profile.source.saturation),
      warmBias: rounded(profile.reference.warmBias - profile.source.warmBias),
      tintBias: rounded(profile.reference.tintBias - profile.source.tintBias),
      labMean: profile.reference.labMean.map((value, index) => rounded(value - profile.source.labMean[index])),
      labChroma: rounded(profile.reference.labChroma - profile.source.labChroma),
    },
    localTransferControls: controls,
  })
}

function sampleToneCurve(lightness: number, curve: Float32Array) {
  const position = clamp(lightness) * (curve.length - 1)
  const lower = Math.floor(position)
  const upper = Math.min(curve.length - 1, lower + 1)
  const fraction = position - lower
  return curve[lower] + (curve[upper] - curve[lower]) * fraction
}

function percentileAtTone(lightness: number, histogram: number[]) {
  const position = clamp(lightness) * histogram.length
  const index = Math.min(histogram.length - 1, Math.floor(position))
  let percentile = 0
  for (let cursor = 0; cursor < index; cursor += 1) percentile += histogram[cursor]
  percentile += histogram[index] * (position - index)
  return clamp(percentile)
}

function zoneWeights(percentile: number): [number, number, number] {
  const weights = ZONE_CENTERS.map((center) => Math.max(0, 1 - Math.abs(percentile - center) / 0.5))
  const sum = Math.max(0.0001, weights[0] + weights[1] + weights[2])
  return [weights[0] / sum, weights[1] / sum, weights[2] / sum]
}

function skinMask(r: number, g: number, b: number) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const chroma = max - min
  if (chroma < 0.04) return 0
  let hue = 0
  if (max === r) hue = ((g - b) / chroma) % 6
  else if (max === g) hue = (b - r) / chroma + 2
  else hue = (r - g) / chroma + 4
  hue = ((hue * 60) + 360) % 360
  const sat = chroma / Math.max(0.001, max)
  const hueMask = hue <= 55 ? 1 - Math.abs(hue - 27) / 28 : 0
  return clamp(hueMask) * clamp((sat - 0.08) / 0.35) * clamp((max - 0.15) / 0.5)
}

function applyCrossImageTransfer(rgb: RGB, profile: MatchProfile, adjustments: Adjustments): RGB {
  const lab = rgbToOklab(rgb)
  const percentile = percentileAtTone(lab[0], profile.source.toneHistogram)
  const weights = zoneWeights(percentile)
  let targetA = 0
  let targetB = 0

  for (let zone = 0; zone < 3; zone += 1) {
    const sourceZone = profile.transfer.sourceZones[zone]
    const targetZone = profile.transfer.zones[zone]
    const chromaScale = clamp(targetZone.chroma / Math.max(0.012, sourceZone.chroma), 0.72, 1.38)
    targetA += ((lab[1] - sourceZone.meanA) * chromaScale + targetZone.meanA) * weights[zone]
    targetB += ((lab[2] - sourceZone.meanB) * chromaScale + targetZone.meanB) * weights[zone]
  }

  const mappedLightness = sampleToneCurve(lab[0], profile.transfer.toneCurve)
  const preserve = adjustments.preserveLuma / 100
  const targetLightness = mappedLightness + (lab[0] - mappedLightness) * preserve
  const toneStrength = adjustments.toneMatchStrength / 100
  const colorStrength = adjustments.colorMatchStrength / 100
  const protect = skinMask(...rgb) * adjustments.skinProtect / 100
  const finalLab: OKLab = [
    lab[0] + (targetLightness - lab[0]) * toneStrength * (1 - protect * 0.25),
    lab[1] + (targetA - lab[1]) * colorStrength * (1 - protect * 0.78),
    lab[2] + (targetB - lab[2]) * colorStrength * (1 - protect * 0.78),
  ]

  return oklabToRgb(finalLab).map((value) => clamp(value)) as RGB
}

const HSL_BANDS: Array<{ channel: HslChannel; center: number; width: number }> = [
  { channel: 'red', center: 0, width: 42 },
  { channel: 'orange', center: 30, width: 36 },
  { channel: 'yellow', center: 60, width: 44 },
  { channel: 'green', center: 120, width: 64 },
  { channel: 'aqua', center: 180, width: 54 },
  { channel: 'blue', center: 240, width: 58 },
  { channel: 'purple', center: 285, width: 44 },
  { channel: 'magenta', center: 330, width: 44 },
]

function angularDistance(left: number, right: number) {
  return Math.abs(((left - right + 180) % 360 + 360) % 360 - 180)
}

function hueBandWeight(hue: number, center: number, width: number) {
  const distance = angularDistance(hue, center)
  if (distance >= width) return 0
  return (Math.cos(Math.PI * distance / width) + 1) / 2
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2
  if (delta < 0.000001) return [0, 0, lightness]

  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  let hue = 0
  if (max === r) hue = 60 * (((g - b) / delta) % 6)
  else if (max === g) hue = 60 * ((b - r) / delta + 2)
  else hue = 60 * ((r - g) / delta + 4)
  return [((hue % 360) + 360) % 360, clamp(saturation), clamp(lightness)]
}

function hslToRgb([hue, saturation, lightness]: [number, number, number]): RGB {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const section = ((hue % 360) + 360) % 360 / 60
  const x = chroma * (1 - Math.abs(section % 2 - 1))
  let rgb: RGB
  if (section < 1) rgb = [chroma, x, 0]
  else if (section < 2) rgb = [x, chroma, 0]
  else if (section < 3) rgb = [0, chroma, x]
  else if (section < 4) rgb = [0, x, chroma]
  else if (section < 5) rgb = [x, 0, chroma]
  else rgb = [chroma, 0, x]
  const offset = lightness - chroma / 2
  return rgb.map((value) => clamp(value + offset)) as RGB
}

function blendRgb(source: RGB, target: RGB, amount: number): RGB {
  return source.map((value, channel) => clamp(value + (target[channel] - value) * amount)) as RGB
}

function protectedAmount(rgb: RGB, adjustments: Adjustments, maximumProtection = 0.82) {
  return 1 - skinMask(...rgb) * adjustments.skinProtect / 100 * maximumProtection
}

function applyCalibration(rgb: RGB, adjustments: Adjustments): RGB {
  const [hue, saturation, lightness] = rgbToHsl(rgb)
  const primaries = [
    { center: 0, hue: adjustments.calibration.redHue, saturation: adjustments.calibration.redSaturation },
    { center: 120, hue: adjustments.calibration.greenHue, saturation: adjustments.calibration.greenSaturation },
    { center: 240, hue: adjustments.calibration.blueHue, saturation: adjustments.calibration.blueSaturation },
  ]
  let hueShift = 0
  let saturationShift = 0
  let totalWeight = 0
  for (const primary of primaries) {
    const weight = hueBandWeight(hue, primary.center, 105)
    hueShift += primary.hue / 100 * 25 * weight
    saturationShift += primary.saturation / 100 * 0.48 * weight
    totalWeight += weight
  }
  const divisor = Math.max(1, totalWeight)
  const calibrated = hslToRgb([
    hue + hueShift / divisor,
    clamp(saturation * (1 + saturationShift / divisor)),
    lightness,
  ])
  return blendRgb(rgb, calibrated, protectedAmount(rgb, adjustments, 0.7))
}

function applyBasicAdjustments(rgb: RGB, adjustments: Adjustments): RGB {
  let [r, g, b] = rgb.map(srgbToLinear) as RGB
  const exposure = 2 ** adjustments.exposure
  r *= exposure; g *= exposure; b *= exposure

  const temp = adjustments.temperature / 100
  const tint = adjustments.tint / 100
  r *= Math.max(0.2, 1 + temp * 0.18 + tint * 0.035)
  g *= Math.max(0.2, 1 - tint * 0.11)
  b *= Math.max(0.2, 1 - temp * 0.18 + tint * 0.035)

  r = linearToSrgb(r); g = linearToSrgb(g); b = linearToSrgb(b)

  const contrast = 1 + adjustments.contrast / 100
  r = (r - 0.5) * contrast + 0.5
  g = (g - 0.5) * contrast + 0.5
  b = (b - 0.5) * contrast + 0.5

  const luma = encodedLuma(r, g, b)
  const shadowMask = (1 - clamp(luma)) ** 2
  const highlightMask = clamp(luma) ** 2
  const shadowLift = adjustments.shadows / 100 * 0.32 * shadowMask
  const highlightLift = adjustments.highlights / 100 * 0.28 * highlightMask
  const blackLift = adjustments.blacks / 100 * 0.16 * (1 - clamp(luma))
  const whiteLift = adjustments.whites / 100 * 0.16 * clamp(luma)
  r += shadowLift + highlightLift + blackLift + whiteLift
  g += shadowLift + highlightLift + blackLift + whiteLift
  b += shadowLift + highlightLift + blackLift + whiteLift

  const adjustedLuma = encodedLuma(r, g, b)
  const currentSat = Math.max(r, g, b) - Math.min(r, g, b)
  const satFactor = 1 + adjustments.saturation / 100 + (adjustments.vibrance / 100) * (1 - clamp(currentSat * 1.8))
  r = adjustedLuma + (r - adjustedLuma) * satFactor
  g = adjustedLuma + (g - adjustedLuma) * satFactor
  b = adjustedLuma + (b - adjustedLuma) * satFactor

  const fade = adjustments.fade / 100
  r = r * (1 - fade * 0.22) + fade * 0.12
  g = g * (1 - fade * 0.22) + fade * 0.12
  b = b * (1 - fade * 0.22) + fade * 0.12
  return [clamp(r), clamp(g), clamp(b)]
}

function normalizedCurve(points: number[]) {
  if (points.length < 2 || points.some((value) => !Number.isFinite(value))) return [0, 0.25, 0.5, 0.75, 1]
  const normalized = points.map((value) => clamp(value))
  for (let index = 1; index < normalized.length; index += 1) {
    normalized[index] = Math.max(normalized[index], normalized[index - 1])
  }
  return normalized
}

export function sampleAdjustmentCurve(value: number, points: number[]) {
  const curve = normalizedCurve(points)
  const position = clamp(value) * (curve.length - 1)
  const lower = Math.floor(position)
  const upper = Math.min(curve.length - 1, lower + 1)
  const fraction = position - lower
  return clamp(curve[lower] + (curve[upper] - curve[lower]) * fraction)
}

function applyCurves(rgb: RGB, adjustments: Adjustments): RGB {
  // Camera Raw point curves use encoded 0..255 RGB values. Treating the
  // composite curve as OKLab L crushes lifted blacks and weakens S-curves.
  const master = rgb.map((value) => sampleAdjustmentCurve(value, adjustments.curves.master)) as RGB
  return [
    sampleAdjustmentCurve(master[0], adjustments.curves.red),
    sampleAdjustmentCurve(master[1], adjustments.curves.green),
    sampleAdjustmentCurve(master[2], adjustments.curves.blue),
  ]
}

function applyHslAdjustments(rgb: RGB, adjustments: Adjustments): RGB {
  const [hue, saturation, lightness] = rgbToHsl(rgb)
  if (saturation < 0.0001) return rgb
  let hueShift = 0
  let saturationShift = 0
  let luminanceShift = 0
  let totalWeight = 0

  for (const band of HSL_BANDS) {
    const weight = hueBandWeight(hue, band.center, band.width)
    const adjustment = adjustments.hsl[band.channel]
    hueShift += adjustment.hue / 100 * 30 * weight
    saturationShift += adjustment.saturation / 100 * 0.65 * weight
    luminanceShift += adjustment.luminance / 100 * 0.2 * weight
    totalWeight += weight
  }

  const divisor = Math.max(1, totalWeight)
  const target = hslToRgb([
    hue + hueShift / divisor,
    clamp(saturation * (1 + saturationShift / divisor)),
    clamp(lightness + luminanceShift / divisor),
  ])
  return blendRgb(rgb, target, protectedAmount(rgb, adjustments))
}

function applyColorGrading(rgb: RGB, adjustments: Adjustments): RGB {
  const lab = rgbToOklab(rgb)
  const balance = adjustments.colorGrading.balance / 100 * 0.14
  const width = 0.16 + adjustments.colorGrading.blending / 100 * 0.24
  const centers = [0.22 + balance, 0.5 + balance * 0.35, 0.78 + balance] as const
  const zoneNames = ['shadows', 'midtones', 'highlights'] as const
  const weights = centers.map((center) => Math.exp(-0.5 * ((lab[0] - center) / width) ** 2))
  const totalWeight = Math.max(0.0001, weights.reduce((sum, value) => sum + value, 0))
  let lightnessShift = 0
  let aShift = 0
  let bShift = 0

  zoneNames.forEach((zoneName, index) => {
    const zone = adjustments.colorGrading[zoneName]
    const weight = weights[index] / totalWeight
    const radians = zone.hue * Math.PI / 180
    const chroma = zone.saturation / 100 * 0.075
    aShift += Math.cos(radians) * chroma * weight
    bShift += Math.sin(radians) * chroma * weight
    lightnessShift += zone.luminance / 100 * 0.1 * weight
  })

  const target = oklabToRgb([
    clamp(lab[0] + lightnessShift),
    lab[1] + aShift,
    lab[2] + bShift,
  ])
  return blendRgb(rgb, target, protectedAmount(rgb, adjustments))
}

function applyDehaze(rgb: RGB, amount: number): RGB {
  if (!amount) return rgb
  const strength = amount / 100
  const luma = encodedLuma(rgb[0], rgb[1], rgb[2])
  // Positive dehaze deepens blacks and lifts micro-contrast; negative adds haze.
  const pivot = 0.42
  const contrast = 1 + strength * 0.48
  let r = (rgb[0] - pivot) * contrast + pivot - strength * 0.045
  let g = (rgb[1] - pivot) * contrast + pivot - strength * 0.045
  let b = (rgb[2] - pivot) * contrast + pivot - strength * 0.045
  const satBoost = 1 + strength * 0.28 * (1 - clamp(Math.abs(luma - 0.55) * 1.4))
  const mid = encodedLuma(r, g, b)
  r = mid + (r - mid) * satBoost
  g = mid + (g - mid) * satBoost
  b = mid + (b - mid) * satBoost
  return [clamp(r), clamp(g), clamp(b)]
}

export function transformRgb(rgb: RGB, adjustments: Adjustments, profile?: MatchProfile | null): RGB {
  const matched = profile ? applyCrossImageTransfer(rgb, profile, adjustments) : rgb
  const calibrated = applyCalibration(matched, adjustments)
  const basic = applyBasicAdjustments(calibrated, adjustments)
  const dehazed = applyDehaze(basic, adjustments.dehaze)
  const curved = applyCurves(dehazed, adjustments)
  const selective = applyHslAdjustments(curved, adjustments)
  return applyColorGrading(selective, adjustments)
}

function needsSpatialPass(adjustments: Adjustments) {
  return Boolean(
    adjustments.texture
    || adjustments.clarity
    || adjustments.sharpen
    || adjustments.luminanceNoiseReduction
    || adjustments.colorNoiseReduction
    || adjustments.vignette,
  )
}

function samplePixel(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): RGB {
  const sx = Math.max(0, Math.min(width - 1, x))
  const sy = Math.max(0, Math.min(height - 1, y))
  const index = (sy * width + sx) * 4
  return [data[index] / 255, data[index + 1] / 255, data[index + 2] / 255]
}

/** Separable 3-tap / 5-tap style blur for local structure controls. */
function blurSample(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): RGB {
  const steps = radius <= 1.25 ? 1 : 2
  const center = samplePixel(data, width, height, x, y)
  const centerLuma = encodedLuma(center[0], center[1], center[2])
  const rangeSigma = 0.07 + Math.min(radius, 3) * 0.025
  let r = 0
  let g = 0
  let b = 0
  let weight = 0
  for (let oy = -steps; oy <= steps; oy += 1) {
    for (let ox = -steps; ox <= steps; ox += 1) {
      const distance = Math.hypot(ox, oy)
      if (distance > steps + 0.01) continue
      const sample = samplePixel(data, width, height, x + ox, y + oy)
      const lumaDelta = encodedLuma(sample[0], sample[1], sample[2]) - centerLuma
      const rangeWeight = Math.exp(-0.5 * (lumaDelta / rangeSigma) ** 2)
      const w = rangeWeight / (1 + distance)
      r += sample[0] * w
      g += sample[1] * w
      b += sample[2] * w
      weight += w
    }
  }
  return [r / weight, g / weight, b / weight]
}

function applySpatialPixel(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  adjustments: Adjustments,
): RGB {
  const original = samplePixel(data, width, height, x, y)
  let rgb: RGB = [...original]

  const textureAmount = adjustments.texture / 100
  const clarityAmount = adjustments.clarity / 100
  if (textureAmount || clarityAmount) {
    const fine = blurSample(data, width, height, x, y, 1)
    const broad = blurSample(data, width, height, x, y, 2.4)
    const fineDetail: RGB = [original[0] - fine[0], original[1] - fine[1], original[2] - fine[2]]
    const broadDetail: RGB = [original[0] - broad[0], original[1] - broad[1], original[2] - broad[2]]
    const luma = encodedLuma(original[0], original[1], original[2])
    const midMask = 1 - clamp(Math.abs(luma - 0.5) * 2)
    const highlightProtect = 1 - clamp((luma - 0.86) / 0.14) * 0.75
    rgb = [
      clamp(rgb[0] + (fineDetail[0] * textureAmount * 0.85 + broadDetail[0] * clarityAmount * 0.55 * midMask) * highlightProtect),
      clamp(rgb[1] + (fineDetail[1] * textureAmount * 0.85 + broadDetail[1] * clarityAmount * 0.55 * midMask) * highlightProtect),
      clamp(rgb[2] + (fineDetail[2] * textureAmount * 0.85 + broadDetail[2] * clarityAmount * 0.55 * midMask) * highlightProtect),
    ]
  }

  if (adjustments.sharpen > 0) {
    const radius = clamp(adjustments.sharpenRadius, 0.5, 3)
    const blurred = blurSample(data, width, height, x, y, radius)
    const detail: RGB = [rgb[0] - blurred[0], rgb[1] - blurred[1], rgb[2] - blurred[2]]
    const edge = (Math.abs(detail[0]) + Math.abs(detail[1]) + Math.abs(detail[2])) / 3
    const masking = adjustments.sharpenMasking / 100
    const mask = masking <= 0.001
      ? 1
      : clamp((edge - masking * 0.04) / Math.max(0.02, masking * 0.12 + 0.02))
    const amount = adjustments.sharpen / 100 * (0.55 + adjustments.sharpenDetail / 100 * 0.75)
    rgb = [
      clamp(rgb[0] + detail[0] * amount * mask),
      clamp(rgb[1] + detail[1] * amount * mask),
      clamp(rgb[2] + detail[2] * amount * mask),
    ]
  }

  const lumaNr = adjustments.luminanceNoiseReduction / 100
  const colorNr = adjustments.colorNoiseReduction / 100
  if (lumaNr || colorNr) {
    const blurred = blurSample(data, width, height, x, y, 1 + Math.max(lumaNr, colorNr))
    const originalLuma = encodedLuma(rgb[0], rgb[1], rgb[2])
    const blurredLuma = encodedLuma(blurred[0], blurred[1], blurred[2])
    const mixedLuma = originalLuma * (1 - lumaNr * 0.85) + blurredLuma * (lumaNr * 0.85)
    const cr = rgb[0] - originalLuma
    const cg = rgb[1] - originalLuma
    const cb = rgb[2] - originalLuma
    const br = blurred[0] - blurredLuma
    const bg = blurred[1] - blurredLuma
    const bb = blurred[2] - blurredLuma
    const chromaMix = colorNr
    rgb = [
      clamp(mixedLuma + cr * (1 - chromaMix) + br * chromaMix),
      clamp(mixedLuma + cg * (1 - chromaMix) + bg * chromaMix),
      clamp(mixedLuma + cb * (1 - chromaMix) + bb * chromaMix),
    ]
  }

  if (adjustments.vignette) {
    const nx = width > 1 ? x / (width - 1) : 0.5
    const ny = height > 1 ? y / (height - 1) : 0.5
    const dx = (nx - 0.5) * 2
    const dy = (ny - 0.5) * 2
    const dist = Math.hypot(dx, dy)
    const inner = adjustments.vignetteMidpoint / 100 * 0.95
    const outer = inner + adjustments.vignetteFeather / 100 * 1.15 + 0.08
    const t = clamp((dist - inner) / Math.max(0.001, outer - inner))
    const smooth = t * t * (3 - 2 * t)
    // Lightroom: negative amount darkens corners.
    const factor = 1 + (adjustments.vignette / 100) * smooth * 0.85
    rgb = [clamp(rgb[0] * factor), clamp(rgb[1] * factor), clamp(rgb[2] * factor)]
  }

  return rgb
}

function createImageDataBuffer(width: number, height: number, data: Uint8ClampedArray): ImageData {
  if (typeof ImageData === 'function') {
    try {
      // Copy into a fresh ArrayBuffer-backed view for DOM ImageData constructors.
      const pixels = new Uint8ClampedArray(data)
      return new ImageData(pixels, width, height)
    } catch {
      // Node / incomplete polyfills fall through to a structural ImageData.
    }
  }
  return { width, height, data, colorSpace: 'srgb' } as ImageData
}

/** Yield so React can paint “正在导出” and the UI stays responsive during long CPU work. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    // Double rAF: wait until after the next paint.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    // Prefer idle callback when available; fall back to a short timer.
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
    if (typeof ric === 'function') {
      ric(() => resolve(), { timeout: 24 })
      return
    }
    setTimeout(resolve, 0)
  })
}

/**
 * Full pixel pipeline:
 * grade (transformRgb) → spatial detail → grain → optional 3D CUBE LUT (sRGB, L2).
 * LUT is applied last among color ops so Resolve-style creative cubes see graded RGB.
 */
export function processImageData(
  source: ImageData,
  adjustments: Adjustments,
  profile?: MatchProfile | null,
  cubeLut?: CubeLut3D | null,
): ImageData {
  // Sync path for previews / tests — export should prefer processImageDataAsync.
  return processImageDataSync(source, adjustments, profile, cubeLut)
}

/**
 * Same pipeline as processImageData, but yields between row batches so the main thread
 * can paint and handle input during multi-megapixel exports.
 */
export async function processImageDataAsync(
  source: ImageData,
  adjustments: Adjustments,
  profile?: MatchProfile | null,
  cubeLut?: CubeLut3D | null,
  options?: { rowsPerSlice?: number },
): Promise<ImageData> {
  const rowsPerSlice = Math.max(8, options?.rowsPerSlice ?? 24)
  return processImageDataAsyncInternal(source, adjustments, profile, cubeLut, rowsPerSlice)
}

function processImageDataSync(
  source: ImageData,
  adjustments: Adjustments,
  profile: MatchProfile | null | undefined,
  cubeLut: CubeLut3D | null | undefined,
): ImageData {
  const { width, height } = source
  const gradedData = new Uint8ClampedArray(source.data.length)
  const applyLut = Boolean(cubeLut && adjustments.lutAmount > 0)
  const runSpatial = needsSpatialPass(adjustments)
  const grainAmount = adjustments.grain / 100 * 13
  const needsSecondPass = runSpatial || grainAmount > 0 || applyLut
  const outputData = needsSecondPass ? new Uint8ClampedArray(gradedData.length) : gradedData

  for (let y = 0; y < height; y += 1) {
    gradeRow(source, gradedData, width, y, adjustments, profile)
  }
  if (needsSecondPass) {
    for (let y = 0; y < height; y += 1) {
      finishRow(gradedData, outputData, width, height, y, adjustments, cubeLut, applyLut, runSpatial, grainAmount)
    }
  }
  return createImageDataBuffer(width, height, outputData)
}

function gradeRow(
  source: ImageData,
  gradedData: Uint8ClampedArray,
  width: number,
  y: number,
  adjustments: Adjustments,
  profile: MatchProfile | null | undefined,
) {
  const rowStart = y * width * 4
  const rowEnd = rowStart + width * 4
  for (let i = rowStart; i < rowEnd; i += 4) {
    const rgb = transformRgb(
      [source.data[i] / 255, source.data[i + 1] / 255, source.data[i + 2] / 255],
      adjustments,
      profile,
    )
    gradedData[i] = Math.round(clamp(rgb[0]) * 255)
    gradedData[i + 1] = Math.round(clamp(rgb[1]) * 255)
    gradedData[i + 2] = Math.round(clamp(rgb[2]) * 255)
    gradedData[i + 3] = source.data[i + 3]
  }
}

function finishRow(
  gradedData: Uint8ClampedArray,
  outputData: Uint8ClampedArray,
  width: number,
  height: number,
  y: number,
  adjustments: Adjustments,
  cubeLut: CubeLut3D | null | undefined,
  applyLut: boolean,
  runSpatial: boolean,
  grainAmount: number,
) {
  for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4
    let rgb = runSpatial
      ? applySpatialPixel(gradedData, width, height, x, y, adjustments)
      : [gradedData[i] / 255, gradedData[i + 1] / 255, gradedData[i + 2] / 255] as RGB
    if (applyLut && cubeLut) {
      rgb = applyCubeLutRgb(rgb, cubeLut, adjustments.lutAmount)
    }
    const noise = grainAmount ? (pseudoRandom(i / 4) - 0.5) * grainAmount : 0
    outputData[i] = clamp(rgb[0] * 255 + noise, 0, 255)
    outputData[i + 1] = clamp(rgb[1] * 255 + noise, 0, 255)
    outputData[i + 2] = clamp(rgb[2] * 255 + noise, 0, 255)
    outputData[i + 3] = gradedData[i + 3]
  }
}

async function processImageDataAsyncInternal(
  source: ImageData,
  adjustments: Adjustments,
  profile: MatchProfile | null | undefined,
  cubeLut: CubeLut3D | null | undefined,
  rowsPerSlice: number,
): Promise<ImageData> {
  const { width, height } = source
  const gradedData = new Uint8ClampedArray(source.data.length)
  const applyLut = Boolean(cubeLut && adjustments.lutAmount > 0)
  const runSpatial = needsSpatialPass(adjustments)
  const grainAmount = adjustments.grain / 100 * 13
  const needsSecondPass = runSpatial || grainAmount > 0 || applyLut
  const outputData = needsSecondPass ? new Uint8ClampedArray(gradedData.length) : gradedData

  for (let y = 0; y < height; y += 1) {
    gradeRow(source, gradedData, width, y, adjustments, profile)
    if ((y + 1) % rowsPerSlice === 0) await yieldToEventLoop()
  }
  if (needsSecondPass) {
    await yieldToEventLoop()
    for (let y = 0; y < height; y += 1) {
      finishRow(gradedData, outputData, width, height, y, adjustments, cubeLut, applyLut, runSpatial, grainAmount)
      if ((y + 1) % rowsPerSlice === 0) await yieldToEventLoop()
    }
  }
  return createImageDataBuffer(width, height, outputData)
}

function pseudoRandom(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return value - Math.floor(value)
}
