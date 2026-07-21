import { invoke } from '@tauri-apps/api/core'
import { configDir, dirname, join, pictureDir } from '@tauri-apps/api/path'
import { open, save } from '@tauri-apps/plugin-dialog'
import { load } from '@tauri-apps/plugin-store'
import type {
  ColorWorkflowSuggestion, GeneratedImageResult, ImageGenerationRequestOptions, ImageGenerationRuntimeConfig, ModelColorParameters,
  ModelProvider, ModelSettings, VisionRuntimeConfig,
} from './types'
import { DEFAULT_MODEL_SETTINGS } from './defaults'
import { normalizeModelSettings } from './modelSettings'

const STORE_PATH = 'settings.json'
const MODEL_SETTINGS_KEY = 'modelSettingsV2'
const LEGACY_MODEL_KEY = 'modelConfig'
const LAST_IMAGE_DIRECTORY_KEY = 'lastImageDirectory'
const LAST_LIGHTROOM_XMP_PATH_KEY = 'lastLightroomXmpPath'
const browserApiKeys = new Map<string, string>()

export const isTauri = () => '__TAURI_INTERNALS__' in window

async function imageDefaultPath() {
  try {
    const store = await load(STORE_PATH)
    const lastDirectory = await store.get<unknown>(LAST_IMAGE_DIRECTORY_KEY)
    if (typeof lastDirectory === 'string' && lastDirectory) return lastDirectory
  } catch {
    // Store access should never block the native file dialog.
  }

  try {
    return await pictureDir()
  } catch {
    return undefined
  }
}

export async function pickImagePath() {
  if (!isTauri()) return null
  const defaultPath = await imageDefaultPath()
  const options = {
    multiple: false as const,
    directory: false as const,
    title: '选择图片',
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  }
  let selected: string | string[] | null

  try {
    selected = await open({ ...options, defaultPath })
  } catch (error) {
    if (!defaultPath) throw error
    selected = await open(options)
  }

  if (typeof selected !== 'string') return null
  try {
    const store = await load(STORE_PATH)
    await store.set(LAST_IMAGE_DIRECTORY_KEY, await dirname(selected))
    await store.save()
  } catch {
    // The selected image can still be opened if remembering its directory fails.
  }
  return selected
}

async function lightroomXmpDefaultPath() {
  try {
    const store = await load(STORE_PATH)
    const lastSelectedPath = await store.get<unknown>(LAST_LIGHTROOM_XMP_PATH_KEY)
    if (typeof lastSelectedPath === 'string' && lastSelectedPath) return lastSelectedPath
  } catch {
    // Store access should never block the native file dialog.
  }

  try {
    return await join(await configDir(), 'Adobe', 'CameraRaw', 'Settings')
  } catch {
    return undefined
  }
}

export async function pickLightroomXmpPath() {
  if (!isTauri()) return null

  const options = {
    multiple: false as const,
    directory: false as const,
    title: '选择 Lightroom XMP 预设',
    filters: [{ name: 'Lightroom XMP 预设', extensions: ['xmp'] }],
  }
  const defaultPath = await lightroomXmpDefaultPath()
  let selected: string | string[] | null

  try {
    selected = await open({ ...options, defaultPath })
  } catch (error) {
    if (!defaultPath) throw error
    selected = await open(options)
  }

  if (typeof selected !== 'string') return null
  try {
    const store = await load(STORE_PATH)
    await store.set(LAST_LIGHTROOM_XMP_PATH_KEY, await dirname(selected))
    await store.save()
  } catch {
    // The selected preset can still be imported if remembering the path fails.
  }
  return selected
}

export async function readNativeFile(path: string) {
  return new Uint8Array(await invoke<number[]>('read_binary_file', { path }))
}

export async function saveJpegNative(bytes: Uint8Array, defaultName: string, title = '导出调色效果图') {
  if (!isTauri()) {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'image/jpeg' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = defaultName
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return defaultName
  }
  const path = await save({
    title,
    defaultPath: defaultName,
    filters: [{ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }],
  })
  if (!path) return null
  await invoke('write_binary_file', { path, data: Array.from(bytes) })
  return path
}

export async function loadModelSettings(): Promise<ModelSettings> {
  if (!isTauri()) {
    const current = localStorage.getItem(MODEL_SETTINGS_KEY)
    if (current) return normalizeModelSettings(JSON.parse(current))
    const legacy = localStorage.getItem(LEGACY_MODEL_KEY)
    const migrated = normalizeModelSettings(legacy ? JSON.parse(legacy) : DEFAULT_MODEL_SETTINGS)
    localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify(migrated))
    return migrated
  }
  const store = await load(STORE_PATH)
  const current = await store.get<unknown>(MODEL_SETTINGS_KEY)
  if (current) return normalizeModelSettings(current)
  const legacy = await store.get<unknown>(LEGACY_MODEL_KEY)
  const migrated = normalizeModelSettings(legacy || DEFAULT_MODEL_SETTINGS)
  await store.set(MODEL_SETTINGS_KEY, migrated)
  await store.save()
  return migrated
}

export async function persistModelSettings(settings: ModelSettings) {
  if (!isTauri()) {
    localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify(settings))
    return
  }
  const store = await load(STORE_PATH)
  await store.set(MODEL_SETTINGS_KEY, settings)
  await store.save()
}

export async function saveProviderApiKey(providerId: string, apiKey: string) {
  if (!isTauri()) {
    browserApiKeys.set(providerId, apiKey)
    return
  }
  await invoke('save_api_key', { providerId, apiKey })
}

export async function removeProviderApiKey(providerId: string) {
  if (!isTauri()) {
    browserApiKeys.delete(providerId)
    return
  }
  await invoke('delete_api_key', { providerId })
}

export async function hasProviderApiKey(providerId: string) {
  if (!isTauri()) return Boolean(browserApiKeys.get(providerId))
  return invoke<boolean>('has_api_key', { providerId })
}

export async function testModelConnection(provider: ModelProvider) {
  if (!isTauri()) throw new Error('模型请求需要在 Windows 客户端中运行。')
  return invoke<string>('test_model_connection', { config: providerRuntimeConfig(provider) })
}

export async function analyzeWithModel(
  config: VisionRuntimeConfig,
  sourceDataUrl: string,
  referenceDataUrl: string,
  analysisContext: string,
) {
  if (!isTauri()) throw new Error('模型请求需要在 Windows 客户端中运行。')
  return invoke<ModelColorParameters>('analyze_with_model', {
    request: { config: visionRuntimeConfig(config), sourceDataUrl, referenceDataUrl, analysisContext },
  })
}

export async function refineMatchWithModel(
  config: VisionRuntimeConfig,
  sourceDataUrl: string,
  referenceDataUrl: string,
  resultDataUrl: string,
  analysisContext: string,
) {
  if (!isTauri()) throw new Error('模型请求需要在 Windows 客户端中运行。')
  return invoke<ModelColorParameters>('refine_match_with_model', {
    request: { config: visionRuntimeConfig(config), sourceDataUrl, referenceDataUrl, resultDataUrl, analysisContext },
  })
}

export async function suggestColorWorkflows(
  config: VisionRuntimeConfig,
  sourceDataUrl: string,
  stylePrompt = '',
) {
  if (!isTauri()) throw new Error('AI 调色分析需要在 Windows 客户端中运行。')
  return invoke<ColorWorkflowSuggestion[]>('suggest_color_workflows', {
    request: { config: visionRuntimeConfig(config), sourceDataUrl, stylePrompt },
  })
}

export async function optimizeColorPrompt(
  config: VisionRuntimeConfig,
  stylePrompt: string,
  sourceDataUrl?: string,
) {
  if (!isTauri()) throw new Error('提示词优化需要在 Windows 客户端中运行。')
  return invoke<string>('optimize_color_prompt', {
    request: { config: visionRuntimeConfig(config), stylePrompt, sourceDataUrl },
  })
}

export async function generateColoredImage(
  config: ImageGenerationRuntimeConfig,
  sourceDataUrl: string,
  workflow: ColorWorkflowSuggestion,
  customInstruction = '',
  imageOptions: ImageGenerationRequestOptions = {},
) {
  if (!isTauri()) throw new Error('图生图调色需要在 Windows 客户端中运行。')
  return invoke<GeneratedImageResult>('generate_colored_image', {
    request: {
      config: imageRuntimeConfig(config),
      sourceDataUrl,
      workflow,
      customInstruction,
      imageOptions,
    },
  })
}

function providerRuntimeConfig(provider: ModelProvider) {
  return {
    providerId: provider.id,
    baseUrl: provider.baseUrl.trim(),
    model: '',
    apiType: provider.apiType,
    timeoutSeconds: 30,
    imageModel: '',
    imageTimeoutSeconds: 30,
  }
}

function visionRuntimeConfig(config: VisionRuntimeConfig) {
  return {
    providerId: config.providerId,
    baseUrl: config.baseUrl.trim(),
    model: config.model.trim(),
    apiType: config.apiType,
    timeoutSeconds: config.timeoutSeconds,
    imageModel: '',
    imageTimeoutSeconds: config.timeoutSeconds,
  }
}

function imageRuntimeConfig(config: ImageGenerationRuntimeConfig) {
  return {
    providerId: config.providerId,
    baseUrl: config.baseUrl.trim(),
    model: '',
    apiType: config.apiType,
    timeoutSeconds: config.timeoutSeconds,
    imageModel: config.model.trim(),
    imageTimeoutSeconds: config.timeoutSeconds,
  }
}

