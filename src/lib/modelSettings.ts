import { DEFAULT_MODEL_SETTINGS } from './defaults'
import type {
  ImageGenerationModelConfig, ImageGenerationRuntimeConfig, ModelConfig, ModelProvider,
  ModelSettings, VisionModelConfig, VisionRuntimeConfig,
} from './types'

const cloneDefaults = (): ModelSettings => ({
  ...DEFAULT_MODEL_SETTINGS,
  providers: DEFAULT_MODEL_SETTINGS.providers.map((provider) => ({ ...provider })),
  visionModels: DEFAULT_MODEL_SETTINGS.visionModels.map((model) => ({ ...model })),
  imageModels: DEFAULT_MODEL_SETTINGS.imageModels.map((model) => ({ ...model })),
})

export function createConfigId(prefix: 'provider' | 'vision' | 'image') {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${suffix}`
}

export function createProvider(index: number): ModelProvider {
  return {
    id: createConfigId('provider'),
    name: `供应商 ${index}`,
    baseUrl: '',
    apiType: 'responses',
  }
}

export function createVisionModel(providerId: string, index: number): VisionModelConfig {
  return {
    id: createConfigId('vision'),
    providerId,
    name: `视觉模型 ${index}`,
    model: '',
    timeoutSeconds: 60,
    maxImageSide: 1536,
    privacyAccepted: false,
  }
}

export function createImageModel(providerId: string, index: number): ImageGenerationModelConfig {
  return {
    id: createConfigId('image'),
    providerId,
    name: `图像模型 ${index}`,
    model: '',
    timeoutSeconds: 180,
    maxImageSide: 2048,
    privacyAccepted: false,
  }
}

function isLegacyConfig(value: unknown): value is ModelConfig {
  return Boolean(value && typeof value === 'object' && 'providerName' in value && 'baseUrl' in value)
}

export function migrateLegacyModelConfig(value: ModelConfig): ModelSettings {
  return {
    version: 2,
    enabled: Boolean(value.enabled),
    providers: [{
      id: 'provider-default',
      name: value.providerName || 'OpenAI',
      baseUrl: value.baseUrl || 'https://api.openai.com/v1',
      apiType: value.apiType === 'chat-completions' || value.apiType === 'images-generations'
        ? value.apiType
        : 'responses',
    }],
    visionModels: [{
      id: 'vision-default',
      providerId: 'provider-default',
      name: '默认视觉模型',
      model: value.model || '',
      timeoutSeconds: value.timeoutSeconds || 60,
      maxImageSide: value.maxImageSide || 1536,
      privacyAccepted: Boolean(value.privacyAccepted),
    }],
    imageModels: [{
      id: 'image-default',
      providerId: 'provider-default',
      name: '默认图像模型',
      model: value.imageModel || 'gpt-image-2',
      timeoutSeconds: value.imageTimeoutSeconds || 180,
      maxImageSide: value.generationMaxImageSide || 2048,
      privacyAccepted: Boolean(value.generationPrivacyAccepted),
    }],
    activeVisionModelId: 'vision-default',
    activeImageModelId: 'image-default',
  }
}

export function normalizeModelSettings(value: unknown): ModelSettings {
  if (isLegacyConfig(value)) return migrateLegacyModelConfig(value)
  if (!value || typeof value !== 'object') return cloneDefaults()

  const stored = value as Partial<ModelSettings>
  const fallback = cloneDefaults()
  const providers: ModelProvider[] = Array.isArray(stored.providers) && stored.providers.length
    ? stored.providers.filter(Boolean).map((provider) => ({
        id: String(provider.id || createConfigId('provider')),
        name: String(provider.name || '未命名供应商'),
        baseUrl: String(provider.baseUrl || ''),
        apiType: provider.apiType === 'chat-completions' || provider.apiType === 'images-generations'
          ? provider.apiType
          : 'responses',
      }))
    : fallback.providers
  const providerIds = new Set(providers.map((provider) => provider.id))
  const defaultProviderId = providers[0].id
  const visionModels: VisionModelConfig[] = Array.isArray(stored.visionModels)
    ? stored.visionModels.filter(Boolean).map((model) => ({
        id: String(model.id || createConfigId('vision')),
        providerId: providerIds.has(model.providerId) ? model.providerId : defaultProviderId,
        name: String(model.name || model.model || '未命名视觉模型'),
        model: String(model.model || ''),
        timeoutSeconds: Number(model.timeoutSeconds) || 60,
        maxImageSide: Number(model.maxImageSide) || 1536,
        privacyAccepted: Boolean(model.privacyAccepted),
      }))
    : fallback.visionModels.map((model) => ({ ...model, providerId: defaultProviderId }))
  const imageModels: ImageGenerationModelConfig[] = Array.isArray(stored.imageModels)
    ? stored.imageModels.filter(Boolean).map((model) => ({
        id: String(model.id || createConfigId('image')),
        providerId: providerIds.has(model.providerId) ? model.providerId : defaultProviderId,
        name: String(model.name || model.model || '未命名图像模型'),
        model: String(model.model || ''),
        timeoutSeconds: Number(model.timeoutSeconds) || 180,
        maxImageSide: Number(model.maxImageSide) || 2048,
        privacyAccepted: Boolean(model.privacyAccepted),
      }))
    : fallback.imageModels.map((model) => ({ ...model, providerId: defaultProviderId }))
  return {
    version: 2,
    enabled: Boolean(stored.enabled),
    providers,
    visionModels,
    imageModels,
    activeVisionModelId: visionModels.some((model) => model.id === stored.activeVisionModelId)
      ? stored.activeVisionModelId as string
      : visionModels[0]?.id || '',
    activeImageModelId: imageModels.some((model) => model.id === stored.activeImageModelId)
      ? stored.activeImageModelId as string
      : imageModels[0]?.id || '',
  }
}

export function resolveVisionModel(settings: ModelSettings): VisionRuntimeConfig | null {
  const model = settings.visionModels.find((item) => item.id === settings.activeVisionModelId)
  if (!model) return null
  const provider = settings.providers.find((item) => item.id === model.providerId)
  return provider ? { ...model, providerName: provider.name, baseUrl: provider.baseUrl, apiType: provider.apiType } : null
}

export function resolveImageModel(settings: ModelSettings): ImageGenerationRuntimeConfig | null {
  const model = settings.imageModels.find((item) => item.id === settings.activeImageModelId)
  if (!model) return null
  const provider = settings.providers.find((item) => item.id === model.providerId)
  return provider ? { ...model, providerName: provider.name, baseUrl: provider.baseUrl, apiType: provider.apiType } : null
}


