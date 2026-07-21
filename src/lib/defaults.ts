import type {
  Adjustments, CalibrationAdjustments, ColorGradingAdjustments, HslAdjustments, HslChannel,
  ModelConfig, ModelSettings, ToneCurves,
} from './types'

export const CURVE_IDENTITY = [0, 0.25, 0.5, 0.75, 1]
export const HSL_CHANNELS: HslChannel[] = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']

function neutralCurves(): ToneCurves {
  return {
    master: [...CURVE_IDENTITY],
    red: [...CURVE_IDENTITY],
    green: [...CURVE_IDENTITY],
    blue: [...CURVE_IDENTITY],
  }
}

function neutralHsl(): HslAdjustments {
  return Object.fromEntries(HSL_CHANNELS.map((channel) => [channel, {
    hue: 0,
    saturation: 0,
    luminance: 0,
  }])) as HslAdjustments
}

function neutralColorGrading(): ColorGradingAdjustments {
  return {
    shadows: { hue: 210, saturation: 0, luminance: 0 },
    midtones: { hue: 35, saturation: 0, luminance: 0 },
    highlights: { hue: 48, saturation: 0, luminance: 0 },
    balance: 0,
    blending: 50,
  }
}

function neutralCalibration(): CalibrationAdjustments {
  return {
    redHue: 0,
    redSaturation: 0,
    greenHue: 0,
    greenSaturation: 0,
    blueHue: 0,
    blueSaturation: 0,
  }
}

export function createDefaultAdjustments(): Adjustments {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temperature: 0,
    tint: 0,
    vibrance: 0,
    saturation: 0,
    fade: 0,
    grain: 0,
    toneMatchStrength: 88,
    colorMatchStrength: 86,
    preserveLuma: 50,
    skinProtect: 65,
    curves: neutralCurves(),
    hsl: neutralHsl(),
    colorGrading: neutralColorGrading(),
    calibration: neutralCalibration(),
  }
}

export const DEFAULT_ADJUSTMENTS: Adjustments = createDefaultAdjustments()

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  enabled: false,
  providerName: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  apiType: 'responses',
  timeoutSeconds: 60,
  maxImageSide: 1536,
  privacyAccepted: false,
  imageModel: 'gpt-image-2',
  imageQuality: 'medium',
  imageSize: 'auto',
  imageTimeoutSeconds: 180,
  generationMaxImageSide: 2048,
  generationPrivacyAccepted: false,
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  version: 2,
  enabled: false,
  providers: [{
    id: 'provider-default',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiType: 'responses',
  }],
  visionModels: [{
    id: 'vision-default',
    providerId: 'provider-default',
    name: '默认视觉模型',
    model: '',
    timeoutSeconds: 60,
    maxImageSide: 1536,
    privacyAccepted: false,
  }],
  imageModels: [{
    id: 'image-default',
    providerId: 'provider-default',
    name: '默认图像模型',
    model: 'gpt-image-2',
    timeoutSeconds: 180,
    maxImageSide: 2048,
    privacyAccepted: false,
  }],
  activeVisionModelId: 'vision-default',
  activeImageModelId: 'image-default',
}
