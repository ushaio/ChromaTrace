export type RGB = [number, number, number]

export interface ToneZoneStats {
  meanA: number
  meanB: number
  chroma: number
  sampledPixels: number
}

export interface CrossImageTransfer {
  toneCurve: Float32Array
  zones: [ToneZoneStats, ToneZoneStats, ToneZoneStats]
  sourceZones: [ToneZoneStats, ToneZoneStats, ToneZoneStats]
}

export interface ColorStats {
  mean: RGB
  std: RGB
  luma: number
  saturation: number
  warmBias: number
  tintBias: number
  labMean: [number, number, number]
  labChroma: number
  histogram: number[]
  toneHistogram: number[]
  toneZones: [ToneZoneStats, ToneZoneStats, ToneZoneStats]
  sampledPixels: number
}

export interface MatchProfile {
  source: ColorStats
  reference: ColorStats
  transfer: CrossImageTransfer
}

export interface MatchControls {
  toneMatchStrength: number
  colorMatchStrength: number
  preserveLuma: number
  skinProtect: number
}

export type CurveChannel = 'master' | 'red' | 'green' | 'blue'
export type ToneCurves = Record<CurveChannel, number[]>
export type HslChannel = 'red' | 'orange' | 'yellow' | 'green' | 'aqua' | 'blue' | 'purple' | 'magenta'

export interface HslChannelAdjustment {
  hue: number
  saturation: number
  luminance: number
}

export type HslAdjustments = Record<HslChannel, HslChannelAdjustment>
export type ColorGradeZoneName = 'shadows' | 'midtones' | 'highlights'

export interface ColorGradeZone {
  hue: number
  saturation: number
  luminance: number
}

export interface ColorGradingAdjustments {
  shadows: ColorGradeZone
  midtones: ColorGradeZone
  highlights: ColorGradeZone
  balance: number
  blending: number
}

export interface CalibrationAdjustments {
  redHue: number
  redSaturation: number
  greenHue: number
  greenSaturation: number
  blueHue: number
  blueSaturation: number
}

export interface Adjustments {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  temperature: number
  tint: number
  vibrance: number
  saturation: number
  fade: number
  grain: number
  /** Mid/high-frequency structure (-100..100), Lightroom Texture. */
  texture: number
  /** Midtone local contrast (-100..100), Lightroom Clarity. */
  clarity: number
  /** Atmospheric contrast (-100..100), Lightroom Dehaze. */
  dehaze: number
  /** Unsharp amount (0..150), Lightroom SharpenAmount. */
  sharpen: number
  /** Blur radius for unsharp (0.5..3). */
  sharpenRadius: number
  /** Fine-detail emphasis (0..100). */
  sharpenDetail: number
  /** Edge masking to protect flat areas (0..100). */
  sharpenMasking: number
  /** Luminance noise reduction (0..100). */
  luminanceNoiseReduction: number
  /** Color noise reduction (0..100). */
  colorNoiseReduction: number
  /** Radial vignette amount (-100..100). */
  vignette: number
  /** Vignette start distance (0..100). */
  vignetteMidpoint: number
  /** Vignette soft falloff (0..100). */
  vignetteFeather: number
  toneMatchStrength: number
  colorMatchStrength: number
  preserveLuma: number
  skinProtect: number
  curves: ToneCurves
  hsl: HslAdjustments
  colorGrading: ColorGradingAdjustments
  calibration: CalibrationAdjustments
  /**
   * 3D CUBE LUT mix amount (0–100). The LUT table itself is stored separately
   * (not serializable as plain adjustments) and applied after grading.
   */
  lutAmount: number
}

export type ModelApiType = 'responses' | 'chat-completions' | 'images-generations'
export type AiColorMethod = 'local-parameters' | 'image-generation'
export type ImageQuality = 'low' | 'medium' | 'high' | 'standard' | 'hd'
export type ImageSize =
  | 'auto'
  | '256x256'
  | '512x512'
  | '1024x1024'
  | '1536x1024'
  | '1024x1536'
  | '1792x1024'
  | '1024x1792'
export type ImageStyle = 'vivid' | 'natural'
export type ImageResponseFormat = 'url' | 'b64_json'

export interface ImageGenerationRequestOptions {
  quality?: ImageQuality
  size?: ImageSize
  style?: ImageStyle
  n?: number
  responseFormat?: ImageResponseFormat
}

/** 旧版单供应商配置，仅用于无损迁移。 */
export interface ModelConfig {
  enabled: boolean
  providerName: string
  baseUrl: string
  model: string
  apiType: ModelApiType
  timeoutSeconds: number
  maxImageSide: number
  privacyAccepted: boolean
  imageModel: string
  imageQuality: ImageQuality
  imageSize: ImageSize
  imageTimeoutSeconds: number
  generationMaxImageSide: number
  generationPrivacyAccepted: boolean
}

export interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  apiType: ModelApiType
}

export interface VisionModelConfig {
  id: string
  providerId: string
  name: string
  model: string
  timeoutSeconds: number
  maxImageSide: number
  privacyAccepted: boolean
}

export interface ImageGenerationModelConfig {
  id: string
  providerId: string
  name: string
  model: string
  timeoutSeconds: number
  maxImageSide: number
  privacyAccepted: boolean
}

export interface ModelSettings {
  version: 2
  enabled: boolean
  providers: ModelProvider[]
  visionModels: VisionModelConfig[]
  imageModels: ImageGenerationModelConfig[]
  activeVisionModelId: string
  activeImageModelId: string
}

export interface VisionRuntimeConfig extends VisionModelConfig {
  providerName: string
  baseUrl: string
  apiType: ModelApiType
}

export interface ImageGenerationRuntimeConfig extends ImageGenerationModelConfig {
  providerName: string
  baseUrl: string
  apiType: ModelApiType
}

export interface ModelColorParameters extends Adjustments {
  styleDescription: string
}

export interface AiGradeParameters {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  temperature: number
  tint: number
  vibrance: number
  saturation: number
  fade: number
  grain: number
}

export interface ColorWorkflowSuggestion {
  id: string
  title: string
  description: string
  rationale: string
  generationPrompt: string
  parameters: AiGradeParameters
}

export interface GeneratedImageResult {
  imageDataUrl: string
  revisedPrompt?: string
}

