import { createDefaultAdjustments } from './defaults'
import type { Adjustments, AiGradeParameters } from './types'

export function scaleGradeParameters(parameters: AiGradeParameters, intensity: number): Adjustments {
  const scale = Math.max(0, Math.min(100, intensity)) / 100
  return {
    ...createDefaultAdjustments(),
    exposure: parameters.exposure * scale,
    contrast: parameters.contrast * scale,
    highlights: parameters.highlights * scale,
    shadows: parameters.shadows * scale,
    whites: parameters.whites * scale,
    blacks: parameters.blacks * scale,
    temperature: parameters.temperature * scale,
    tint: parameters.tint * scale,
    vibrance: parameters.vibrance * scale,
    saturation: parameters.saturation * scale,
    fade: parameters.fade * scale,
    grain: parameters.grain * scale,
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

export function mergeGradeWithFineTune(
  parameters: AiGradeParameters,
  intensity: number,
  fineTune: Adjustments,
): Adjustments {
  const base = scaleGradeParameters(parameters, intensity)
  return {
    ...fineTune,
    exposure: clamp(base.exposure + fineTune.exposure, -3, 3),
    contrast: clamp(base.contrast + fineTune.contrast, -100, 100),
    highlights: clamp(base.highlights + fineTune.highlights, -100, 100),
    shadows: clamp(base.shadows + fineTune.shadows, -100, 100),
    whites: clamp(base.whites + fineTune.whites, -100, 100),
    blacks: clamp(base.blacks + fineTune.blacks, -100, 100),
    temperature: clamp(base.temperature + fineTune.temperature, -100, 100),
    tint: clamp(base.tint + fineTune.tint, -100, 100),
    vibrance: clamp(base.vibrance + fineTune.vibrance, -100, 100),
    saturation: clamp(base.saturation + fineTune.saturation, -100, 100),
    fade: clamp(base.fade + fineTune.fade, 0, 100),
    grain: clamp(base.grain + fineTune.grain, 0, 100),
  }
}
