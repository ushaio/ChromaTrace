import { describe, expect, it } from 'vitest'
import { createDefaultAdjustments } from './defaults'
import { applyFineTuneModuleVisibility, type FineTuneModuleVisibility } from './fineTuneVisibility'

describe('applyFineTuneModuleVisibility', () => {
  it('returns the original adjustments when every module is visible', () => {
    const adjustments = createDefaultAdjustments()
    expect(applyFineTuneModuleVisibility(adjustments, {})).toBe(adjustments)
  })

  it('neutralizes hidden modules without changing the stored parameters', () => {
    const adjustments = createDefaultAdjustments()
    Object.assign(adjustments, {
      exposure: 1, contrast: 20, highlights: -30, shadows: 40, whites: 15, blacks: -12,
      temperature: 25, tint: -10, vibrance: 30, saturation: -20,
      texture: 21, clarity: 22, dehaze: 23, sharpen: 80,
      luminanceNoiseReduction: 31, colorNoiseReduction: 32,
      vignette: -35, fade: 12, grain: 24,
    })
    adjustments.curves.master = [0.1, 0.4, 0.9]
    adjustments.hsl.orange = { hue: 12, saturation: 34, luminance: 56 }
    adjustments.colorGrading.shadows = { hue: 220, saturation: 45, luminance: -8 }
    adjustments.calibration.redHue = 18
    const snapshot = structuredClone(adjustments)
    const visibility: FineTuneModuleVisibility = {
      light: false,
      color: false,
      curve: false,
      hsl: false,
      grading: false,
      calibration: false,
      detail: false,
      finish: false,
    }

    const result = applyFineTuneModuleVisibility(adjustments, visibility)

    expect(result).toMatchObject({
      exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
      temperature: 0, tint: 0, vibrance: 0, saturation: 0,
      texture: 0, clarity: 0, dehaze: 0, sharpen: 0,
      luminanceNoiseReduction: 0, colorNoiseReduction: 0,
      vignette: 0, fade: 0, grain: 0,
    })
    expect(result.curves.master).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(result.hsl.orange).toEqual({ hue: 0, saturation: 0, luminance: 0 })
    expect(result.colorGrading.shadows).toEqual({ hue: 220, saturation: 0, luminance: 0 })
    expect(result.calibration).toEqual({
      redHue: 0,
      redSaturation: 0,
      greenHue: 0,
      greenSaturation: 0,
      blueHue: 0,
      blueSaturation: 0,
    })
    expect(result.sharpenRadius).toBe(adjustments.sharpenRadius)
    expect(result.vignetteMidpoint).toBe(adjustments.vignetteMidpoint)
    expect(adjustments).toEqual(snapshot)
  })
})
