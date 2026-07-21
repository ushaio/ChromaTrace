import {
  Aperture, ArrowRight, Check, CircleHelp, CloudCog, Download, Eye, KeyRound,
  LoaderCircle, LockKeyhole, Moon, Palette, RotateCcw, Save, ScanSearch, Settings2, SlidersHorizontal,
  Sparkles, Sun, Upload, WandSparkles, Wifi, WifiOff, X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { AiColorWorkspace, type AiColorWorkspaceHandle } from './components/AiColorWorkspace'
import { ModelSettingsWorkspace } from './components/ModelSettingsWorkspace'
import { Control } from './components/Control'
import { Histogram } from './components/Histogram'
import { FineTunePanels } from './components/FineTunePanels'
import { ImageDrop } from './components/ImageDrop'
import {
  analyzeImageData, createMatchProfile, createModelMatchContext, processImageData, suggestMatchControls,
} from './lib/colorEngine'
import {
  analyzeWithModel, hasProviderApiKey, isTauri, loadModelSettings, persistModelSettings, pickImagePath,
  readNativeFile, refineMatchWithModel, saveJpegNative,
} from './lib/desktop'
import {
  canvasToBlob, drawImageDataToCanvas, imageToDataUrl, imageToImageData, loadImageBytes,
  loadImageFile, type LoadedImage,
} from './lib/files'
import { createDefaultAdjustments, DEFAULT_MODEL_SETTINGS } from './lib/defaults'
import { GpuPreviewRenderer } from './lib/gpuPreview'
import { resolveImageModel, resolveVisionModel } from './lib/modelSettings'
import type { Adjustments, ColorStats, MatchProfile, ModelColorParameters, ModelSettings } from './lib/types'
import './styles.css'

type Panel = 'match' | 'adjust'
type WorkspaceMode = 'match' | 'grade' | 'settings'
type SettingsSection = 'appearance' | 'model'
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
  const [panel, setPanel] = useState<Panel>('match')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('match')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance')
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => window.localStorage.getItem('chroma-trace-theme') === 'light' ? 'light' : 'dark')
  const [compare, setCompare] = useState(50)
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

  sourceRef.current = source
  referenceRef.current = reference
  workspaceModeRef.current = workspaceMode

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
  const notify = (message: string, kind: Toast['kind'] = 'ok') => setToast({ message, kind })
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
          note: 'API Key 保存在 Windows Credential Manager，不会写入前端配置文件。',
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
    if (workspaceMode !== 'match' || !sourceData || !originalCanvas.current) return
    drawImageDataToCanvas(originalCanvas.current, sourceData)
  }, [workspaceMode, sourceData])

  useEffect(() => {
    if (workspaceMode !== 'match' || !sourceData || !gpuResultCanvas.current) return

    setPreviewEngine('initializing')
    let renderer: GpuPreviewRenderer | null = null
    let initializationFrame: number | null = null
    let disposed = false
    const canvas = gpuResultCanvas.current

    try {
      renderer = new GpuPreviewRenderer(canvas)
      renderer.setSource(sourceData)
      initializationFrame = window.requestAnimationFrame(() => {
        initializationFrame = null
        if (disposed || !renderer) return
        try {
          renderer.render(adjustments, activeMatchProfile)
          gpuPreviewRenderer.current = renderer
          setPreviewEngine('gpu')
        } catch (error) {
          console.error('WebGL2 preview initialization failed.', error)
          renderer.dispose()
          renderer = null
          gpuPreviewRenderer.current = null
          setPreviewEngine('error')
        }
      })
    } catch (error) {
      console.error('WebGL2 preview initialization failed.', error)
      renderer?.dispose()
      renderer = null
      gpuPreviewRenderer.current = null
      setPreviewEngine('error')
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
  }, [workspaceMode, sourceData])

  useEffect(() => {
    pendingGpuPreview.current = { adjustments, profile: activeMatchProfile }
    if (!gpuPreviewRenderer.current || previewFrame.current !== null) return

    previewFrame.current = window.requestAnimationFrame(() => {
      previewFrame.current = null
      const renderer = gpuPreviewRenderer.current
      const pending = pendingGpuPreview.current
      if (!renderer || !pending) return
      try {
        renderer.render(pending.adjustments, pending.profile)
      } catch (error) {
        console.error('WebGL2 preview render failed.', error)
        renderer.dispose()
        if (gpuPreviewRenderer.current === renderer) gpuPreviewRenderer.current = null
        pendingGpuPreview.current = null
        setPreviewEngine('error')
      }
    })
  }, [adjustments, activeMatchProfile, previewEngine])

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
    const data = imageToImageData(loaded.element, 1200)
    setAdjustments(createDefaultAdjustments())
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
      const bytes = await readNativeFile(path)
      assignImage(await loadImageBytes(bytes, fileNameFromPath(path), path), kind)
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
      const currentResult = processImageData(sourceData, adjustments, null)
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
    setModelStyle('')
    setMatchRenderMode('none')
    notify('参数已重置')
  }

  const clearImage = (kind: ImageKind) => {
    setAdjustments(createDefaultAdjustments())
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
      const exportData = imageToImageData(source.element, 2400)
      const processed = processImageData(exportData, adjustments, activeMatchProfile)
      const canvas = document.createElement('canvas')
      drawImageDataToCanvas(canvas, processed)
      const blob = await canvasToBlob(canvas, .94)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const defaultName = `${source.name.replace(/\.[^.]+$/, '')}-chromatrace.jpg`
      const saved = await saveJpegNative(bytes, defaultName)
      if (saved) notify('JPEG 效果图已导出')
    } catch (error) { notify(errorMessage(error, '导出失败'), 'error') }
    finally { setExporting(false) }
  }


  const pickSourceFromStage = () => {
    if (isTauri()) void pickNativeImage('source')
    else browserSourceInput.current?.click()
  }

  return (
    <div className="app-shell">
      <input
        ref={browserSourceInput}
        className="visually-hidden"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handleFile(file, 'source')
          event.target.value = ''
        }}
      />
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark"><Aperture size={20} strokeWidth={1.7} /></span>
          <div><strong>色迹</strong><span>CHROMA TRACE</span></div>
        </div>
        <nav className="workspace-nav" aria-label="工作区导航">
          <button className={workspaceMode === 'match' ? 'is-active' : ''} onClick={() => { setWorkspaceMode('match'); setPanel('match') }}><ScanSearch size={15}/> AI 追色</button>
          <button className={workspaceMode === 'grade' ? 'is-active' : ''} onClick={() => setWorkspaceMode('grade')}><Palette size={15}/> AI 调色</button>
          <button className={workspaceMode === 'settings' ? 'is-active' : ''} onClick={() => setWorkspaceMode('settings')}><Settings2 size={15}/> 设置</button>
        </nav>
        <div className="topbar__actions">
          <span className={`privacy-pill ${modelSettings.enabled ? 'is-cloud' : ''}`}>
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
          <aside className="settings-sidebar">
            <div className="settings-sidebar__heading">
              <span className="kicker">APPLICATION</span>
              <h1>设置</h1>
              <p>集中管理色迹的应用能力与外部服务。</p>
            </div>
            <nav className="settings-nav" aria-label="设置模块">
              <button
                type="button"
                className={settingsSection === 'appearance' ? 'is-active' : ''}
                aria-current={settingsSection === 'appearance' ? 'page' : undefined}
                onClick={() => setSettingsSection('appearance')}
              >
                <span className="settings-nav__icon">{themeMode === 'dark' ? <Moon size={17}/> : <Sun size={17}/>}</span>
                <span><strong>外观</strong><small>夜间模式与界面主题</small></span>
              </button>
              <button
                type="button"
                className={settingsSection === 'model' ? 'is-active' : ''}
                aria-current={settingsSection === 'model' ? 'page' : undefined}
                onClick={() => setSettingsSection('model')}
              >
                <span className="settings-nav__icon"><CloudCog size={17}/></span>
                <span><strong>模型设置</strong><small>供应商、模型与安全凭据</small></span>
              </button>
            </nav>
            <div className="settings-sidebar__footer"><LockKeyhole size={13}/><span>本地优先 · 凭据安全存储</span></div>
          </aside>

          {settingsSection === 'appearance' ? (
            <section className="appearance-settings-workspace settings-module">
              <header className="appearance-settings-hero">
                <span className="settings-breadcrumb">设置 <i>/</i> 外观</span>
                <span className="kicker">APPEARANCE / DISPLAY</span>
                <h2>外观</h2>
                <p>在日间与夜间界面之间切换，主题偏好会自动保存在当前设备。</p>
              </header>
              <div className="appearance-settings-scroll">
                <section className="module appearance-settings-card">
                  <div className="module__heading"><div><span className="kicker">COLOR SCHEME</span><h3>界面主题</h3></div>{themeMode === 'dark' ? <Moon size={17}/> : <Sun size={17}/>}</div>
                  <label className="toggle-row appearance-mode-toggle">
                    <span><strong>夜间模式</strong><small>降低界面亮度，适合暗光环境下调色</small></span>
                    <input type="checkbox" checked={themeMode === 'dark'} onChange={(event) => setThemeMode(event.target.checked ? 'dark' : 'light')} />
                  </label>
                  <div className="theme-choice-grid" role="radiogroup" aria-label="界面主题">
                    <button type="button" role="radio" aria-checked={themeMode === 'light'} className={themeMode === 'light' ? 'is-active' : ''} onClick={() => setThemeMode('light')}>
                      <span className="theme-swatch theme-swatch--light"><i/><i/><i/></span>
                      <span><Sun size={14}/><strong>日间</strong><small>明亮中性</small></span>
                    </button>
                    <button type="button" role="radio" aria-checked={themeMode === 'dark'} className={themeMode === 'dark' ? 'is-active' : ''} onClick={() => setThemeMode('dark')}>
                      <span className="theme-swatch theme-swatch--dark"><i/><i/><i/></span>
                      <span><Moon size={14}/><strong>夜间</strong><small>低亮度专注模式</small></span>
                    </button>
                  </div>
                  <p className="appearance-note">主题切换只影响应用界面，不会改变图片预览、调色计算或导出结果。</p>
                </section>
              </div>
            </section>
          ) : settingsSection === 'model' ? (
            <ModelSettingsWorkspace
              settings={modelSettings}
              credentialStatus={credentialStatus}
              settingsLoaded={settingsLoaded}
              onChange={setModelSettings}
              onCredentialStatusChange={(providerId, present) => setCredentialStatus((current) => ({ ...current, [providerId]: present }))}
              notify={notify}
            />
          ) : null}
        </main>
      ) : (
      <main className="workspace-layout workspace">
        <aside className="workspace-rail workspace-rail--left input-rail">
          <div className="rail-heading">
            <div><span className="kicker">INPUT / 01</span><h2>匹配样本</h2></div>
            <span className={`status-dot ${profile ? 'is-ready' : ''}`}>{profile ? 'READY' : 'WAIT'}</span>
          </div>
          <section className="grade-step match-step">
            <div className="grade-step__head"><span>01</span><div><strong>选择原片</strong><small>JPG · PNG · WebP</small></div></div>
            <ImageDrop
              title="载入需要调色的原片" eyebrow="SOURCE / 原片" image={source} accent="source"
              onFile={(file) => void handleFile(file, 'source')}
              onPick={isTauri() ? () => void pickNativeImage('source') : undefined}
              onClear={() => clearImage('source')}
            />
          </section>

          <div className="direction-mark"><span/><ArrowRight size={16}/><span/></div>

          <section className="grade-step match-step">
            <div className="grade-step__head"><span>02</span><div><strong>选择参考图</strong><small>风格样本 · 无需同图</small></div></div>
            <ImageDrop
              title="载入想要模仿的色彩" eyebrow="REFERENCE / 参考" image={reference} accent="reference"
              onFile={(file) => void handleFile(file, 'reference')}
              onPick={isTauri() ? () => void pickNativeImage('reference') : undefined}
              onClear={() => clearImage('reference')}
            />
          </section>

          <section className="grade-step match-step match-step--analysis">
            <div className="grade-step__head"><span>03</span><div><strong>样本分析</strong><small>亮度 · 色彩 · 通道关系</small></div></div>
            <div className="analysis-card">
              <div className="analysis-card__head"><span>色彩样本分析</span><span>{profile ? '2 / 2' : source || reference ? '1 / 2' : '0 / 2'}</span></div>
              <Histogram values={referenceStats?.histogram || sourceStats?.histogram} />
              <div className="swatch-row">
                <div><i style={{ background: toHex(sourceStats) }}/><span>原片均值</span><b>{toHex(sourceStats).toUpperCase()}</b></div>
                <div><i style={{ background: toHex(referenceStats) }}/><span>目标均值</span><b>{toHex(referenceStats).toUpperCase()}</b></div>
              </div>
            </div>
          </section>
          <button type="button" className="match-button" disabled={!profile || modelBusy || !modelSettings.enabled} onClick={runModelMatch}>
            {modelTask === 'analyze' ? <LoaderCircle className="spin" size={17}/> : <WandSparkles size={17}/>}
            <span><strong>开始 AI 语义追色</strong><small>双图对比并生成源图适配配方</small></span><ArrowRight size={17}/>
          </button>
        </aside>

        <section className="workspace-stage stage">
          <div className="stage__toolbar">
            <div className="stage__title"><span className="kicker">PREVIEW / 04</span><strong>{source?.name || '等待载入原片'}</strong></div>
            <div className="view-switch">
              <span>对比</span>
              <input aria-label="前后效果对比" type="range" min="0" max="100" value={compare} onChange={(e) => setCompare(Number(e.target.value))}/>
              <output>{compare}%</output>
            </div>
            <div className="stage__tools">
              <button className="icon-button" title="重置" onClick={reset}><RotateCcw size={16}/></button>
            </div>
          </div>

          <div className={`preview-frame ${sourceData ? 'has-image' : ''}`}>
            {sourceData ? (
              <>
                <canvas ref={originalCanvas} className="preview-canvas preview-canvas--before" />
                <div className="preview-after" style={{ clipPath: `inset(0 0 0 ${compare}%)` }}>
                  <canvas ref={gpuResultCanvas} className="preview-canvas" />
                </div>
                <div className="compare-line" style={{ left: `${compare}%` }}><span><Eye size={13}/></span></div>
                <span className="preview-label preview-label--before">BEFORE</span>
                <span className="preview-label preview-label--after">AFTER</span>
              </>
            ) : (
              <div className="empty-stage">
                <div className="empty-stage__reticle"><span/><Aperture size={38} strokeWidth={1}/><span/></div>
                <span className="kicker">WINDOWS LOCAL COLOR ENGINE</span>
                <h1>把一种色彩记忆<br/>移植到另一张照片</h1>
                <p>载入原片与参考图，AI 会区分场景环境与可迁移调色风格，生成适配原片的完整参数。本地快速匹配仅作为辅助方案。</p>
                <button className="button button--light" onClick={pickSourceFromStage}><Upload size={16}/> 选择第一张原片</button>
              </div>
            )}
          </div>

          <div className="stage__footer">
            <span>{sourceData ? `${sourceData.width} × ${sourceData.height} PREVIEW` : 'NO IMAGE'}</span>
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
                <FineTunePanels adjustments={adjustments} setAdjustments={setAdjustments} />

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







