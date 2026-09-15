import { CURVE_IDENTITY, HSL_CHANNELS } from './defaults'
import type { Adjustments, ColorGradeZoneName, ToneCurves } from './types'

export type FineTuneModuleId =
  | 'light'
  | 'color'
  | 'curve'
  | 'hsl'
  | 'grading'
  | 'calibration'
  | 'detail'
  | 'finish'

export type FineTuneModuleVisibility = Partial<Record<FineTuneModuleId, boolean>>

const COLOR_GRADING_ZONES: ColorGradeZoneName[] = ['shadows', 'midtones', 'highlights']

function neutralCurves(): ToneCurves {
  return {
    master: [...CURVE_IDENTITY],
    red: [...CURVE_IDENTITY],
    green: [...CURVE_IDENTITY],
    blue: [...CURVE_IDENTITY],
  }
}

export function applyFineTuneModuleVisibility(
  adjustments: Adjustments,
  visibility: FineTuneModuleVisibility,
): Adjustments {
  let result = adjustments
  const bypassed = (id: FineTuneModuleId) => visibility[id] === false

  if (bypassed('light')) {
    result = {
      ...result,
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
    }
  }

  if (bypassed('color')) {
    result = {
      ...result,
      temperature: 0,
      tint: 0,
      vibrance: 0,
      saturation: 0,
    }
  }

  if (bypassed('curve')) result = { ...result, curves: neutralCurves() }

  if (bypassed('hsl')) {
    result = {
      ...result,
      hsl: Object.fromEntries(HSL_CHANNELS.map((channel) => [channel, {
        hue: 0,
        saturation: 0,
        luminance: 0,
      }])) as Adjustments['hsl'],
    }
  }

  if (bypassed('grading')) {
    const colorGrading = { ...result.colorGrading }
    for (const zone of COLOR_GRADING_ZONES) {
      colorGrading[zone] = { ...colorGrading[zone], saturation: 0, luminance: 0 }
    }
    result = { ...result, colorGrading }
  }

  if (bypassed('calibration')) {
    result = {
      ...result,
      calibration: {
        redHue: 0,
        redSaturation: 0,
        greenHue: 0,
        greenSaturation: 0,
        blueHue: 0,
        blueSaturation: 0,
      },
    }
  }

  if (bypassed('detail')) {
    result = {
      ...result,
      texture: 0,
      clarity: 0,
      dehaze: 0,
      sharpen: 0,
      luminanceNoiseReduction: 0,
      colorNoiseReduction: 0,
    }
  }

  if (bypassed('finish')) {
    result = { ...result, vignette: 0, fade: 0, grain: 0 }
  }

  return result
}
