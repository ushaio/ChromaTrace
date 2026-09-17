import type { FineTuneModuleVisibility } from './fineTuneVisibility'

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

// ---------------------------------------------------------------------------
// 工作区（多图导入 + 缩略图栏）
// ---------------------------------------------------------------------------

/** 图片来源：复制到工作区 / 直接引用源路径。 */
export type WorkspacePhotoOrigin = 'copy' | 'reference'
export type WorkspacePhotoStatus = 'pending' | 'copying' | 'ready' | 'failed' | 'missing'
export type VolumeDriveType = 'removable' | 'fixed' | 'remote' | 'cdrom' | 'ramdisk' | 'unknown'
export type VolumePolicy = 'copy' | 'reference'
export type WorkspaceRenderMode = 'none' | 'local' | 'ai'

/** 卷策略记忆条目：按 volumeId 记住用户对该卷的复制 / 引用选择。 */
export interface VolumePolicyRecord {
  policy: VolumePolicy
  /** 卷标，仅用于在「设置 → 资料库 → 卷记忆」里辨认是哪块盘。 */
  label: string
  updatedAt: number
}

/** Rust `SourceVolume`：判定粒度是挂载卷，不是文件。 */
export interface SourceVolume {
  rootPath: string
  /** 卷序列号 / 卷 UUID —— 稳定身份，盘符会漂移。 */
  volumeId: string
  label: string
  driveType: VolumeDriveType
  /** 已记忆的策略优先，否则按 driveType 推荐。 */
  recommendation: VolumePolicy
  rememberedPolicy: VolumePolicy | null
  fileCount: number
  totalBytes: number
}

/** 工作区级参考图，或单图专属参考图覆盖。 */
export interface WorkspaceReferenceEntry {
  id: string
  origin: WorkspacePhotoOrigin
  volumeId: string
  relativeSourcePath: string
  /** 仅用于展示与重新定位，不作身份依据。 */
  sourcePath: string
  workspacePath: string | null
  status: WorkspacePhotoStatus
  stats: ColorStats | null
}

/** 每张图片独立持有的编辑参数。 */
export interface WorkspaceDevelop {
  adjustments: Adjustments
  fineTuneVisibility: FineTuneModuleVisibility
  matchRenderMode: WorkspaceRenderMode
  modelStyle: string
}

export interface WorkspacePhoto {
  /** sha1(volumeId + "|" + relativeSourcePath) */
  id: string
  volumeId: string
  /** 卷内相对路径，如 "2024/Wedding/IMG_0001.CR3"。 */
  relativeSourcePath: string
  sourcePath: string
  origin: WorkspacePhotoOrigin
  workspacePath: string | null
  status: WorkspacePhotoStatus
  sizeBytes: number
  mtimeMs: number
  isRaw: boolean
  width: number | null
  height: number | null
  thumbKey: string | null
  stats: ColorStats | null
  referenceOverride: WorkspaceReferenceEntry | null
  develop: WorkspaceDevelop | null
  editedAt: number | null
}

export interface WorkspaceManifest {
  version: number
  id: string
  createdAt: number
  updatedAt: number
  /** 每次保存自增，用于乐观并发校验。 */
  revision: number
  reference: WorkspaceReferenceEntry | null
  photos: WorkspacePhoto[]
}

/**
 * 工作区注册表条目（Rust `WorkspaceInfo`）。
 *
 * 只承载名称等元数据：张数与封面由列表页按需读各工作区的 manifest 惰性补全，
 * 避免与 manifest 形成第二份需要保持一致的真相源（改名因此不参与 revision 乐观并发）。
 */
export interface WorkspaceInfo {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

/** Rust `WorkspaceImportEntry`。 */
export interface WorkspaceImportEntry {
  /** 当前绝对路径，用于实际读取。 */
  sourcePath: string
  volumeId: string
  relativeSourcePath: string
  targetRelative: string
  origin: WorkspacePhotoOrigin
}

export interface WorkspaceImportProgress {
  jobId: string
  phase: 'preparing' | 'copying' | 'finalizing' | 'completed' | 'cancelled'
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
  percent: number
  currentFile: string | null
}

export interface WorkspaceImportFailure {
  sourcePath: string
  error: string
}

export interface WorkspaceImportReport {
  manifest: WorkspaceManifest
  imported: WorkspacePhoto[]
  /** 已在工作区、被跳过的 photo id。 */
  skipped: string[]
  failed: WorkspaceImportFailure[]
  copiedBytes: number
  copiedFiles: number
  cancelled: boolean
}

/** Rust `ResolvedWorkspacePhoto`：reference 模式解析出的真实读取路径。 */
export interface ResolvedWorkspacePhoto {
  photoId: string
  path: string | null
  status: WorkspacePhotoStatus
  /** 卷未挂载与文件已删除文案不同，必须分开。 */
  reason: string | null
  volumeMounted: boolean
}

/** 按卷聚合的卷缺席条目，一个卷一条。 */
export interface WorkspaceVolumeAbsence {
  volumeId: string
  label: string
  rootPath: string
  photoCount: number
}

export interface WorkspaceDiskSpace {
  path: string
  availableBytes: number
  totalBytes: number
}

export interface WorkspaceCacheReport {
  removedFiles: number
  freedBytes: number
}

/** 属性弹窗里的一行：标签 + 已格式化的值（Rust `PropertiesField`）。 */
export interface PropertiesField {
  label: string
  value: string
}

/** 属性弹窗里的一组，如「曝光」「相机与镜头」（Rust `PropertiesGroup`）。 */
export interface PropertiesGroup {
  title: string
  fields: PropertiesField[]
}

/**
 * 一张图片的属性（Rust `WorkspacePhotoProperties`）。
 *
 * 文件系统信息给的是数字（时间戳交给前端按本地时区渲染），EXIF 直接给成品文案，
 * 因此前端不需要认识 EXIF 标签表，加标签也不用改 TS。
 */
export interface WorkspacePhotoProperties {
  photoId: string
  fileName: string
  relativeSourcePath: string
  sourcePath: string
  workspacePath: string | null
  /** 当前真实读取路径（副本 → originals/，引用 → 挂载点）。 */
  resolvedPath: string | null
  origin: WorkspacePhotoOrigin
  status: WorkspacePhotoStatus
  statusReason: string | null
  volumeId: string
  isRaw: boolean
  extension: string
  sizeBytes: number
  modifiedMs: number | null
  editedAt: number | null
  width: number | null
  height: number | null
  /** EXIF 来源：自行解析原文件 / RAW 元数据兜底 / 无数据。 */
  exifSource: 'file' | 'rawler' | null
  exifNote: string | null
  exifGroups: PropertiesGroup[]
}

/** 批量删除结果（Rust `DeleteWorkspacePhotosReport`）。 */
export interface DeleteWorkspacePhotosReport {
  manifest: WorkspaceManifest
  removedPhotoIds: string[]
  removedFiles: number
  freedBytes: number
}

