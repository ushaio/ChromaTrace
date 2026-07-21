import { describe, expect, it } from 'vitest'
import { mergeGradeWithFineTune, scaleGradeParameters } from './aiColor'
import { createDefaultAdjustments } from './defaults'
import type { AiGradeParameters } from './types'

const recipe: AiGradeParameters = {
  exposure: 1.2,
  contrast: 40,
  highlights: -30,
  shadows: 20,
  whites: 10,
  blacks: -15,
  temperature: 24,
  tint: -8,
  vibrance: 30,
  saturation: -10,
  fade: 12,
  grain: 18,
}

describe('scaleGradeParameters', () => {
  it('maps a full recipe into local adjustments', () => {
    const result = scaleGradeParameters(recipe, 100)
    expect(result.exposure).toBe(1.2)
    expect(result.highlights).toBe(-30)
    expect(result.grain).toBe(18)
    expect(result.toneMatchStrength).toBe(88)
    expect(result.colorMatchStrength).toBe(86)
  })

  it('scales recipe intensity and clamps the intensity range', () => {
    expect(scaleGradeParameters(recipe, 50).contrast).toBe(20)
    expect(scaleGradeParameters(recipe, -20).temperature).toBe(0)
    expect(scaleGradeParameters(recipe, 160).vibrance).toBe(30)
  })
})

describe('mergeGradeWithFineTune', () => {
  it('adds manual basic corrections on top of the scaled recipe', () => {
    const fineTune = createDefaultAdjustments()
    fineTune.exposure = 0.3
    fineTune.highlights = 12
    fineTune.hsl.blue.saturation = -25

    const result = mergeGradeWithFineTune(recipe, 50, fineTune)
    expect(result.exposure).toBeCloseTo(0.9)
    expect(result.highlights).toBe(-3)
    expect(result.hsl.blue.saturation).toBe(-25)
  })

  it('clamps combined values while preserving advanced controls', () => {
    const fineTune = createDefaultAdjustments()
    fineTune.exposure = 3
    fineTune.fade = 95
    fineTune.curves.red = [0, 0.2, 0.55, 0.8, 1]

    const result = mergeGradeWithFineTune(recipe, 100, fineTune)
    expect(result.exposure).toBe(3)
    expect(result.fade).toBe(100)
    expect(result.curves.red).toEqual([0, 0.2, 0.55, 0.8, 1])
  })
})
