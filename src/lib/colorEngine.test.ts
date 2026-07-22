import { describe, expect, it } from 'vitest'
import {
  analyzeImageData, createMatchProfile, createModelMatchContext, oklabToRgb, processImageData, rgbToOklab,
  sampleAdjustmentCurve, suggestAdjustments, suggestMatchControls, transformRgb,
} from './colorEngine'
import { createDefaultAdjustments } from './defaults'
import type { Adjustments, RGB } from './types'

type Pixel = [number, number, number, number?]

const neutralAdjustments: Adjustments = {
  ...createDefaultAdjustments(),
  toneMatchStrength: 100,
  colorMatchStrength: 100,
  preserveLuma: 0,
  skinProtect: 0,
}

function imageData(width: number, height: number, pixels: Pixel[]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const [r, g, b, a = 255] = pixels[index % pixels.length]
    const offset = index * 4
    data[offset] = r
    data[offset + 1] = g
    data[offset + 2] = b
    data[offset + 3] = a
  }
  return { width, height, data, colorSpace: 'srgb' } as ImageData
}

function luma([r, g, b]: RGB) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('analyzeImageData', () => {
  it.each([
    ['black', [0, 0, 0, 255] as Pixel],
    ['white', [255, 255, 255, 255] as Pixel],
  ])('returns finite statistics for a %s image', (_name, pixel) => {
    const stats = analyzeImageData(imageData(8, 8, [pixel]))

    expect(stats.sampledPixels).toBe(64)
    expect([
      ...stats.mean,
      ...stats.std,
      ...stats.labMean,
      ...stats.toneZones.flatMap((zone) => [zone.meanA, zone.meanB, zone.chroma]),
      stats.luma,
      stats.saturation,
      stats.warmBias,
      stats.tintBias,
    ]).toSatisfy((values: number[]) => values.every(Number.isFinite))
    expect(stats.histogram.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 8)
    expect(stats.toneHistogram.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 8)
  })

  it('reports near-zero saturation and neutral OKLab zones for grayscale pixels', () => {
    const stats = analyzeImageData(imageData(4, 2, [
      [0, 0, 0],
      [48, 48, 48],
      [128, 128, 128],
      [255, 255, 255],
    ]))

    expect(stats.saturation).toBeCloseTo(0, 8)
    expect(stats.warmBias).toBeCloseTo(0, 8)
    expect(stats.tintBias).toBeCloseTo(0, 8)
    for (const zone of stats.toneZones) {
      expect(zone.meanA).toBeCloseTo(0, 5)
      expect(zone.meanB).toBeCloseTo(0, 5)
    }
  })
})

describe('OKLab conversion', () => {
  const colors: RGB[] = [
    [0, 0, 0],
    [1, 1, 1],
    [0.18, 0.42, 0.77],
    [0.92, 0.31, 0.12],
  ]

  for (const rgb of colors) {
    it(`round-trips [${rgb.join(', ')}]`, () => {
      const result = oklabToRgb(rgbToOklab(rgb))

      expect(result[0]).toBeCloseTo(rgb[0], 5)
      expect(result[1]).toBeCloseTo(rgb[1], 5)
      expect(result[2]).toBeCloseTo(rgb[2], 5)
    })
  }
})

describe('cross-image matching', () => {
  it('creates a profile from statistics only, without paired pixels or matching dimensions', () => {
    const source = analyzeImageData(imageData(3, 2, [[20, 40, 80], [110, 120, 130], [220, 200, 170]]))
    const reference = analyzeImageData(imageData(5, 1, [[18, 55, 70], [90, 105, 115], [230, 210, 175]]))
    const profile = createMatchProfile(source, reference)

    expect(profile.transfer.toneCurve).toHaveLength(256)
    expect(profile.transfer.zones).toHaveLength(3)
    expect(profile.transfer.toneCurve.every(Number.isFinite)).toBe(true)
    expect(profile.transfer.toneCurve.every((value, index, curve) => index === 0 || value >= curve[index - 1])).toBe(true)
  })

  it('adopts a brighter tonal distribution moderately instead of copying absolute scene exposure', () => {
    const sourcePixels: Pixel[] = [[20, 20, 20], [40, 40, 40], [70, 70, 70], [100, 100, 100], [130, 130, 130]]
    const referencePixels: Pixel[] = [[90, 90, 90], [120, 120, 120], [160, 160, 160], [200, 200, 200], [235, 235, 235]]
    const profile = createMatchProfile(
      analyzeImageData(imageData(25, 1, sourcePixels)),
      analyzeImageData(imageData(15, 2, referencePixels)),
    )
    const input: RGB = [70 / 255, 70 / 255, 70 / 255]
    const result = transformRgb(input, neutralAdjustments, profile)

    expect(luma(result)).toBeGreaterThan(luma(input) + 0.005)
    expect(luma(result)).toBeLessThan(130 / 255)
  })

  it('transfers relative shadow and highlight color relationships across unrelated pixel layouts', () => {
    const sourcePixels: Pixel[] = [
      [18, 18, 18], [28, 28, 28], [38, 38, 38], [48, 48, 48],
      [95, 95, 95], [115, 115, 115], [135, 135, 135], [155, 155, 155],
      [195, 195, 195], [212, 212, 212], [228, 228, 228], [242, 242, 242],
    ]
    const referencePixels: Pixel[] = [
      [12, 42, 54], [18, 50, 62], [24, 58, 70], [30, 66, 78],
      [85, 92, 96], [108, 112, 114], [132, 132, 130], [152, 148, 142],
      [198, 181, 150], [218, 198, 162], [235, 215, 178], [248, 228, 190],
    ]
    const profile = createMatchProfile(
      analyzeImageData(imageData(6, 2, sourcePixels)),
      analyzeImageData(imageData(4, 3, referencePixels.slice().reverse())),
    )
    const preserveTone = { ...neutralAdjustments, preserveLuma: 100 }
    const shadow = transformRgb([36 / 255, 36 / 255, 36 / 255], preserveTone, profile)
    const highlight = transformRgb([225 / 255, 225 / 255, 225 / 255], preserveTone, profile)

    expect([...shadow, ...highlight].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true)
    expect(shadow[2]).toBeGreaterThan(shadow[0])
    expect(highlight[0]).toBeGreaterThan(highlight[2])
  })
})

describe('adaptive match controls and model context', () => {
  it('uses stronger transfer with lower luma preservation for comparable distributions', () => {
    const stats = analyzeImageData(imageData(4, 4, [
      [24, 42, 72], [88, 112, 144], [178, 154, 116], [232, 218, 198],
    ]))
    const controls = suggestMatchControls(createMatchProfile(stats, stats))

    expect(controls).toEqual({
      toneMatchStrength: 94,
      colorMatchStrength: 92,
      preserveLuma: 34,
      skinProtect: 66,
    })
  })

  it('becomes more conservative as independent image distributions diverge', () => {
    const similar = analyzeImageData(imageData(4, 4, [
      [25, 35, 55], [90, 105, 125], [175, 165, 145], [230, 220, 205],
    ]))
    const divergent = analyzeImageData(imageData(4, 4, [
      [5, 30, 65], [10, 70, 135], [35, 145, 210], [120, 235, 255],
    ]))
    const similarControls = suggestMatchControls(createMatchProfile(similar, similar))
    const divergentControls = suggestMatchControls(createMatchProfile(similar, divergent))

    expect(divergentControls.preserveLuma).toBeGreaterThan(similarControls.preserveLuma)
    expect(divergentControls.toneMatchStrength).toBeLessThan(similarControls.toneMatchStrength)
    expect(divergentControls.colorMatchStrength).toBeLessThan(similarControls.colorMatchStrength)
  })

  it('serializes compact non-paired measurements for the vision model', () => {
    const source = analyzeImageData(imageData(3, 2, [[20, 40, 80], [110, 120, 130], [220, 200, 170]]))
    const reference = analyzeImageData(imageData(5, 1, [[18, 55, 70], [90, 105, 115], [230, 210, 175]]))
    const profile = createMatchProfile(source, reference)
    const context = JSON.parse(createModelMatchContext(profile))

    expect(context.measurementVersion).toBe(1)
    expect(context.source.tonePercentiles).toHaveProperty('p05')
    expect(context.reference.toneZones).toHaveLength(3)
    expect(context.differences.labMean).toHaveLength(3)
    expect(context.localTransferControls).toEqual(suggestMatchControls(profile))
    expect(context.source).not.toHaveProperty('toneHistogram')
  })
})

describe('suggestAdjustments', () => {
  it('keeps identical source and reference images neutral', () => {
    const stats = analyzeImageData(imageData(4, 4, [
      [20, 40, 80],
      [90, 120, 150],
      [190, 160, 110],
      [235, 220, 200],
    ]))
    const suggestion = suggestAdjustments(createMatchProfile(stats, stats))

    expect(suggestion.exposure).toBeCloseTo(0, 8)
    expect(suggestion.contrast).toBeCloseTo(0, 8)
    expect(suggestion.temperature).toBeCloseTo(0, 8)
    expect(suggestion.tint).toBeCloseTo(0, 8)
    expect(suggestion.saturation).toBeCloseTo(0, 8)
    expect(suggestion.vibrance).toBeCloseTo(0, 8)
  })

  it('clamps automatic parameters to safe MVP ranges', () => {
    const darkCool = analyzeImageData(imageData(2, 2, [[0, 0, 18], [0, 4, 32]]))
    const brightWarm = analyzeImageData(imageData(2, 2, [[255, 245, 160], [255, 210, 80]]))
    const suggestion = suggestAdjustments(createMatchProfile(darkCool, brightWarm))

    expect(suggestion.exposure).toBeGreaterThanOrEqual(-2)
    expect(suggestion.exposure).toBeLessThanOrEqual(2)
    expect(suggestion.contrast).toBeGreaterThanOrEqual(-45)
    expect(suggestion.contrast).toBeLessThanOrEqual(45)
    expect(suggestion.temperature).toBeGreaterThanOrEqual(-55)
    expect(suggestion.temperature).toBeLessThanOrEqual(55)
    expect(suggestion.tint).toBeGreaterThanOrEqual(-45)
    expect(suggestion.tint).toBeLessThanOrEqual(45)
    expect(suggestion.saturation).toBeGreaterThanOrEqual(-35)
    expect(suggestion.saturation).toBeLessThanOrEqual(35)
    expect(suggestion.vibrance).toBeGreaterThanOrEqual(-25)
    expect(suggestion.vibrance).toBeLessThanOrEqual(25)
  })
})

describe('advanced fine-tune stages', () => {
  it('samples five-point curves and preserves the identity curve', () => {
    expect(sampleAdjustmentCurve(0.37, [0, 0.25, 0.5, 0.75, 1])).toBeCloseTo(0.37, 8)
    expect(sampleAdjustmentCurve(0.125, [0.08, 0.32, 0.5, 0.75, 0.96])).toBeGreaterThan(0.125)
  })

  it('applies a master lift and an independent red-channel curve', () => {
    const masterLift = createDefaultAdjustments()
    masterLift.curves.master = [0.08, 0.31, 0.54, 0.78, 1]
    masterLift.skinProtect = 0
    const lifted = transformRgb([0.12, 0.12, 0.12], masterLift)

    const redCurve = createDefaultAdjustments()
    redCurve.curves.red = [0, 0.38, 0.58, 0.78, 1]
    redCurve.skinProtect = 0
    const warmed = transformRgb([0.32, 0.32, 0.32], redCurve)

    expect(luma(lifted)).toBeGreaterThan(0.12)
    expect(warmed[0]).toBeGreaterThan(warmed[1] + 0.04)
    expect(warmed[1]).toBeCloseTo(warmed[2], 5)
  })

  it('targets a blue HSL band more strongly than an orange band', () => {
    const adjustments = createDefaultAdjustments()
    adjustments.skinProtect = 0
    adjustments.hsl.blue.luminance = -60
    adjustments.hsl.blue.saturation = 40
    const blueInput: RGB = [0.12, 0.34, 0.82]
    const orangeInput: RGB = [0.82, 0.38, 0.12]
    const blueResult = transformRgb(blueInput, adjustments)
    const orangeResult = transformRgb(orangeInput, adjustments)

    expect(luma(blueResult)).toBeLessThan(luma(blueInput) - 0.02)
    expect(Math.abs(luma(orangeResult) - luma(orangeInput))).toBeLessThan(0.02)
  })

  it('adds cool shadows and warm highlights with three-way grading', () => {
    const adjustments = createDefaultAdjustments()
    adjustments.skinProtect = 0
    adjustments.colorGrading.shadows = { hue: 270, saturation: 58, luminance: 0 }
    adjustments.colorGrading.midtones = { hue: 30, saturation: 0, luminance: 0 }
    adjustments.colorGrading.highlights = { hue: 70, saturation: 48, luminance: 0 }
    adjustments.colorGrading.blending = 28
    const shadow = transformRgb([0.12, 0.12, 0.12], adjustments)
    const highlight = transformRgb([0.86, 0.86, 0.86], adjustments)

    expect(shadow[2]).toBeGreaterThan(shadow[0])
    expect(highlight[0]).toBeGreaterThan(highlight[2])
  })

  it('uses constrained primary calibration without leaving the RGB gamut', () => {
    const adjustments = createDefaultAdjustments()
    adjustments.skinProtect = 0
    adjustments.calibration.redHue = 70
    adjustments.calibration.redSaturation = 55
    const input: RGB = [0.78, 0.2, 0.16]
    const result = transformRgb(input, adjustments)

    expect(result.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true)
    expect(result).not.toEqual(input)
  })
})
describe('linear-light adjustments', () => {
  it('applies exposure in linear light instead of multiplying encoded sRGB values', () => {
    const result = transformRgb([0.5, 0.5, 0.5], { ...neutralAdjustments, exposure: 1 })

    expect(result[0]).toBeCloseTo(0.6858, 3)
    expect(result[1]).toBeCloseTo(0.6858, 3)
    expect(result[2]).toBeCloseTo(0.6858, 3)
  })
})

describe('detail and optics-style adjustments', () => {
  it('applies dehaze as midtone contrast and saturation lift', () => {
    const flat = transformRgb([0.55, 0.52, 0.5], { ...neutralAdjustments, dehaze: 0, skinProtect: 0 })
    const dehazed = transformRgb([0.55, 0.52, 0.5], { ...neutralAdjustments, dehaze: 60, skinProtect: 0 })
    const haze = transformRgb([0.55, 0.52, 0.5], { ...neutralAdjustments, dehaze: -50, skinProtect: 0 })

    const flatSpan = Math.max(...flat) - Math.min(...flat)
    const dehazeSpan = Math.max(...dehazed) - Math.min(...dehazed)
    expect(dehazeSpan).toBeGreaterThan(flatSpan)
    expect(luma(haze)).toBeGreaterThan(luma(dehazed) - 0.05)
  })

  it('runs spatial detail and vignette through processImageData', () => {
    const width = 16
    const height = 16
    const flatPixels: Pixel[] = Array.from({ length: width * height }, () => [160, 160, 160, 255])
    const flat = imageData(width, height, flatPixels)

    const vignetteOnly = createDefaultAdjustments()
    vignetteOnly.skinProtect = 0
    vignetteOnly.vignette = -80
    vignetteOnly.vignetteMidpoint = 20
    vignetteOnly.vignetteFeather = 50
    const vignetted = processImageData(flat, vignetteOnly)
    const center = (8 * width + 8) * 4
    expect(vignetted.data[0]).toBeLessThan(vignetted.data[center])
    expect(vignetted.data[center]).toBeGreaterThan(100)

    const checkerPixels: Pixel[] = []
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const checker = ((x + y) % 2) * 180 + 40
        checkerPixels.push([checker, checker, checker, 255])
      }
    }
    const checker = imageData(width, height, checkerPixels)
    const detail = createDefaultAdjustments()
    detail.skinProtect = 0
    detail.texture = 50
    detail.clarity = 40
    detail.sharpen = 60
    const detailed = processImageData(checker, detail)
    expect([...detailed.data]).not.toEqual([...checker.data])
  })
})
