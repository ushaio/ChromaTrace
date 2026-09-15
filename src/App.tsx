import {
  Aperture, AppWindow, ArrowRight, Check, CircleHelp, CloudCog, Download, FolderKanban, KeyRound,
  LoaderCircle, LockKeyhole, Minus, Moon, Palette, RotateCcw, Save, ScanSearch, Settings2, SlidersHorizontal,
  Sparkles, Square, Sun, Upload, WandSparkles, Wifi, WifiOff, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { AiColorWorkspace, type AiColorWorkspaceHandle } from './components/AiColorWorkspace'
import {
  afterLayerStyle, CompareDivider, CompareModeControls, CompareSlider, previewFrameClass,
  type CompareMode,
} from './components/CompareModeControls'
import { LibrarySettingsPanel } from './components/LibrarySettingsPanel'
import { ModelSettingsWorkspace } from './components/ModelSettingsWorkspace'
import { Control } from './components/Control'
import { Histogram } from './components/Histogram'
import { FineTunePanels } from './components/FineTunePanels'
import { ImageDrop } from './components/ImageDrop'
import {
  analyzeImageData, createMatchProfile, createModelMatchContext, processImageData,
  suggestMatchControls,
} from './lib/colorEngine'
import {
  analyzeWithModel, decodeRawNative, hasProviderApiKey, isRawPath, isTauri, loadModelSettings,
  persistModelSettings, pickImagePath, readNativeFile, refineMatchWithModel, saveJpegNative,
} from './lib/desktop'
import { exportGradedImage } from './lib/exportImage'
import {
  ANALYSIS_MAX_SIDE, canvasToBlob, drawImageDataToCanvas, imageToDataUrl, imageToImageData,
  imageToViewportImageData, loadImageBytes, loadImageFile, type LoadedImage,
} from './lib/files'
import { createDefaultAdjustments, DEFAULT_MODEL_SETTINGS } from './lib/defaults'
import { applyFineTuneModuleVisibility, type FineTuneModuleVisibility } from './lib/fineTuneVisibility'
import { GpuPreviewRenderer } from './lib/gpuPreview'
import { resolveImageModel, resolveVisionModel } from './lib/modelSettings'
import type { Adjustments, ColorStats, MatchProfile, ModelColorParameters, ModelSettings } from './lib/types'
import { useElementSize } from './lib/useElementSize'
import './styles.css'

type Panel = 'match' | 'adjust'
type WorkspaceMode = 'match' | 'grade' | 'settings'
type SettingsSection = 'appearance' | 'library' | 'model'
type ThemeMode = 'light' | 'dark'
type Toast = { message: string; kind: 'ok' | 'error' }
type ImageKind = 'source' | 'reference'
type MatchRenderMode = 'none' | 'local' | 'ai'
type PreviewEngine = 'initializing' | 'gpu' | 'error'

const tabs: Array<{ id: Panel; label: string; icon: typeof Sparkles }> = [
  { id: 'match', label: 'AI 追色', icon: ScanSearch },
  { id: 'adjust', label: '精细调整', icon: SlidersHorizontal },
]


function toHex(stats?: ColorStats | null) {
  if (!stats) return '#2b2d2a'
  return `#${stats.mean.map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || 'image.jpg'
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
}

function imageDataToDataUrl(imageData: ImageData, quality = .9) {
  const canvas = document.createElement('canvas')
  drawImageDataToCanvas(canvas, imageData)
  return canvas.toDataURL('image/jpeg', quality)
}

function App() {
  const [source, setSource] = useState<LoadedImage | null>(null)
  const [reference, setReference] = useState<LoadedImage | null>(null)
  const [sourceData, setSourceData] = useState<ImageData | null>(null)
  const [sourceStats, setSourceStats] = useState<ColorStats | null>(null)
  const [referenceStats, setReferenceStats] = useState<ColorStats | null>(null)
  const [adjustments, setAdjustments] = useState<Adjustments>(createDefaultAdjustments)
  const [fineTuneVisibility, setFineTuneVisibility] = useState<FineTuneModuleVisibility>({})
  const [panel, setPanel] = useState<Panel>('match')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('match')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance')
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => window.localStorage.getItem('chroma-trace-theme') === 'light' ? 'light' : 'dark')
  /** Frameless immersive chrome (true) vs OS native decorations (false). Desktop only. */
  const [integratedWindow, setIntegratedWindow] = useState(
    () => window.localStorage.getItem('chroma-trace-integrated-window') !== 'false',
  )
  const [windowStyleChanging, setWindowStyleChanging] = useState(false)
  const [compare, setCompare] = useState(50)
  const [compareMode, setCompareMode] = useState<CompareMode>('wipe')
  const [previewEngine, setPreviewEngine] = useState<PreviewEngine>('initializing')
  const [exporting, setExporting] = useState(false)
  const [matchRenderMode, setMatchRenderMode] = useState<MatchRenderMode>('none')
  const [modelTask, setModelTask] = useState<'idle' | 'analyze' | 'refine'>('idle')
  const [toast, setToast] = useState<Toast | null>(null)
  const [modelSettings, setModelSettings] = useState<ModelSettings>(DEFAULT_MODEL_SETTINGS)
  const [credentialStatus, setCredentialStatus] = useState<Record<string, boolean>>({})
  const [modelStyle, setModelStyle] = useState('')
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [gradeExportState, setGradeExportState] = useState({ canExport: false, exporting: false })
  const [windowMaximized, setWindowMaximized] = useState(false)
  const originalCanvas = useRef<HTMLCanvasElement>(null)
  const gpuResultCanvas = useRef<HTMLCanvasElement>(null)
  const gpuPreviewRenderer = useRef<GpuPreviewRenderer | null>(null)
  const previewFrame = useRef<number | null>(null)
  const pendingGpuPreview = useRef<{ adjustments: Adjustments; profile: MatchProfile | null } | null>(null)
  const browserSourceInput = useRef<HTMLInputElement>(null)
  const sourceRef = useRef<LoadedImage | null>(null)
  const referenceRef = useRef<LoadedImage | null>(null)
  const workspaceModeRef = useRef<WorkspaceMode>('match')
  const aiColorWorkspaceRef = useRef<AiColorWorkspaceHandle>(null)
  const helpMenuRef = useRef<HTMLDivElement>(null)
  const matchPreviewFrameRef = useRef<HTMLDivElement>(null)

  sourceRef.current = source
  referenceRef.current = reference
  workspaceModeRef.current = workspaceMode

  const matchFrameSize = useElementSize(matchPreviewFrameRef, workspaceMode === 'match' && Boolean(source))
  const [stableMatchFrame, setStableMatchFrame] = useState(matchFrameSize)
  useEffect(() => {
    const timer = window.setTimeout(() => setStableMatchFrame(matchFrameSize), 80)
    return () => window.clearTimeout(timer)
  }, [matchFrameSize.width, matchFrameSize.height])
  /** Viewport-matched pixels for BEFORE/AFTER (not the analysis thumbnail). */
  const matchPreviewData = useMemo(() => {
    if (!source) return null
    return imageToViewportImageData(source.element, stableMatchFrame.width, stableMatchFrame.height)
  }, [source, stableMatchFrame.width, stableMatchFrame.height])

  const profile = useMemo(
    () => sourceStats && referenceStats
      ? createMatchProfile(sourceStats, referenceStats)
      : null,
    [sourceStats, referenceStats],
  )
  const activeVisionModel = useMemo(() => resolveVisionModel(modelSettings), [modelSettings])
  const activeImageModel = useMemo(() => resolveImageModel(modelSettings), [modelSettings])
  const visionApiKeyPresent = activeVisionModel ? Boolean(credentialStatus[activeVisionModel.providerId]) : false
  const imageApiKeyPresent = activeImageModel ? Boolean(credentialStatus[activeImageModel.providerId]) : false
  const activeMatchProfile = matchRenderMode === 'local' ? profile : null
  const visibleAdjustments = useMemo(
    () => applyFineTuneModuleVisibility(adjustments, fineTuneVisibility),
    [adjustments, fineTuneVisibility],
  )
  const hasResult = Boolean(sourceData && matchRenderMode !== 'none')
  const modelBusy = modelTask !== 'idle'
  const matchMethodLabel = matchRenderMode === 'ai'
    ? 'AI 语义配方 · 本地渲染'
    : matchRenderMode === 'local'
      ? '本地统计快速匹配'
      : '等待执行'
  const currentStyleLabel = modelStyle || matchMethodLabel
  const canvasEngineLabel = matchRenderMode === 'ai'
    ? 'AI RECIPE / LOCAL RENDER'
    : matchRenderMode === 'local'
      ? 'LOCAL OKLAB TRANSFER'
      : 'BASIC'
  const notify = useCallback((message: string, kind: Toast['kind'] = 'ok') => {
    setToast({ message, kind })
  }, [])
  const changeIntegratedWindow = useCallback(async (nextIntegrated: boolean) => {
    if (windowStyleChanging || nextIntegrated === integratedWindow) return

    if (!isTauri()) {
      setIntegratedWindow(nextIntegrated)
      window.localStorage.setItem('chroma-trace-integrated-window', nextIntegrated ? 'true' : 'false')
      return
    }

    setWindowStyleChanging(true)
    try {
      const appWindow = getCurrentWindow()
      await appWindow.setDecorations(!nextIntegrated)
      const appliedIntegrated = !(await appWindow.isDecorated())
      if (appliedIntegrated !== nextIntegrated) throw new Error('\u7cfb\u7edf\u672a\u5e94\u7528\u6240\u9009\u7a97\u53e3\u6837\u5f0f')

      setIntegratedWindow(appliedIntegrated)
      window.localStorage.setItem('chroma-trace-integrated-window', appliedIntegrated ? 'true' : 'false')
    } catch (error) {
      notify(errorMessage(error, '\u5207\u6362\u7a97\u53e3\u6837\u5f0f\u5931\u8d25'), 'error')
    } finally {
      setWindowStyleChanging(false)
    }
  }, [integratedWindow, notify, windowStyleChanging])
  const helpContent = workspaceMode === 'match'
    ? {
        eyebrow: 'AI COLOR MATCH',
        title: '如何使用 AI 追色',
        steps: ['选择待调整的原片与色彩参考图。', '优先运行 AI 语义追色；本地快速匹配仅适合场景和光线接近的图片。', '按需进行 AI 二次校正和精细调整，然后从顶栏导出。'],
        note: 'AI 语义追色会区分场景环境与可迁移风格，不使用同图像素对应。',
      }
    : workspaceMode === 'grade'
      ? {
          eyebrow: 'AI COLOR GRADING',
          title: '如何使用 AI 调色',
          steps: ['选择照片，并选择参数调色或图生图路径。', '输入目标风格，生成并选择一个调色配方。', '在右侧切换到精细调整，完成后从顶栏导出。'],
          note: '参数调色的最终像素由本地 Canvas 生成；图生图路径可能改变局部细节。',
        }
      : {
          eyebrow: 'APPLICATION SETTINGS',
          title: '设置使用说明',
          steps: ['在左侧选择需要配置的设置模块。', '进入模型设置，配置服务地址、模型与 API Key。', '保存后运行连接测试，再按需启用模型能力。'],
          note: 'API Key 保存在系统凭据存储中，不会写入前端配置文件。',
        }
  const canExport = workspaceMode === 'match'
    ? Boolean(source && reference && hasResult)
    : workspaceMode === 'grade' && gradeExportState.canExport
  const exportBusy = workspaceMode === 'match' ? exporting : gradeExportState.exporting
  const exportFromTopbar = () => {
    if (workspaceMode === 'match') void exportPreview()
    else if (workspaceMode === 'grade') aiColorWorkspaceRef.current?.exportResult()
  }

  useEffect(() => {
    loadModelSettings()
      .then(async (settings) => {
        setModelSettings(settings)
        const statuses = await Promise.all(settings.providers.map(async (provider) => [provider.id, await hasProviderApiKey(provider.id)] as const))
        setCredentialStatus(Object.fromEntries(statuses))
      })
      .catch((error) => notify(errorMessage(error, '读取模型设置失败'), 'error'))
      .finally(() => setSettingsLoaded(true))
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode
    window.localStorage.setItem('chroma-trace-theme', themeMode)
  }, [themeMode])

  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false
    const savedIntegrated = integratedWindow
    const appWindow = getCurrentWindow()
    // Restore the saved preference and verify the actual OS decoration state.
    void appWindow.setDecorations(!savedIntegrated)
      .then(() => appWindow.isDecorated())
      .then((decorated) => {
        if (cancelled) return
        const appliedIntegrated = !decorated
        if (appliedIntegrated !== savedIntegrated) {
          setIntegratedWindow(appliedIntegrated)
          window.localStorage.setItem('chroma-trace-integrated-window', appliedIntegrated ? 'true' : 'false')
        }
      })
      .catch(async (error) => {
        if (cancelled) return
        try {
          const appliedIntegrated = !(await appWindow.isDecorated())
          if (!cancelled) {
            setIntegratedWindow(appliedIntegrated)
            window.localStorage.setItem('chroma-trace-integrated-window', appliedIntegrated ? 'true' : 'false')
          }
        } catch {
          // Keep the saved value if the host cannot report its decoration state.
        }
        if (!cancelled) notify(errorMessage(error, '\u6062\u590d\u7a97\u53e3\u6837\u5f0f\u5931\u8d25'), 'error')
      })

    return () => { cancelled = true }
    // This synchronizes the persisted preference once when the desktop shell mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    const appWindow = getCurrentWindow()
    let unlisten: (() => void) | undefined
    void appWindow.isMaximized().then(setWindowMaximized).catch(() => undefined)
    void appWindow.onResized(() => {
      void appWindow.isMaximized().then(setWindowMaximized).catch(() => undefined)
    }).then((fn) => { unlisten = fn }).catch(() => undefined)
    return () => unlisten?.()
  }, [])

  const windowControl = async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    if (!isTauri()) return
    const appWindow = getCurrentWindow()
    try {
      if (action === 'minimize') await appWindow.minimize()
      else if (action === 'toggleMaximize') await appWindow.toggleMaximize()
      else await appWindow.close()
    } catch {
      // Window controls are best-effort in constrained hosts.
    }
  }

  useEffect(() => {
    setHelpOpen(false)
  }, [workspaceMode])

  useEffect(() => {
    if (!helpOpen) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!helpMenuRef.current?.contains(event.target as Node)) setHelpOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelpOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [helpOpen])

  useEffect(() => {
    if (workspaceMode !== 'match' || !matchPreviewData || !originalCanvas.current) return
    drawImageDataToCanvas(originalCanvas.current, matchPreviewData)
  }, [workspaceMode, matchPreviewData])

  useEffect(() => {
    if (workspaceMode !== 'match' || !matchPreviewData || !gpuResultCanvas.current) return

    setPreviewEngine('initializing')
    let renderer: GpuPreviewRenderer | null = null
    let initializationFrame: number | null = null
    let disposed = false
    const canvas = gpuResultCanvas.current
    const sourceImage = matchPreviewData
    const initialAdjustments = visibleAdjustments
    const initialProfile = activeMatchProfile

    const paintCpuPreview = () => {
      drawImageDataToCanvas(canvas, processImageData(sourceImage, initialAdjustments, initialProfile))
    }

    const fallbackToCpu = (error: unknown) => {
      console.error('WebGL2 preview failed; falling back to CPU.', error)
      renderer?.dispose()
      renderer = null
      gpuPreviewRenderer.current = null
      if (!disposed) {
        paintCpuPreview()
        setPreviewEngine('error')
      }
    }

    try {
      renderer = new GpuPreviewRenderer(canvas)
      renderer.setSource(sourceImage)
      initializationFrame = window.requestAnimationFrame(() => {
        initializationFrame = null
        if (disposed || !renderer) return
        try {
          renderer.render(initialAdjustments, initialProfile)
          gpuPreviewRenderer.current = renderer
          setPreviewEngine('gpu')
        } catch (error) {
          fallbackToCpu(error)
        }
      })
    } catch (error) {
      fallbackToCpu(error)
    }

    return () => {
      disposed = true
      if (initializationFrame !== null) window.cancelAnimationFrame(initializationFrame)
      if (previewFrame.current !== null) {
        window.cancelAnimationFrame(previewFrame.current)
        previewFrame.current = null
      }
      const activeRenderer = renderer
      renderer = null
      activeRenderer?.dispose()
      if (gpuPreviewRenderer.current === activeRenderer) gpuPreviewRenderer.current = null
      pendingGpuPreview.current = null
    }
  }, [workspaceMode, matchPreviewData])

  useEffect(() => {
    pendingGpuPreview.current = { adjustments: visibleAdjustments, profile: activeMatchProfile }
    if (workspaceMode !== 'match' || !matchPreviewData || previewFrame.current !== null) return

    previewFrame.current = window.requestAnimationFrame(() => {
      previewFrame.current = null
      const pending = pendingGpuPreview.current
      if (!pending) return

      const renderer = gpuPreviewRenderer.current
      if (renderer && previewEngine === 'gpu') {
        try {
          renderer.render(pending.adjustments, pending.profile)
          return
        } catch (error) {
          console.error('WebGL2 preview render failed; falling back to CPU.', error)
          renderer.dispose()
          if (gpuPreviewRenderer.current === renderer) gpuPreviewRenderer.current = null
          pendingGpuPreview.current = null
          setPreviewEngine('error')
        }
      }

      if (previewEngine === 'error' || !gpuPreviewRenderer.current) {
        drawImageDataToCanvas(
          gpuResultCanvas.current!,
          processImageData(matchPreviewData, pending.adjustments, pending.profile),
        )
      }
    })
  }, [workspaceMode, matchPreviewData, visibleAdjustments, activeMatchProfile, previewEngine])

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop' || event.payload.paths.length === 0) return
      const imagePaths = event.payload.paths.filter((path) => /\.(jpe?g|png|webp)$/i.test(path)).slice(0, 2)
      if (imagePaths.length === 0) return notify('请拖入 JPG、PNG 或 WebP 图片', 'error')
      if (!sourceRef.current) {
        void handleNativePath(imagePaths[0], 'source')
        if (imagePaths[1]) void handleNativePath(imagePaths[1], 'reference')
      } else if (!referenceRef.current) {
        void handleNativePath(imagePaths[0], 'reference')
      } else {
        void handleNativePath(imagePaths[0], 'source')
        if (imagePaths[1]) void handleNativePath(imagePaths[1], 'reference')
      }
    }).then((fn) => { unlisten = fn })
    return () => unlisten?.()
  }, [])

  useEffect(() => () => {
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url)
    if (referenceRef.current) URL.revokeObjectURL(referenceRef.current.url)
  }, [])

  const assignImage = (loaded: LoadedImage, kind: ImageKind) => {
    // Stats / match profile use a fixed analysis budget; on-screen preview is viewport-sized separately.
    const data = imageToImageData(loaded.element, ANALYSIS_MAX_SIDE)
    setAdjustments(createDefaultAdjustments())
    setFineTuneVisibility({})
    if (kind === 'source') {
      if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url)
      setSource(loaded)
      setSourceData(data)
      setSourceStats(analyzeImageData(data))
      setModelStyle('')
      setMatchRenderMode('none')
      notify('原片已载入，分析完成')
    } else {
      if (referenceRef.current) URL.revokeObjectURL(referenceRef.current.url)
      setReference(loaded)
      setReferenceStats(analyzeImageData(data))
      setModelStyle('')
      setMatchRenderMode('none')
      notify('参考图色彩特征已提取')
    }
  }

  const handleFile = async (file: File, kind: ImageKind) => {
    try { assignImage(await loadImageFile(file), kind) }
    catch (error) { notify(errorMessage(error, '图片载入失败'), 'error') }
  }

  async function handleNativePath(path: string, kind: ImageKind) {
    try {
      const name = fileNameFromPath(path)
      if (isRawPath(path)) {
        notify('正在解码相机 RAW…')
        const jpegBytes = await decodeRawNative(path, 4000)
        assignImage(await loadImageBytes(jpegBytes, name.replace(/\.[^.]+$/, '') + '.jpg', path, { fromRaw: true }), kind)
        notify(kind === 'source' ? 'RAW 原片已解码为 sRGB 预览' : 'RAW 参考图已解码为 sRGB 预览')
        return
      }
      const bytes = await readNativeFile(path)
      assignImage(await loadImageBytes(bytes, name, path), kind)
    } catch (error) { notify(errorMessage(error, '本地图片读取失败'), 'error') }
  }

  const pickNativeImage = async (kind: ImageKind) => {
    try {
      const path = await pickImagePath()
      if (path) await handleNativePath(path, kind)
    } catch (error) { notify(errorMessage(error, '无法打开文件选择器'), 'error') }
  }

  const setAdjustment = (key: keyof Adjustments, value: number) => {
    setAdjustments((current) => ({ ...current, [key]: value }))
  }

  const applyModelRecipe = (result: ModelColorParameters) => {
    const { styleDescription, ...modelParameters } = result
    setAdjustments({
      ...createDefaultAdjustments(),
      ...modelParameters,
      toneMatchStrength: 0,
      colorMatchStrength: 0,
      preserveLuma: 100,
    })
    setFineTuneVisibility({})
    setMatchRenderMode('ai')
    setModelStyle(styleDescription)
  }

  const applyLocalMatch = (showToast = true) => {
    if (!profile) {
      if (showToast) notify('请先载入原片和参考图', 'error')
      return false
    }
    const controls = suggestMatchControls(profile)
    setAdjustments({
      ...createDefaultAdjustments(),
      ...controls,
    })
    setFineTuneVisibility({})
    setMatchRenderMode('local')
    setModelStyle('本地 OKLab 快速匹配')
    if (showToast) notify('本地快速匹配已应用；建议仅用于场景和光线接近的照片')
    return true
  }

  const runLocalMatch = () => { applyLocalMatch() }

  const markModelPrivacyAccepted = async (kind: 'vision' | 'image') => {
    const activeId = kind === 'vision' ? modelSettings.activeVisionModelId : modelSettings.activeImageModelId
    const next: ModelSettings = kind === 'vision'
      ? { ...modelSettings, visionModels: modelSettings.visionModels.map((model) => model.id === activeId ? { ...model, privacyAccepted: true } : model) }
      : { ...modelSettings, imageModels: modelSettings.imageModels.map((model) => model.id === activeId ? { ...model, privacyAccepted: true } : model) }
    setModelSettings(next)
    await persistModelSettings(next)
  }

  const runModelMatch = async () => {
    if (!source || !reference || !profile) return notify('请先载入原片和参考图', 'error')
    if (!modelSettings.enabled) return notify('请先启用视觉模型增强', 'error')
    if (!activeVisionModel?.model.trim()) return notify('请先选择并配置当前视觉模型', 'error')
    if (!visionApiKeyPresent) return notify(`请先保存“${activeVisionModel.providerName}”的 API Key`, 'error')

    let config = activeVisionModel
    if (!config.privacyAccepted) {
      const accepted = window.confirm(`AI 语义追色会将原片与参考图两张不超过 ${config.maxImageSide}px 的缩略图，以及本地提取的非配对色彩统计发送至：\n${config.baseUrl}\n\n不会发送原始文件、本地路径，也不会使用同图像素对应。若之后执行 AI 二次校正，还会额外发送当前结果缩略图。是否继续？`)
      if (!accepted) return
      await markModelPrivacyAccepted('vision')
      config = { ...config, privacyAccepted: true }
    }

    setModelTask('analyze')
    try {
      const sourceDataUrl = imageToDataUrl(source.element, config.maxImageSide)
      const referenceDataUrl = imageToDataUrl(reference.element, config.maxImageSide)
      const localControls = suggestMatchControls(profile)
      const analysisContext = createModelMatchContext(profile, localControls)
      const result = await analyzeWithModel(config, sourceDataUrl, referenceDataUrl, analysisContext)
      applyModelRecipe(result)
      notify('AI 语义追色完成，已生成适配原片的完整调色配方')
    } catch (error) {
      notify(errorMessage(error, 'AI 语义追色失败'), 'error')
    } finally { setModelTask('idle') }
  }

  const runModelRefinement = async () => {
    if (!source || !reference || !sourceData || !profile || matchRenderMode !== 'ai') {
      return notify('请先完成 AI 语义追色', 'error')
    }
    if (!modelSettings.enabled) return notify('请先启用视觉模型增强', 'error')
    if (!activeVisionModel?.model.trim()) return notify('请先选择并配置当前视觉模型', 'error')
    if (!visionApiKeyPresent) return notify(`请先保存“${activeVisionModel.providerName}”的 API Key`, 'error')

    let config = activeVisionModel
    if (!config.privacyAccepted) {
      const accepted = window.confirm(`AI 二次校正会将原片、参考图和当前结果三张缩略图发送至：\n${config.baseUrl}\n\n不会发送原始文件、本地路径，也不会使用同图像素对应。是否继续？`)
      if (!accepted) return
      await markModelPrivacyAccepted('vision')
      config = { ...config, privacyAccepted: true }
    }

    setModelTask('refine')
    try {
      const currentResult = processImageData(sourceData, visibleAdjustments, null)
      const resultDataUrl = imageDataToDataUrl(currentResult)
      const sourceDataUrl = imageToDataUrl(source.element, config.maxImageSide)
      const referenceDataUrl = imageToDataUrl(reference.element, config.maxImageSide)
      const measurementContext = createModelMatchContext(profile, suggestMatchControls(profile))
      const refinementContext = JSON.stringify({
        measurements: JSON.parse(measurementContext),
        currentRecipe: adjustments,
        currentStyle: modelStyle,
      })
      const result = await refineMatchWithModel(
        config,
        sourceDataUrl,
        referenceDataUrl,
        resultDataUrl,
        refinementContext,
      )
      applyModelRecipe(result)
      notify('AI 二次校正完成，完整调色配方已替换')
    } catch (error) {
      notify(errorMessage(error, 'AI 二次校正失败'), 'error')
    } finally { setModelTask('idle') }
  }

  const reset = () => {
    setAdjustments(createDefaultAdjustments())
    setFineTuneVisibility({})
    setModelStyle('')
    setMatchRenderMode('none')
    notify('参数已重置')
  }

  const clearImage = (kind: ImageKind) => {
    setAdjustments(createDefaultAdjustments())
    setFineTuneVisibility({})
    if (kind === 'source') {
      if (source) URL.revokeObjectURL(source.url)
      setSource(null); setSourceData(null); setSourceStats(null)
    } else {
      if (reference) URL.revokeObjectURL(reference.url)
      setReference(null); setReferenceStats(null)
    }
    setModelStyle('')
    setMatchRenderMode('none')
  }

  const exportPreview = async () => {
    if (!source || !reference || matchRenderMode === 'none') return notify('请先完成追色', 'error')
    setExporting(true)
    try {
      // Full native resolution via GPU (CPU fallback). No 2400px preview-style cap.
      const result = await exportGradedImage(source.element, visibleAdjustments, {
        profile: activeMatchProfile,
        quality: 0.92,
      })
      const defaultName = `${source.name.replace(/\.[^.]+$/, '')}-chromatrace.jpg`
      const saved = await saveJpegNative(result.bytes, defaultName)
      if (saved) {
        notify(`JPEG 已导出 · ${result.width}×${result.height} · ${result.engine.toUpperCase()}`)
      }
    } catch (error) { notify(errorMessage(error, '导出失败'), 'error') }
    finally { setExporting(false) }
  }


  const pickSourceFromStage = () => {
    if (isTauri()) void pickNativeImage('source')
    else browserSourceInput.current?.click()
  }

  return (
    <div className={`app-shell ${isTauri() ? 'app-shell--compact' : ''} ${isTauri() && integratedWindow ? 'app-shell--integrated' : ''} ${windowMaximized && integratedWindow ? 'is-maximized' : ''}`}>
      <input
        ref={browserSourceInput}
        className="visually-hidden"
        type="file"
        accept="image/jpeg,image/png,image/webp,.cr2,.cr3,.nef,.nrw,.arw,.raf,.orf,.rw2,.pef,.dng,.raw"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handleFile(file, 'source')
          event.target.value = ''
        }}
      />
      <header className="topbar">
        <div
          className="brand"
          {...(integratedWindow ? {
            'data-tauri-drag-region': true,
            onDoubleClick: () => void windowControl('toggleMaximize'),
          } : {})}
        >
          <span className="brand__mark" {...(integratedWindow ? { 'data-tauri-drag-region': true } : {})}><Aperture size={18} strokeWidth={1.7} /></span>
          <div {...(integratedWindow ? { 'data-tauri-drag-region': true } : {})}>
            <strong {...(integratedWindow ? { 'data-tauri-drag-region': true } : {})}>色迹</strong>
            <span {...(integratedWindow ? { 'data-tauri-drag-region': true } : {})}>CHROMA TRACE</span>
          </div>
        </div>
        <nav className="workspace-nav" aria-label="工作区导航">
          <button className={workspaceMode === 'match' ? 'is-active' : ''} onClick={() => { setWorkspaceMode('match'); setPanel('match') }}><ScanSearch size={15}/> AI 追色</button>
          <button className={workspaceMode === 'grade' ? 'is-active' : ''} onClick={() => setWorkspaceMode('grade')}><Palette size={15}/> AI 调色</button>
          <button className={workspaceMode === 'settings' ? 'is-active' : ''} onClick={() => setWorkspaceMode('settings')}><Settings2 size={15}/> 设置</button>
        </nav>
        <div className="topbar__actions">
          {workspaceMode !== 'settings' ? (
            <>
              <span
                className={`privacy-pill ${modelSettings.enabled ? 'is-cloud' : ''}`}
            {...(integratedWindow ? { 'data-tauri-drag-region': true } : {})}
          >
            {modelSettings.enabled ? <CloudCog size={13}/> : <LockKeyhole size={13}/>} 
            {modelSettings.enabled ? '增强模式会发送缩略图' : '图片仅在本机处理'}
          </span>
          <button
            className="icon-button theme-toggle-button"
            type="button"
            aria-label={themeMode === 'dark' ? '切换到日间模式' : '切换到夜间模式'}
            title={themeMode === 'dark' ? '切换到日间模式' : '切换到夜间模式'}
            onClick={() => setThemeMode((mode) => mode === 'dark' ? 'light' : 'dark')}
          >
            {themeMode === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}
          </button>
          <div className="help-menu" ref={helpMenuRef}>
            <button
              className={`icon-button ${helpOpen ? 'is-active' : ''}`}
              type="button"
              title="使用帮助"
              aria-haspopup="dialog"
              aria-expanded={helpOpen}
              aria-controls="workspace-help"
              onClick={() => setHelpOpen((open) => !open)}
            >
              <CircleHelp size={18}/>
            </button>
            {helpOpen ? (
              <section id="workspace-help" className="help-popover" role="dialog" aria-label={helpContent.title}>
                <div className="help-popover__head">
                  <div><span className="kicker">{helpContent.eyebrow}</span><h2>{helpContent.title}</h2></div>
                  <button type="button" className="icon-button" title="关闭帮助" onClick={() => setHelpOpen(false)}><X size={15}/></button>
                </div>
                <ol>{helpContent.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                <p>{helpContent.note}</p>
              </section>
            ) : null}
              </div>
            </>
          ) : null}
          {workspaceMode !== 'settings' ? (
            <button
              className="button button--light topbar-export"
              type="button"
              disabled={!canExport || exportBusy}
              title={canExport ? '导出效果图' : '完成当前工作流后可导出'}
              onClick={exportFromTopbar}
            >
              {exportBusy ? <LoaderCircle className="spin" size={15}/> : <Download size={15}/>}
              <span>{exportBusy ? '正在导出' : '导出效果图'}</span>
            </button>
          ) : null}
          {isTauri() && integratedWindow ? (
            <div className="window-controls" role="group" aria-label="窗口控制">
              <button type="button" className="window-control" title="最小化" aria-label="最小化" onClick={() => void windowControl('minimize')}>
                <Minus size={14} strokeWidth={2.2} />
              </button>
              <button type="button" className="window-control" title={windowMaximized ? '向下还原' : '最大化'} aria-label={windowMaximized ? '向下还原' : '最大化'} onClick={() => void windowControl('toggleMaximize')}>
                {windowMaximized ? <span className="window-control__restore" aria-hidden="true" /> : <Square size={12} strokeWidth={2.2} />}
              </button>
              <button type="button" className="window-control window-control--close" title="关闭" aria-label="关闭" onClick={() => void windowControl('close')}>
                <X size={14} strokeWidth={2.2} />
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {workspaceMode === 'grade' ? (
        <AiColorWorkspace
          ref={aiColorWorkspaceRef}
          source={source}
          sourceData={sourceData}
          enabled={modelSettings.enabled}
          visionConfig={activeVisionModel}
          imageConfig={activeImageModel}
          visionApiKeyPresent={visionApiKeyPresent}
          imageApiKeyPresent={imageApiKeyPresent}
          onFile={(file) => void handleFile(file, 'source')}
          onPick={isTauri() ? () => void pickNativeImage('source') : () => browserSourceInput.current?.click()}
          onClear={() => clearImage('source')}
          onOpenSettings={() => { setSettingsSection('model'); setWorkspaceMode('settings') }}
          onPrivacyAccepted={markModelPrivacyAccepted}
          notify={notify}
          onExportStateChange={setGradeExportState}
        />
      ) : workspaceMode === 'settings' ? (
        <main className="settings-workspace">
          <aside className="settings-rail" aria-label="设置导航">
            <header className="settings-rail__head">
              <span className="settings-rail__mark"><Settings2 size={16}/></span>
              <div>
                <span className="kicker">CONTROL ROOM</span>
                <h1>设置</h1>
              </div>
            </header>

            <nav className="settings-nav" aria-label="设置模块">
              <button
                type="button"
                className={settingsSection === 'appearance' ? 'is-active' : ''}
                aria-current={settingsSection === 'appearance' ? 'page' : undefined}
                onClick={() => setSettingsSection('appearance')}
              >
                <span className="settings-nav__index">01</span>
                <span className="settings-nav__icon">{themeMode === 'dark' ? <Moon size={16} /> : <Sun size={16} />}</span>
                <span className="settings-nav__copy">
                  <strong>外观</strong>
                  <small>主题 · 一体式窗口</small>
                </span>
                <em className="settings-nav__chip">{themeMode === 'dark' ? '夜间' : '日间'}</em>
              </button>
              <button
                type="button"
                className={settingsSection === 'library' ? 'is-active' : ''}
                aria-current={settingsSection === 'library' ? 'page' : undefined}
                onClick={() => setSettingsSection('library')}
              >
                <span className="settings-nav__index">02</span>
                <span className="settings-nav__icon"><FolderKanban size={16}/></span>
                <span className="settings-nav__copy">
                  <strong>资料库</strong>
                  <small>XMP · CUBE · 排序</small>
                </span>
                <em className="settings-nav__chip">本地</em>
              </button>
              <button
                type="button"
                className={settingsSection === 'model' ? 'is-active' : ''}
                aria-current={settingsSection === 'model' ? 'page' : undefined}
                onClick={() => setSettingsSection('model')}
              >
                <span className="settings-nav__index">03</span>
                <span className="settings-nav__icon"><CloudCog size={16}/></span>
                <span className="settings-nav__copy">
                  <strong>模型</strong>
                  <small>供应商 · 凭据 · 路由</small>
                </span>
                <em className={`settings-nav__chip ${modelSettings.enabled ? 'is-on' : ''}`}>
                  {modelSettings.enabled ? '启用' : '离线'}
                </em>
              </button>
            </nav>

            <section className="settings-rail__status" aria-label="当前配置摘要">
              <div>
                <span>模型能力</span>
                <strong className={modelSettings.enabled ? 'is-on' : ''}>{modelSettings.enabled ? '已启用' : '已关闭'}</strong>
              </div>
              <div>
                <span>视觉路由</span>
                <strong>{activeVisionModel?.name || '未选择'}</strong>
              </div>
              <div>
                <span>图像路由</span>
                <strong>{activeImageModel?.name || '未选择'}</strong>
              </div>
              <div>
                <span>主题</span>
                <strong>{themeMode === 'dark' ? '夜间模式' : '日间模式'}</strong>
              </div>
            </section>

            <footer className="settings-rail__foot">
              <LockKeyhole size={13}/>
              <span>本地优先 · API Key 存于系统凭据存储</span>
            </footer>
          </aside>

          <div className="settings-main">
            {settingsSection === 'appearance' ? (
              <section className="settings-panel appearance-panel">
                <header className="settings-panel__head">
                  <div>
                    <span className="settings-panel__crumb">设置 / 外观</span>
                    <h2>外观</h2>
                    <p>调整界面主题与桌面窗口样式。这些选项只影响应用外壳与 UI，不会改动预览与导出结果。</p>
                  </div>
                  <div className={`settings-panel__pulse ${themeMode === 'dark' ? 'is-dark' : 'is-light'}`}>
                    {themeMode === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
                    <span>
                      <strong>{themeMode === 'dark' ? '夜间模式' : '日间模式'}</strong>
                      <small>已应用到当前设备</small>
                    </span>
                  </div>
                </header>

                <div className="settings-panel__body">
                  <section className="settings-card appearance-theme-card">
                    <div className="settings-card__head">
                      <div>
                        <span className="kicker">DISPLAY THEME</span>
                        <h3>界面主题</h3>
                      </div>
                    </div>

                    <div className="theme-stage" role="radiogroup" aria-label="界面主题">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={themeMode === 'light'}
                        className={`theme-tile ${themeMode === 'light' ? 'is-active' : ''}`}
                        onClick={() => setThemeMode('light')}
                      >
                        <span className="theme-tile__preview theme-tile__preview--light" aria-hidden="true">
                          <i className="theme-tile__bar"/><i className="theme-tile__side"/><i className="theme-tile__stage"/><i className="theme-tile__rail"/>
                        </span>
                        <span className="theme-tile__meta">
                          <Sun size={15}/>
                          <span><strong>日间</strong><small>明亮中性，适合白天审片</small></span>
                          {themeMode === 'light' ? <Check size={14} className="theme-tile__check"/> : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={themeMode === 'dark'}
                        className={`theme-tile ${themeMode === 'dark' ? 'is-active' : ''}`}
                        onClick={() => setThemeMode('dark')}
                      >
                        <span className="theme-tile__preview theme-tile__preview--dark" aria-hidden="true">
                          <i className="theme-tile__bar"/><i className="theme-tile__side"/><i className="theme-tile__stage"/><i className="theme-tile__rail"/>
                        </span>
                        <span className="theme-tile__meta">
                          <Moon size={15}/>
                          <span><strong>夜间</strong><small>低亮度，适合暗光调色</small></span>
                          {themeMode === 'dark' ? <Check size={14} className="theme-tile__check"/> : null}
                        </span>
                      </button>
                    </div>

                    <p className="settings-card__note">
                      主题偏好会自动保存在本机。切换后立即生效，无需重启应用。
                    </p>
                  </section>

                  {isTauri() ? (
                    <section className="settings-card appearance-window-card">
                      <div className="settings-card__head">
                        <div>
                          <span className="kicker">WINDOW CHROME</span>
                          <h3>一体式窗口</h3>
                        </div>
                      </div>

                      <div className="window-style-stage" role="radiogroup" aria-label="窗口样式">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={integratedWindow}
                          aria-busy={windowStyleChanging}
                          disabled={windowStyleChanging}
                          className={`window-style-tile ${integratedWindow ? 'is-active' : ''}`}
                          onClick={() => void changeIntegratedWindow(true)}
                        >
                          <span className="window-style-tile__preview window-style-tile__preview--integrated" aria-hidden="true">
                            <i className="window-style-tile__chrome"/><i className="window-style-tile__body"/><i className="window-style-tile__btn"/><i className="window-style-tile__btn"/><i className="window-style-tile__btn"/>
                          </span>
                          <span className="window-style-tile__meta">
                            <AppWindow size={15}/>
                            <span><strong>一体式</strong><small>无系统标题栏，顶栏与内容融为一体</small></span>
                            {integratedWindow ? <Check size={14} className="window-style-tile__check"/> : null}
                          </span>
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={!integratedWindow}
                          aria-busy={windowStyleChanging}
                          disabled={windowStyleChanging}
                          className={`window-style-tile ${!integratedWindow ? 'is-active' : ''}`}
                          onClick={() => void changeIntegratedWindow(false)}
                        >
                          <span className="window-style-tile__preview window-style-tile__preview--native" aria-hidden="true">
                            <i className="window-style-tile__os-bar"/><i className="window-style-tile__body"/><i className="window-style-tile__os-btn"/><i className="window-style-tile__os-btn"/><i className="window-style-tile__os-btn"/>
                          </span>
                          <span className="window-style-tile__meta">
                            <Square size={15}/>
                            <span><strong>原生窗口</strong><small>使用系统标题栏与窗口边框</small></span>
                            {!integratedWindow ? <Check size={14} className="window-style-tile__check"/> : null}
                          </span>
                        </button>
                      </div>

                      <p className="settings-card__note">
                        开启一体式后隐藏系统标题栏，使用应用内顶栏与自定义窗口按钮；关闭后恢复系统原生边框。偏好会保存在本机，切换后立即生效。
                      </p>
                    </section>
                  ) : null}
                </div>
              </section>
            ) : settingsSection === 'library' ? (
              <LibrarySettingsPanel notify={notify} />
            ) : (
              <ModelSettingsWorkspace
                settings={modelSettings}
                credentialStatus={credentialStatus}
                settingsLoaded={settingsLoaded}
                onChange={setModelSettings}
                onCredentialStatusChange={(providerId, present) => setCredentialStatus((current) => ({ ...current, [providerId]: present }))}
                notify={notify}
              />
            )}
          </div>
        </main>
      ) : (
      <main className="workspace-layout workspace">
        <aside className="workspace-rail workspace-rail--left input-rail left-console">
          <header className="left-console__head">
            <div className="rail-heading">
              <div><span className="kicker">MATCH / INPUT</span><h2>匹配样本</h2></div>
              <span className={`status-dot ${profile ? 'is-ready' : ''}`}>{profile ? 'READY' : 'WAIT'}</span>
            </div>
            <ol className="rail-progress" aria-label="追色准备进度">
              <li className={source ? 'is-done' : 'is-current'}><i>1</i><span>原片</span></li>
              <li className={reference ? 'is-done' : source ? 'is-current' : ''}><i>2</i><span>参考</span></li>
              <li className={profile ? 'is-done' : source && reference ? 'is-current' : ''}><i>3</i><span>分析</span></li>
            </ol>
          </header>

          <div className="left-console__body">
            <section className="rail-card">
              <div className="rail-card__head">
                <span className="rail-card__index">01</span>
                <div><strong>双图样本</strong><small>原片与参考可不同构图</small></div>
              </div>
              <div className="match-pair">
                <div className="match-pair__slot">
                  <div className="match-pair__label"><span>SOURCE</span><b>{source ? '已载入' : '待选择'}</b></div>
                  <ImageDrop
                    title="选择原片" eyebrow="SOURCE" image={source} accent="source"
                    onFile={(file) => void handleFile(file, 'source')}
                    onPick={isTauri() ? () => void pickNativeImage('source') : undefined}
                    onClear={() => clearImage('source')}
                  />
                </div>
                <div className="match-pair__bridge" aria-hidden="true"><ArrowRight size={14}/></div>
                <div className="match-pair__slot">
                  <div className="match-pair__label match-pair__label--ref"><span>REFERENCE</span><b>{reference ? '已载入' : '待选择'}</b></div>
                  <ImageDrop
                    title="选择参考" eyebrow="REFERENCE" image={reference} accent="reference"
                    onFile={(file) => void handleFile(file, 'reference')}
                    onPick={isTauri() ? () => void pickNativeImage('reference') : undefined}
                    onClear={() => clearImage('reference')}
                  />
                </div>
              </div>
            </section>

            <section className="rail-card">
              <div className="rail-card__head">
                <span className="rail-card__index">02</span>
                <div><strong>样本分析</strong><small>亮度 · 色彩 · 通道关系</small></div>
                <em className="rail-card__meta">{profile ? '2 / 2' : source || reference ? '1 / 2' : '0 / 2'}</em>
              </div>
              <div className="analysis-card analysis-card--compact">
                <Histogram values={referenceStats?.histogram || sourceStats?.histogram} />
                <div className="swatch-row">
                  <div><i style={{ background: toHex(sourceStats) }}/><span>原片均值</span><b>{toHex(sourceStats).toUpperCase()}</b></div>
                  <div><i style={{ background: toHex(referenceStats) }}/><span>目标均值</span><b>{toHex(referenceStats).toUpperCase()}</b></div>
                </div>
              </div>
            </section>
          </div>

          <footer className="left-console__foot">
            <button type="button" className="match-button" disabled={!profile || modelBusy || !modelSettings.enabled} onClick={runModelMatch}>
              {modelTask === 'analyze' ? <LoaderCircle className="spin" size={17}/> : <WandSparkles size={17}/>}
              <span><strong>开始 AI 语义追色</strong><small>双图对比并生成源图适配配方</small></span><ArrowRight size={17}/>
            </button>
          </footer>
        </aside>

        <section className="workspace-stage stage">
          <div className="stage__toolbar">
            <div className="stage__title"><span className="kicker">PREVIEW / 04</span><strong>{source?.name || '等待载入原片'}</strong></div>
            {compareMode === 'toggle' ? (
              <CompareSlider
                value={compare}
                onChange={setCompare}
                label="前后"
                disabled={!hasResult}
              />
            ) : (
              <div className="view-switch view-switch--hint"><span>{compareMode === 'wipe' ? '拖动预览分割线' : compareMode === 'side' ? '左右分屏' : '上下分屏'}</span></div>
            )}
            <div className="stage__tools">
              <CompareModeControls mode={compareMode} onChange={setCompareMode} disabled={!sourceData} />
              <button className="icon-button" title="重置" onClick={reset}><RotateCcw size={16}/></button>
            </div>
          </div>

          <div
            ref={matchPreviewFrameRef}
            className={previewFrameClass(compareMode, Boolean(sourceData), hasResult)}
          >
            {sourceData ? (
              <>
                <div className="preview-layer preview-layer--before">
                  <canvas ref={originalCanvas} className="preview-canvas preview-canvas--before" />
                </div>
                {hasResult ? (
                  <div className="preview-layer preview-layer--after preview-after" style={afterLayerStyle(compareMode, compare, true)}>
                    <canvas ref={gpuResultCanvas} className="preview-canvas" />
                  </div>
                ) : null}
                {hasResult && compareMode !== 'toggle' ? (
                  <CompareDivider
                    mode={compareMode}
                    value={compare}
                    onChange={setCompare}
                    frameRef={matchPreviewFrameRef}
                  />
                ) : null}
                {!(compareMode === 'toggle' && compare >= 50) ? (
                  <span className="preview-label preview-label--before">BEFORE</span>
                ) : null}
                {hasResult && !(compareMode === 'toggle' && compare < 50) ? (
                  <span className="preview-label preview-label--after">AFTER</span>
                ) : null}
              </>
            ) : (
              <div className="empty-stage">
                <button className="button button--light empty-stage__cta" type="button" onClick={pickSourceFromStage}>
                  <Upload size={16} /> 选择原片
                </button>
              </div>
            )}
          </div>

          <div className="stage__footer">
            <span>
              {matchPreviewData && source
                ? `${matchPreviewData.width} × ${matchPreviewData.height} PREVIEW · 原片 ${source.width}×${source.height}`
                : 'NO IMAGE'}
            </span>
            <span><i className="gpu-dot"/> {previewEngine === 'gpu' ? 'WEBGL2 GPU' : previewEngine === 'error' ? 'GPU ERROR' : 'GPU INITIALIZING'} · {canvasEngineLabel}</span>
            <span>WINDOWS · sRGB / 8 BIT</span>
          </div>
        </section>

        <aside className="workspace-rail workspace-rail--right control-rail">
          <div className="panel-tabs" role="tablist">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button key={id} role="tab" aria-selected={panel === id} className={panel === id ? 'is-active' : ''} onClick={() => setPanel(id)}>
                <Icon size={15}/><span>{label}</span>
              </button>
            ))}
          </div>

          <div className="panel-scroll">
            {panel === 'match' ? (
              <div className="panel-content">
                <section className="module">
                  <div className="module__heading">
                    <div><span className="kicker">TRANSFER</span><h3>追色控制</h3></div>
                    <span className="ai-badge">{matchRenderMode === 'ai' ? 'AI' : 'LOCAL'}</span>
                  </div>
                  {matchRenderMode === 'ai' ? (
                    <>
                      <div className="semantic-match-note">
                        <WandSparkles size={16}/>
                        <div>
                          <strong>AI 独立配方正在生效</strong>
                          <span>当前结果未经过本地直方图或 OKLab 跨图迁移。可在“精细调整”中修改完整参数。</span>
                        </div>
                      </div>
                      <Control label="肤色保护" value={adjustments.skinProtect} min={0} max={100} suffix="%" onChange={(v) => setAdjustment('skinProtect', v)} />
                    </>
                  ) : (
                    <>
                      <p className="module__intro">本地快速匹配会迁移两张图片的统计分布，仅建议用于场景、光线和主体占比相近的照片。</p>
                      <Control label="明度迁移强度" value={adjustments.toneMatchStrength} min={0} max={100} suffix="%" onChange={(v) => setAdjustment('toneMatchStrength', v)} />
                      <Control label="颜色迁移强度" value={adjustments.colorMatchStrength} min={0} max={100} suffix="%" onChange={(v) => setAdjustment('colorMatchStrength', v)} />
                      <Control label="保留原片明度" value={adjustments.preserveLuma} min={0} max={100} suffix="%" onChange={(v) => setAdjustment('preserveLuma', v)} />
                      <Control label="肤色保护" value={adjustments.skinProtect} min={0} max={100} suffix="%" onChange={(v) => setAdjustment('skinProtect', v)} />
                    </>
                  )}
                </section>
                <section className="module match-readout">
                  <div className="module__heading"><h3>匹配诊断</h3><span className={hasResult ? 'readout-ok' : ''}>{hasResult ? '已应用' : profile ? '可执行' : '等待样本'}</span></div>
                  <div className="readout-grid">
                    <div><span>亮度偏移</span><b>{profile ? `${((referenceStats!.luma - sourceStats!.luma) * 100).toFixed(1)}%` : '—'}</b></div>
                    <div><span>饱和差异</span><b>{profile ? `${((referenceStats!.saturation - sourceStats!.saturation) * 100).toFixed(1)}%` : '—'}</b></div>
                    <div><span>暖色偏向</span><b>{profile ? (referenceStats!.warmBias > sourceStats!.warmBias ? '增加' : '降低') : '—'}</b></div>
                    <div><span>明度模型</span><b>{matchRenderMode === 'ai' ? 'AI 视觉判断' : profile ? '分位数曲线' : '—'}</b></div>
                    <div><span>色彩模型</span><b>{matchRenderMode === 'ai' ? '语义风格拆分' : profile ? 'OKLab 三分区' : '—'}</b></div>
                    <div><span>当前方法</span><b>{matchMethodLabel}</b></div>
                  </div>
                </section>
                <div className="match-action-row">
                  <button className="button button--dark" disabled={!profile || modelBusy} onClick={runLocalMatch}><Sparkles size={16}/> 本地快速匹配</button>
                  <button className="button button--accent" disabled={!profile || modelBusy || !modelSettings.enabled} onClick={runModelMatch}>
                    {modelTask === 'analyze' ? <LoaderCircle className="spin" size={15}/> : <WandSparkles size={15}/>} AI 语义追色
                  </button>
                  {matchRenderMode === 'ai' ? (
                    <button className="button button--dark button--refine" disabled={modelBusy} onClick={runModelRefinement}>
                      {modelTask === 'refine' ? <LoaderCircle className="spin" size={15}/> : <ScanSearch size={15}/>} AI 二次校正
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {panel === 'adjust' ? (
              <div className="panel-content">
                <div className="preset-strip"><div><span>当前样式</span><strong>{currentStyleLabel}</strong></div><button onClick={reset}><RotateCcw size={14}/></button></div>
                <FineTunePanels
                  adjustments={adjustments}
                  setAdjustments={setAdjustments}
                  moduleVisibility={fineTuneVisibility}
                  setModuleVisibility={setFineTuneVisibility}
                />

              </div>
            ) : null}

          </div>
        </aside>
      </main>
      )}

      {toast ? <div className={`toast toast--${toast.kind}`}>{toast.kind === 'ok' ? <Check size={16}/> : <X size={16}/>}<span>{toast.message}</span></div> : null}
    </div>
  )
}

export default App







