import { describe, expect, it } from 'vitest'
import { createDefaultAdjustments } from './defaults'
import { buildToneCdfTexture, packGpuAdjustments } from './gpuPreview'

describe('packGpuAdjustments', () => {
  it('packs high-frequency preview controls in shader order', () => {
    const adjustments = createDefaultAdjustments()
    adjustments.exposure = 1.25
    adjustments.contrast = -18
    adjustments.highlights = 42
    adjustments.shadows = -31
    adjustments.hsl.red = { hue: 3, saturation: 4, luminance: 5 }
    adjustments.hsl.orange = { hue: 6, saturation: 7, luminance: 8 }
    adjustments.colorGrading.shadows = { hue: 210, saturation: 12, luminance: -4 }
    adjustments.calibration.blueHue = 17
    adjustments.calibration.blueSaturation = -22
    adjustments.texture = 15
    adjustments.clarity = 22
    adjustments.dehaze = 8
    adjustments.sharpen = 40
    adjustments.sharpenRadius = 1.2
    adjustments.sharpenDetail = 30
    adjustments.sharpenMasking = 45
    adjustments.luminanceNoiseReduction = 12
    adjustments.colorNoiseReduction = 18
    adjustments.vignette = -28
    adjustments.vignetteMidpoint = 42
    adjustments.vignetteFeather = 55

    const packed = packGpuAdjustments(adjustments)

    expect([...packed.basic0]).toEqual([1.25, -18, 42, -31])
    expect([...packed.hsl.slice(0, 6)]).toEqual([3, 4, 5, 6, 7, 8])
    expect([...packed.grade.slice(0, 3)]).toEqual([210, 12, -4])
    expect([...packed.calibration1]).toEqual([17, -22])
    expect([...packed.detail0]).toEqual([15, 22, 8, 40])
    expect(packed.detail1[0]).toBeCloseTo(1.2)
    expect([...packed.detail1.slice(1)]).toEqual([30, 45, 12])
    expect([...packed.detail2]).toEqual([18, -28, 42, 55])
  })

  it('normalizes invalid and descending curves exactly once before upload', () => {
    const adjustments = createDefaultAdjustments()
    adjustments.curves.master = [-1, 0.7, 0.2, 2, 0.9]
    adjustments.curves.red = [0, Number.NaN, 0.5, 0.75, 1]

    const packed = packGpuAdjustments(adjustments)

    expect(packed.curves).toHaveLength(68)
    expect(packed.curves[0]).toBe(0)
    expect(packed.curves[4]).toBeCloseTo(0.7)
    expect(packed.curves[8]).toBeCloseTo(0.7)
    expect(packed.curves[12]).toBe(1)
    expect(packed.curves[16]).toBe(1)
    expect([...packed.curves.slice(17, 34)]).toEqual(expect.arrayContaining([0, 0.5, 1]))
  })

  it('preserves all samples from imported 17-point curves', () => {
    const adjustments = createDefaultAdjustments()
    adjustments.curves.master = Array.from({ length: 17 }, (_, index) => (index / 16) ** 1.4)

    const packed = packGpuAdjustments(adjustments)

    expect([...packed.curves.slice(0, 17)]).toEqual(
      adjustments.curves.master.map((value) => expect.closeTo(value)),
    )
  })
})

describe('buildToneCdfTexture', () => {
  it('stores prefix probability and current bin probability without a per-pixel loop', () => {
    const histogram = Array.from({ length: 256 }, () => 0)
    histogram[0] = 0.1
    histogram[1] = 0.25
    histogram[2] = 0.65

    const texture = buildToneCdfTexture(histogram)

    expect([...texture.slice(0, 8)]).toEqual([
      0, expect.closeTo(0.1),
      expect.closeTo(0.1), 0.25,
      expect.closeTo(0.35), expect.closeTo(0.65),
      1, 0,
    ])
  })

  it('sanitizes missing, negative, and non-finite histogram values', () => {
    const texture = buildToneCdfTexture([0.4, -1, Number.NaN, 0.6])

    expect(texture[0]).toBeCloseTo(0)
    expect(texture[1]).toBeCloseTo(0.4)
    expect(texture[2]).toBeCloseTo(0.4)
    expect(texture[3]).toBeCloseTo(0)
    expect(texture[6]).toBeCloseTo(0.4)
    expect(texture[7]).toBeCloseTo(0.6)
    expect(texture[8]).toBeCloseTo(1)
  })
})
