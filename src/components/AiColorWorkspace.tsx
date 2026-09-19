import {
  Check, CloudUpload, ImageIcon, LoaderCircle, LockKeyhole, Save, X,
  MonitorCog, RotateCcw, Send, SlidersHorizontal, Sparkles, WandSparkles,
} from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  afterLayerStyle, CompareDivider, CompareModeControls, CompareSlider, previewFrameClass,
  type CompareMode,
} from './CompareModeControls'
import { FineTunePanels } from './FineTunePanels'
import { ImageDrop } from './ImageDrop'
import { mergeGradeWithFineTune } from '../lib/aiColor'
import { processImageData } from '../lib/colorEngine'
import { exportGradedImage } from '../lib/exportImage'
import { parseCubeLut, validateCubeFile, type CubeLut3D } from '../lib/cubeLut'
import { createDefaultAdjustments } from '../lib/defaults'
import { applyFineTuneModuleVisibility, type FineTuneModuleVisibility } from '../lib/fineTuneVisibility'
import { GpuPreviewRenderer } from '../lib/gpuPreview'
import { parseLightroomXmp, serializeLightroomXmp, sanitizeXmpPresetName, validateXmpFile, type LightroomXmpPreset } from '../lib/lightroomXmp'
import { AssetLibraryPanel } from './AssetLibraryPanel'
import {
  generateColoredImage, importLibraryAssetBytes, optimizeColorPrompt, readLibraryAssetText, saveJpegNative, suggestColorWorkflows,
  type LibraryAsset,
} from '../lib/desktop'
import {
  canvasToBlob, drawImageDataToCanvas, imageToDataUrl, imageToImageData,
  imageToViewportImageData, isViewportMeasured, loadImageDataUrl, type LoadedImage,
} from '../lib/files'
import { useElementSize } from '../lib/useElementSize'
import {
  type Adjustments, type AiColorMethod, type AiGradeParameters,
  type ColorWorkflowSuggestion, type ImageGenerationRequestOptions, type ImageGenerationRuntimeConfig, type VisionRuntimeConfig,
} from '../lib/types'

interface AiColorWorkspaceProps {
  source: LoadedImage | null
  sourceData: ImageData | null
  enabled: boolean
  visionConfig: VisionRuntimeConfig | null
  imageConfig: ImageGenerationRuntimeConfig | null
  visionApiKeyPresent: boolean
  imageApiKeyPresent: boolean
  onFile: (file: File) => void
  onPick?: () => void
  onClear: () => void
  onOpenSettings: () => void
  onPrivacyAccepted: (kind: 'vision' | 'image') => Promise<void>
  notify: (message: string, kind?: 'ok' | 'error') => void
  onExportStateChange: (state: { canExport: boolean; exporting: boolean }) => void
}

type PreviewEngine = 'initializing' | 'gpu' | 'error'

export interface AiColorWorkspaceHandle {
  exportResult: () => void
}

const parameterLabels: Array<[keyof AiGradeParameters, string]> = [
  ['exposure', '曝光'], ['contrast', '对比'], ['highlights', '高光'], ['shadows', '阴影'],
  ['whites', '白色'], ['blacks', '黑色'], ['temperature', '色温'], ['tint', '色调'], ['vibrance', '自然饱和'], ['saturation', '饱和'],
  ['fade', '褪色'], ['grain', '颗粒'],
]

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
}

function toGradeParameters(adjustments: Adjustments): AiGradeParameters {
  return {
    exposure: adjustments.exposure, contrast: adjustments.contrast, highlights: adjustments.highlights,
    shadows: adjustments.shadows, whites: adjustments.whites, blacks: adjustments.blacks,
    temperature: adjustments.temperature, tint: adjustments.tint, vibrance: adjustments.vibrance,
    saturation: adjustments.saturation, fade: adjustments.fade, grain: adjustments.grain,
  }
}

export const AiColorWorkspace = forwardRef<AiColorWorkspaceHandle, AiColorWorkspaceProps>(function AiColorWorkspace({
  source, sourceData, enabled, visionConfig, imageConfig, visionApiKeyPresent, imageApiKeyPresent, onFile, onPick, onClear,
  onOpenSettings, onPrivacyAccepted, notify, onExportStateChange,
}, ref) {
  const [method, setMethod] = useState<AiColorMethod>('local-parameters')
  const [rightPanel, setRightPanel] = useState<'recipe' | 'adjust'>('recipe')
  const [workflows, setWorkflows] = useState<ColorWorkflowSuggestion[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [importedPreset, setImportedPreset] = useState<LightroomXmpPreset | null>(null)
  const [cubeLut, setCubeLut] = useState<CubeLut3D | null>(null)
  const [activeXmpPath, setActiveXmpPath] = useState<string | null>(null)
  const [activeCubePath, setActiveCubePath] = useState<string | null>(null)
  const [xmpAssets, setXmpAssets] = useState<LibraryAsset[]>([])
  const [savePresetOpen, setSavePresetOpen] = useState(false)
  const [savePresetName, setSavePresetName] = useState('')
  const [savePresetFolder, setSavePresetFolder] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)
  const [intensity, setIntensity] = useState(100)
  const [fineTuneAdjustments, setFineTuneAdjustments] = useState<Adjustments>(createDefaultAdjustments)
  const [fineTuneVisibility, setFineTuneVisibility] = useState<FineTuneModuleVisibility>({})
  const [compare, setCompare] = useState(50)
  const [compareMode, setCompareMode] = useState<CompareMode>('wipe')
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [generationBusy, setGenerationBusy] = useState(false)
  const [previewEngine, setPreviewEngine] = useState<PreviewEngine>('initializing')
  const [exporting, setExporting] = useState(false)
  const [outputKind, setOutputKind] = useState<'none' | 'local' | 'generated'>('none')
  const [generatedImage, setGeneratedImage] = useState<LoadedImage | null>(null)
  const [generatedSourceData, setGeneratedSourceData] = useState<ImageData | null>(null)
  const [revisedPrompt, setRevisedPrompt] = useState('')
  const [customInstruction, setCustomInstruction] = useState('')
  const [imageRequestOptions, setImageRequestOptions] = useState<ImageGenerationRequestOptions>({})
  const [stylePrompt, setStylePrompt] = useState('')
  const [promptBusy, setPromptBusy] = useState(false)
  const originalCanvas = useRef<HTMLCanvasElement>(null)
  const gpuResultCanvas = useRef<HTMLCanvasElement>(null)
  const gpuPreviewRenderer = useRef<GpuPreviewRenderer | null>(null)
  const previewFrame = useRef<number | null>(null)
  const pendingGpuPreview = useRef<{ adjustments: Adjustments } | null>(null)
  const generatedRef = useRef<LoadedImage | null>(null)
  const gradePreviewFrameRef = useRef<HTMLDivElement>(null)
  generatedRef.current = generatedImage
  const selected = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedId) || null,
    [selectedId, workflows],
  )
  const importedRecipe = useMemo<ColorWorkflowSuggestion | null>(() => importedPreset ? ({
    id: `xmp-${importedPreset.fileName}`,
    title: importedPreset.name,
    description: `Lightroom XMP · ${importedPreset.mappedFields.length} 类参数`,
    rationale: '预设参数已转换为本地调色控制。',
    generationPrompt: '',
    parameters: toGradeParameters(importedPreset.adjustments),
  }) : null, [importedPreset])
  const activeRecipe = importedRecipe || selected
  const isManualLocal = Boolean(sourceData) && !activeRecipe && method === 'local-parameters'
  const effectiveLocalAdjustments = useMemo(
    () => importedPreset
      ? fineTuneAdjustments
      : selected
        ? mergeGradeWithFineTune(selected.parameters, intensity, fineTuneAdjustments)
        : fineTuneAdjustments,
    [fineTuneAdjustments, importedPreset, intensity, selected],
  )
  const visibleFineTuneAdjustments = useMemo(
    () => applyFineTuneModuleVisibility(fineTuneAdjustments, fineTuneVisibility),
    [fineTuneAdjustments, fineTuneVisibility],
  )
  const visibleLocalAdjustments = useMemo(
    () => applyFineTuneModuleVisibility(effectiveLocalAdjustments, fineTuneVisibility),
    [effectiveLocalAdjustments, fineTuneVisibility],
  )

  const gradeFrameSize = useElementSize(gradePreviewFrameRef, Boolean(source))
  const [stableGradeFrame, setStableGradeFrame] = useState(gradeFrameSize)
  /** 是否已经拿到过一次真实尺寸（见下：首次测量立即提交，此后才做 80ms 抖动抑制）。 */
  const gradeFrameMeasuredRef = useRef(false)
  useEffect(() => {
    // 首次真实测量立即提交：进页面时再等一个 80ms 防抖窗口只会把照片首帧整体推后一个周期，
    // 而此前的 {0,0} 本来也没有可比较的尺寸。抖动抑制只对「已有尺寸之后再变化」有意义。
    if (!gradeFrameMeasuredRef.current && isViewportMeasured(gradeFrameSize.width, gradeFrameSize.height)) {
      gradeFrameMeasuredRef.current = true
      setStableGradeFrame(gradeFrameSize)
      return
    }
    const timer = window.setTimeout(() => setStableGradeFrame(gradeFrameSize), 80)
    return () => window.clearTimeout(timer)
  }, [gradeFrameSize.width, gradeFrameSize.height])
  /**
   * 预览框必须先完成测量才产出派生数据（阈值与 computeViewportPreviewSize 一致）。
   * 尺寸未测量时它必然走 1920px 回退分支，对原图同步 drawImage + getImageData，
   * 而这一帧随后会被真实尺寸的结果替换——白冻一次主线程。
   */
  const frameMeasured = isViewportMeasured(stableGradeFrame.width, stableGradeFrame.height)
  const gradePreviewData = useMemo(() => {
    if (!source || !frameMeasured) return null
    return imageToViewportImageData(source.element, stableGradeFrame.width, stableGradeFrame.height)
  }, [frameMeasured, source, stableGradeFrame.width, stableGradeFrame.height])
  /** Viewport-matched AI-generated AFTER when in image-generation mode. */
  const generatedPreviewData = useMemo(() => {
    if (!generatedImage || !frameMeasured) return null
    return imageToViewportImageData(generatedImage.element, stableGradeFrame.width, stableGradeFrame.height)
  }, [frameMeasured, generatedImage, stableGradeFrame.width, stableGradeFrame.height])

  useEffect(() => {
    if (gradePreviewData && originalCanvas.current) {
      drawImageDataToCanvas(originalCanvas.current, gradePreviewData)
    }
    // sourceData 必须入依赖：BEFORE canvas 由 `sourceData` 门禁挂载，它比派生数据晚一帧到位，
    // 缺这一项时晚挂载的 canvas 不会被补画。
  }, [gradePreviewData, sourceData])

  useEffect(() => {
    setImageRequestOptions({})
  }, [imageConfig?.apiType, imageConfig?.id])

  useEffect(() => {
    setWorkflows([])
    setSelectedId('')
    setRevisedPrompt('')
    setFineTuneAdjustments(importedPreset?.adjustments || createDefaultAdjustments())
    setFineTuneVisibility({})
    setGeneratedSourceData(null)
    if (generatedRef.current) URL.revokeObjectURL(generatedRef.current.url)
    setGeneratedImage(null)
    // New photo: local-parameter path starts as manual grading; image models wait for a recipe.
    setOutputKind(method === 'local-parameters' || importedPreset ? 'local' : 'none')
  }, [source?.url])

  useEffect(() => () => {
    if (generatedRef.current) URL.revokeObjectURL(generatedRef.current.url)
  }, [])

  useEffect(() => {
    if (!sourceData) return
    if (importedPreset || method === 'local-parameters') {
      setOutputKind((current) => (current === 'generated' ? current : 'local'))
    }
  }, [importedPreset, method, sourceData])

  const saveAdjustments = useMemo(() => outputKind === 'generated' ? fineTuneAdjustments : effectiveLocalAdjustments, [effectiveLocalAdjustments, fineTuneAdjustments, outputKind])
  const saveSourceLabel = outputKind === 'generated'
    ? '生成图的精细调整'
    : importedPreset
      ? 'XMP 预设的精细调整'
      : activeRecipe
        ? 'AI 配方与精细调整'
        : '精细调整'
  const saveParameterGroups = useMemo(() => [
    { title: '\u57fa\u7840\u8c03\u8272', values: [
      ['\u66dd\u5149', saveAdjustments.exposure], ['\u5bf9\u6bd4\u5ea6', saveAdjustments.contrast], ['\u9ad8\u5149', saveAdjustments.highlights],
      ['\u9634\u5f71', saveAdjustments.shadows], ['\u767d\u8272', saveAdjustments.whites], ['\u9ed1\u8272', saveAdjustments.blacks],
      ['\u8272\u6e29', saveAdjustments.temperature], ['\u8272\u8c03', saveAdjustments.tint], ['\u81ea\u7136\u9971\u548c\u5ea6', saveAdjustments.vibrance], ['\u9971\u548c\u5ea6', saveAdjustments.saturation],
    ] },
    { title: '\u7ec6\u8282\u4e0e\u8d28\u611f', values: [
      ['\u7eb9\u7406', saveAdjustments.texture], ['\u6e05\u6670\u5ea6', saveAdjustments.clarity], ['\u53bb\u673a\u80e7', saveAdjustments.dehaze],
      ['\u9510\u5316', saveAdjustments.sharpen], ['\u660e\u4eae\u5ea6\u964d\u566a', saveAdjustments.luminanceNoiseReduction], ['\u989c\u8272\u964d\u566a', saveAdjustments.colorNoiseReduction],
      ['\u6697\u89d2', saveAdjustments.vignette], ['\u892a\u8272', saveAdjustments.fade], ['\u9897\u7c92', saveAdjustments.grain],
    ] },
  ] as Array<{ title: string; values: Array<[string, number]> }>, [saveAdjustments])
  const xmpFolders = useMemo(() => {
    const folders = new Set<string>([''])
    for (const asset of xmpAssets) {
      if (!asset.folder) continue
      const parts = asset.folder.split('/')
      for (let index = 1; index <= parts.length; index += 1) folders.add(parts.slice(0, index).join('/'))
    }
    return [...folders].sort((left, right) => left.localeCompare(right, 'zh'))
  }, [xmpAssets])

  const openSavePreset = () => {
    if (!sourceData && !hasPreviewResult) return notify('\u8bf7\u5148\u8f7d\u5165\u7167\u7247\u5e76\u5b8c\u6210\u8c03\u8272', 'error')
    const fallbackName = outputKind === 'generated' ? '\u0041\u0049 \u8c03\u8272\u914d\u65b9' : importedPreset?.name ? `${importedPreset.name} \u7cbe\u4fee` : activeRecipe?.title || '\u7cbe\u7ec6\u8c03\u6574\u9884\u8bbe'
    setSavePresetName(fallbackName)
    setSavePresetFolder(activeXmpPath?.includes('/') ? activeXmpPath.slice(0, activeXmpPath.lastIndexOf('/')) : '')
    setSavePresetOpen(true)
  }

  const savePreset = async () => {
    const name = sanitizeXmpPresetName(savePresetName)
    if (!savePresetName.trim()) return notify('\u8bf7\u8f93\u5165\u9884\u8bbe\u540d\u79f0', 'error')
    setSavingPreset(true)
    try {
      const text = serializeLightroomXmp(saveAdjustments, name)
      const relativePath = savePresetFolder ? `${savePresetFolder}/${name}.xmp` : `${name}.xmp`
      const asset = await importLibraryAssetBytes('xmp', relativePath, text)
      setSavePresetOpen(false)
      setActiveXmpPath(asset.relativePath)
      setXmpAssets((current) => [...current.filter((item) => item.relativePath !== asset.relativePath), asset])
      notify(`\u5df2\u4fdd\u5b58\u65b0\u9884\u8bbe\u201c${asset.name}\u201d`)
    } catch (error) {
      notify(errorMessage(error, '\u4fdd\u5b58\u9884\u8bbe\u5931\u8d25'), 'error')
    } finally {
      setSavingPreset(false)
    }
  }

  const renderSource = outputKind === 'generated' ? generatedPreviewData : gradePreviewData
  const renderAdjustments = outputKind === 'generated' ? visibleFineTuneAdjustments : visibleLocalAdjustments
  // Local parameter path always previews once a photo is loaded, even without a recipe.
  const hasPreviewResult = Boolean(renderSource) && (
    outputKind === 'generated'
    || outputKind === 'local'
    || (method === 'local-parameters' && Boolean(sourceData))
  )

  const paintCpuPreview = (sourceImage: ImageData, adjustments: Adjustments) => {
    const canvas = gpuResultCanvas.current
    if (!canvas) return
    drawImageDataToCanvas(canvas, processImageData(sourceImage, adjustments, null, cubeLut))
  }

  useEffect(() => {
    if (!hasPreviewResult || !renderSource || !gpuResultCanvas.current) return

    setPreviewEngine('initializing')
    let renderer: GpuPreviewRenderer | null = null
    let initializationFrame: number | null = null
    let disposed = false
    const canvas = gpuResultCanvas.current
    const sourceImage = renderSource
    const initialAdjustments = renderAdjustments
    const initialLut = cubeLut

    const fallbackToCpu = (error: unknown) => {
      console.error('WebGL2 AI color preview failed; falling back to CPU.', error)
      renderer?.dispose()
      renderer = null
      gpuPreviewRenderer.current = null
      if (!disposed) {
        paintCpuPreview(sourceImage, initialAdjustments)
        setPreviewEngine('error')
      }
    }

    try {
      renderer = new GpuPreviewRenderer(canvas)
      renderer.setSource(sourceImage)
      renderer.setCubeLut(initialLut)
      initializationFrame = window.requestAnimationFrame(() => {
        initializationFrame = null
        if (disposed || !renderer) return
        try {
          renderer.render(initialAdjustments, null)
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
  }, [hasPreviewResult, renderSource, cubeLut])

  useEffect(() => {
    pendingGpuPreview.current = { adjustments: renderAdjustments }
    if (!hasPreviewResult || previewFrame.current !== null) return

    previewFrame.current = window.requestAnimationFrame(() => {
      previewFrame.current = null
      const pending = pendingGpuPreview.current
      if (!pending || !renderSource) return

      const renderer = gpuPreviewRenderer.current
      if (renderer && previewEngine === 'gpu') {
        try {
          renderer.setCubeLut(cubeLut)
          renderer.render(pending.adjustments, null)
          return
        } catch (error) {
          console.error('WebGL2 AI color preview render failed; falling back to CPU.', error)
          renderer.dispose()
          if (gpuPreviewRenderer.current === renderer) gpuPreviewRenderer.current = null
          pendingGpuPreview.current = null
          // Prefer a correct CPU frame (with LUT) over a black WebGL frame.
          paintCpuPreview(renderSource, pending.adjustments)
          setPreviewEngine('error')
          return
        }
      }

      // CPU path: GPU unavailable, still recovering, or just failed above.
      if (previewEngine === 'error' || !gpuPreviewRenderer.current) {
        paintCpuPreview(renderSource, pending.adjustments)
      }
    })
  }, [hasPreviewResult, previewEngine, renderAdjustments, renderSource, cubeLut])

  const validateModelReady = (needsImageModel = false) => {
    if (!source) { notify('请先选择一张照片', 'error'); return false }
    if (!enabled) { notify('请先在模型设置中启用模型能力', 'error'); return false }
    if (!visionConfig?.model.trim()) { notify('请先选择并配置当前视觉模型', 'error'); return false }
    if (!visionApiKeyPresent) { notify(`请先保存“${visionConfig.providerName}”的 API Key`, 'error'); return false }
    if (needsImageModel && !imageConfig?.model.trim()) { notify('请先选择并配置当前图像生成模型', 'error'); return false }
    if (needsImageModel && !imageApiKeyPresent) { notify(`请先保存“${imageConfig?.providerName || '图像模型供应商'}”的 API Key`, 'error'); return false }
    return true
  }

  const acceptVisionPrivacy = async () => {
    if (!visionConfig) return null
    if (visionConfig.privacyAccepted) return visionConfig
    const message = `AI 调色分析会将目标照片一张最长边不超过 ${visionConfig.maxImageSide}px 的重编码缩略图，以及你输入的风格描述发送至：\n${visionConfig.baseUrl}\n\n不会发送原始文件、本地路径或 EXIF。是否继续？`
    if (!window.confirm(message)) return null
    await onPrivacyAccepted('vision')
    return { ...visionConfig, privacyAccepted: true }
  }

  const acceptImagePrivacy = async () => {
    if (!imageConfig) return null
    if (imageConfig.privacyAccepted) return imageConfig
    const message = imageConfig.apiType === 'images-generations'
      ? `当前供应商使用 /images/generations，只会将调色方案、参数和补充要求发送至：\n${imageConfig.baseUrl}\n\n不会向该端点上传原图。该端点会重新生成图片，无法保证人物、构图、文字和局部细节与原图一致。是否继续？`
      : `图生图调色会将最长边不超过 ${imageConfig.maxImageSide}px 的重编码图片发送至：\n${imageConfig.baseUrl}\n\n图像模型可能改变局部细节。请勿上传无权处理或高度敏感的图片。是否继续？`
    if (!window.confirm(message)) return null
    await onPrivacyAccepted('image')
    return { ...imageConfig, privacyAccepted: true }
  }

  const optimizeStylePrompt = async () => {
    if (!stylePrompt.trim()) return notify('请先输入想要的调色风格', 'error')
    if (!validateModelReady() || !source) return
    setPromptBusy(true)
    try {
      const config = await acceptVisionPrivacy()
      if (!config) return
      const sourceDataUrl = imageToDataUrl(source.element, config.maxImageSide)
      const optimized = await optimizeColorPrompt(
        config,
        stylePrompt.trim(),
        sourceDataUrl,
      )
      setStylePrompt(optimized)
      notify('已将提示语优化为可执行的摄影调色描述')
    } catch (error) {
      notify(errorMessage(error, '提示词优化失败'), 'error')
    } finally {
      setPromptBusy(false)
    }
  }

  const applyXmpText = async (text: string, fileName: string, libraryRelativePath?: string) => {
    validateXmpFile({ name: fileName, size: new TextEncoder().encode(text).length })
    const preset = parseLightroomXmp(text, fileName)
    setImportedPreset(preset)
    setActiveXmpPath(libraryRelativePath || fileName)
    setSelectedId('')
    setMethod('local-parameters')
    setFineTuneAdjustments(preset.adjustments)
    setFineTuneVisibility({})
    setOutputKind(sourceData ? 'local' : 'none')
    setGeneratedSourceData(null)
    setRevisedPrompt('')
    setRightPanel('recipe')
    const suffix = preset.unsupportedFields.length
      ? `；${preset.unsupportedFields.length} 类参数暂未应用`
      : ''
    notify(`已应用“${preset.name}”，映射 ${preset.mappedFields.length} 类参数${suffix}`)
  }

  const applyCubeText = async (text: string, fileName: string, libraryRelativePath?: string) => {
    validateCubeFile({ name: fileName, size: new TextEncoder().encode(text).length })
    const lut = parseCubeLut(text, fileName)
    setCubeLut(lut)
    setActiveCubePath(libraryRelativePath || fileName)
    setFineTuneAdjustments((current) => ({
      ...current,
      lutAmount: current.lutAmount > 0 ? current.lutAmount : 100,
    }))
    if (sourceData && method === 'local-parameters') setOutputKind('local')
    notify(`已应用 CUBE「${lut.title}」· ${lut.size}³ · sRGB 三线性（L2）`)
  }

  const applyLibraryXmp = async (asset: LibraryAsset) => {
    const text = await readLibraryAssetText('xmp', asset.relativePath)
    await applyXmpText(text, asset.fileName, asset.relativePath)
  }

  const applyLibraryCube = async (asset: LibraryAsset) => {
    const text = await readLibraryAssetText('cube', asset.relativePath)
    await applyCubeText(text, asset.fileName, asset.relativePath)
  }

  const clearCubeLut = () => {
    setCubeLut(null)
    setActiveCubePath(null)
    notify('已移除 CUBE LUT')
  }

  const clearXmpPreset = () => {
    setImportedPreset(null)
    setActiveXmpPath(null)
    setFineTuneAdjustments(createDefaultAdjustments())
    setFineTuneVisibility({})
    if (sourceData && method === 'local-parameters') setOutputKind('local')
    notify('已清除 XMP 预设')
  }

  const analyze = async () => {
    if (!validateModelReady() || !source) return
    setAnalysisBusy(true)
    try {
      const config = await acceptVisionPrivacy()
      if (!config) return
      const sourceDataUrl = imageToDataUrl(source.element, config.maxImageSide)
      const next = await suggestColorWorkflows(
        config,
        sourceDataUrl,
        stylePrompt.trim(),
      )
      setWorkflows(next)
      setSelectedId('')
      setImportedPreset(null)
      setActiveXmpPath(null)
      // Keep current manual params until the user picks a recipe (that action overwrites them).
      setGeneratedSourceData(null)
      if (generatedRef.current) URL.revokeObjectURL(generatedRef.current.url)
      setGeneratedImage(null)
      setOutputKind(method === 'local-parameters' ? 'local' : 'none')
      setRightPanel('recipe')
      notify('已生成 3 个调色方案；选择任一配方会覆盖当前手动参数')
    } catch (error) {
      notify(errorMessage(error, 'AI 调色分析失败'), 'error')
    } finally {
      setAnalysisBusy(false)
    }
  }
  const chooseMethod = (next: AiColorMethod) => {
    setImportedPreset(null)
    setActiveXmpPath(null)
    setMethod(next)
    setCompare(50)
    setRevisedPrompt('')
    setFineTuneAdjustments((current) => ({
      ...createDefaultAdjustments(),
      lutAmount: current.lutAmount,
    }))
    setFineTuneVisibility({})
    if (next === 'local-parameters' && sourceData) {
      setOutputKind('local')
      return
    }
    setOutputKind('none')
  }

  const chooseWorkflow = (workflow: ColorWorkflowSuggestion) => {
    setImportedPreset(null)
    setActiveXmpPath(null)
    setSelectedId(workflow.id)
    // Selecting an AI recipe overwrites the current manual baseline (fine-tune starts from zero deltas).
    setFineTuneAdjustments(createDefaultAdjustments())
    setFineTuneVisibility({})
    setRevisedPrompt('')
    if (method === 'local-parameters' && sourceData) {
      setOutputKind('local')
      notify(`已应用「${workflow.title}」，手动参数已按该配方覆盖`)
      return
    }
    setOutputKind('none')
  }

  const generateImage = async () => {
    if (!selected) return notify('请先选择一个调色方案', 'error')
    if (!validateModelReady(true) || !source) return
    setGenerationBusy(true)
    try {
      const config = await acceptImagePrivacy()
      if (!config) return
      const sourceDataUrl = config.apiType === 'images-generations'
        ? ''
        : imageToDataUrl(source.element, config.maxImageSide, .92)
      const result = await generateColoredImage(config, sourceDataUrl, selected, customInstruction.trim(), imageRequestOptions)
      const loaded = await loadImageDataUrl(result.imageDataUrl, `${source.name.replace(/\.[^.]+$/, '')}-ai-color.jpg`)
      if (generatedRef.current) URL.revokeObjectURL(generatedRef.current.url)
      setGeneratedImage(loaded)
      setGeneratedSourceData(imageToImageData(loaded.element, 1800))
      setFineTuneAdjustments(createDefaultAdjustments())
      setFineTuneVisibility({})
      setRevisedPrompt(result.revisedPrompt || '')
      setOutputKind('generated')
      setCompare(50)
      notify(config.apiType === 'images-generations'
        ? '图像模型已完成纯文本生图；该结果不是原图编辑，请检查构图和内容'
        : '图像模型已完成调色，请检查人物和细节一致性')
    } catch (error) {
      notify(errorMessage(error, '图生图调色失败'), 'error')
    } finally {
      setGenerationBusy(false)
    }
  }

  const exportResult = async () => {
    if (!source || !sourceData) return notify('请先选择一张照片', 'error')
    if (outputKind === 'generated' && !generatedImage) return notify('请先生成调色结果', 'error')
    if (outputKind !== 'generated' && method === 'image-generation' && !activeRecipe) {
      return notify('图生图模式请先选择配方并生成结果，或切换到参数调色进行手动调整', 'error')
    }
    setExporting(true)
    try {
      const exportSource = outputKind === 'generated' && generatedImage
        ? generatedImage.element
        : source.element
      const exportAdjustments = outputKind === 'generated' ? visibleFineTuneAdjustments : visibleLocalAdjustments
      // Full native resolution; GPU first (Lightroom-like), CPU fallback. No 3000px cap.
      const result = await exportGradedImage(exportSource, exportAdjustments, {
        cubeLut,
        quality: 0.92,
      })
      const suffix = outputKind === 'generated'
        ? 'ai-image-color'
        : importedPreset
          ? 'lightroom-xmp'
          : activeRecipe
            ? 'ai-local-color'
            : 'manual-color'
      const defaultName = `${source.name.replace(/\.[^.]+$/, '')}-${suffix}.jpg`
      const saved = await saveJpegNative(result.bytes, defaultName, '导出 AI 调色效果图')
      if (saved) {
        notify(`调色结果已导出 · ${result.width}×${result.height} · ${result.engine.toUpperCase()}`)
      }
    } catch (error) {
      notify(errorMessage(error, '导出 AI 调色结果失败'), 'error')
    } finally {
      setExporting(false)
    }
  }

  useImperativeHandle(ref, () => ({
    exportResult: () => void exportResult(),
  }))

  useEffect(() => {
    const canExport = Boolean(source && sourceData) && (
      outputKind === 'generated'
      || outputKind === 'local'
      || method === 'local-parameters'
    )
    onExportStateChange({ canExport, exporting })
  }, [exporting, method, onExportStateChange, outputKind, source, sourceData])

  const analysisButtonLabel = stylePrompt.trim()
    ? '根据风格提示生成配方'
    : '分析照片并生成调色方案'

  return (
    <>
    <main className="workspace-layout ai-grade-workspace">
      <aside className="workspace-rail workspace-rail--left grade-steps left-console">
        <header className="left-console__head">
          <div className="rail-heading">
            <div><h2>AI 调色</h2></div>
            <span className={`status-dot ${activeRecipe || importedPreset ? 'is-ready' : ''}`}>
              {!source ? '待载入' : activeRecipe || importedPreset ? '已应用' : '待调色'}
            </span>
          </div>
          {/* 首步「照片」已去掉：进入工作区时照片就已自动选中，那一步永远是「已完成」，不携带信息。 */}
          <ol className="rail-progress" aria-label="调色准备进度">
            <li className={importedPreset || method ? 'is-done' : 'is-current'}><i>1</i><span>方式</span></li>
            <li className={activeRecipe ? 'is-done' : importedPreset || method ? 'is-current' : ''}><i>2</i><span>配方</span></li>
          </ol>
        </header>

        <div className="left-console__body">
          <section className="rail-card">
            <div className="rail-card__head">
              <div><strong>选择照片</strong></div>
            </div>
            <ImageDrop
              title="载入需要调色的照片" image={source} accent="source"
              onFile={onFile} onPick={onPick} onClear={onClear}
            />
          </section>

          <section className="rail-card">
            <div className="rail-card__head">
              <div><strong>执行方式</strong></div>
            </div>
            <div className="method-toggle" role="radiogroup" aria-label="AI 调色执行方式">
              <button
                type="button"
                role="radio"
                aria-checked={method === 'local-parameters' && !importedPreset}
                className={method === 'local-parameters' && !importedPreset ? 'is-active' : ''}
                onClick={() => chooseMethod('local-parameters')}
              >
                <SlidersHorizontal size={15}/>
                <span><strong>参数调色</strong></span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={method === 'image-generation' && !importedPreset}
                className={`method-toggle__image ${method === 'image-generation' && !importedPreset ? 'is-active' : ''}`}
                onClick={() => chooseMethod('image-generation')}
              >
                <WandSparkles size={15}/>
                <span><strong>图生图</strong></span>
              </button>
            </div>
          </section>

          <div className="asset-stack">
            <AssetLibraryPanel
              kind="xmp"
              title="XMP 预设库"
              className="asset-library--rail-fixed"
              emptyHint="点击 + 导入预设"
              activeRelativePath={activeXmpPath}
              onNotify={notify}
              onSavePreset={openSavePreset}
              onAssetsChange={setXmpAssets}
              onApply={applyLibraryXmp}
              onAssetPathChange={(from, to) => {
                if (!activeXmpPath) return
                if (!to && (activeXmpPath === from || activeXmpPath.startsWith(`${from}/`))) {
                  setActiveXmpPath(null)
                  return
                }
                if (activeXmpPath === from) setActiveXmpPath(to)
                else if (from && activeXmpPath.startsWith(`${from}/`)) {
                  setActiveXmpPath(`${to}${activeXmpPath.slice(from.length)}`)
                }
              }}
            />
            {importedPreset ? (
              <div className="asset-active-bar">
                <span><strong>XMP</strong><small>{importedPreset.name}</small></span>
                <button type="button" className="asset-active-bar__clear" onClick={clearXmpPreset}>清除</button>
              </div>
            ) : null}

            <AssetLibraryPanel
              kind="cube"
              title="CUBE LUT 库"
              className="asset-library--rail-fixed"
              emptyHint="点击 + 导入 LUT"
              activeRelativePath={activeCubePath}
              onNotify={notify}
              onApply={applyLibraryCube}
              onAssetPathChange={(from, to) => {
                if (!activeCubePath) return
                if (!to && (activeCubePath === from || activeCubePath.startsWith(`${from}/`))) {
                  setActiveCubePath(null)
                  return
                }
                if (activeCubePath === from) setActiveCubePath(to)
                else if (from && activeCubePath.startsWith(`${from}/`)) {
                  setActiveCubePath(`${to}${activeCubePath.slice(from.length)}`)
                }
              }}
            />
            {cubeLut ? (
              <div className="cube-lut-controls">
                <div className="asset-active-bar asset-active-bar--cube">
                  <span><strong>LUT</strong><small>{cubeLut.title} · {cubeLut.size}³</small></span>
                  <button type="button" className="asset-active-bar__clear" onClick={clearCubeLut}>移除</button>
                </div>
                <label className="intensity-control">
                  <span>强度 <b>{fineTuneAdjustments.lutAmount}%</b></span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={fineTuneAdjustments.lutAmount}
                    onChange={(event) => {
                      const lutAmount = Number(event.target.value)
                      setFineTuneAdjustments((current) => ({ ...current, lutAmount }))
                      if (sourceData && method === 'local-parameters') setOutputKind('local')
                    }}
                  />
                </label>
              </div>
            ) : null}
          </div>



        </div>

        <footer className="left-console__foot">
          <section className={`grade-privacy-note ${method === 'image-generation' && !importedPreset ? 'is-cloud' : ''}`}>
            {method === 'local-parameters' || importedPreset ? <MonitorCog size={15}/> : <CloudUpload size={15}/>}
            <div>
              <strong>
                {importedPreset
                  ? 'XMP 本地渲染'
                  : method === 'local-parameters'
                    ? '本地完成最终渲染'
                    : '会上传重编码图片'}
              </strong>
            </div>
          </section>
          {!enabled || !visionApiKeyPresent ? (
            <button className="grade-settings-link" onClick={onOpenSettings}><LockKeyhole size={13}/> 模型尚未就绪，前往设置</button>
          ) : null}
        </footer>
      </aside>

      <section className="workspace-stage stage grade-stage">
        <div className="stage__toolbar">
          <div className="stage__title"><strong>{source?.name || '等待选择照片'}</strong></div>
          {compareMode === 'toggle' ? (
            <CompareSlider
              value={compare}
              onChange={setCompare}
              label="前后"
              disabled={!hasPreviewResult}
            />
          ) : (
            <div className="view-switch view-switch--hint"><span>{compareMode === 'wipe' ? '拖动预览分割线' : compareMode === 'side' ? '左右分屏' : '上下分屏'}</span></div>
          )}
          <div className="stage__tools">
            <CompareModeControls mode={compareMode} onChange={setCompareMode} disabled={!sourceData} />
            <button
              className="icon-button"
              title="重置当前预览"
              onClick={() => {
                setFineTuneAdjustments(importedPreset?.adjustments || createDefaultAdjustments())
                setFineTuneVisibility({})
                setSelectedId('')
                setImportedPreset(null)
                setOutputKind(method === 'local-parameters' && sourceData ? 'local' : 'none')
                setRevisedPrompt('')
              }}
            >
              <RotateCcw size={16}/>
            </button>
          </div>
        </div>

        <div
          ref={gradePreviewFrameRef}
          className={previewFrameClass(compareMode, Boolean(sourceData), hasPreviewResult)}
        >
          {sourceData ? (
            <>
              <div className="preview-layer preview-layer--before">
                <canvas ref={originalCanvas} className="preview-canvas preview-canvas--before" />
              </div>
              {hasPreviewResult ? (
                <div className="preview-layer preview-layer--after preview-after" style={afterLayerStyle(compareMode, compare, true)}>
                  <canvas ref={gpuResultCanvas} className="preview-canvas" />
                </div>
              ) : null}
              {hasPreviewResult && compareMode !== 'toggle' ? (
                <CompareDivider
                  mode={compareMode}
                  value={compare}
                  onChange={setCompare}
                  frameRef={gradePreviewFrameRef}
                />
              ) : null}
              {hasPreviewResult && !(compareMode === 'toggle' && compare < 50) ? (
                <span className="preview-label preview-label--after">
                  {outputKind === 'generated'
                    ? 'AI 生成'
                    : activeRecipe
                      ? (importedPreset ? 'XMP' : 'AI 配方')
                      : '手动'}
                </span>
              ) : null}
              {generationBusy ? <span className="rendering-pill"><LoaderCircle className="spin" size={14}/> 图像模型生成中</span> : null}
            </>
          ) : (
            <div className="empty-stage">
              {onPick ? (
                <button className="button button--light empty-stage__cta" type="button" onClick={onPick}>
                  <ImageIcon size={16} /> 选择照片
                </button>
              ) : null}
            </div>
          )}
        </div>

        <div className="stage__footer">
          <span>
            {source
              ? gradePreviewData
                ? `${(renderSource || gradePreviewData).width} × ${(renderSource || gradePreviewData).height} 预览 · 原片 ${source.width}×${source.height}`
                : `原片 ${source.width}×${source.height} · 预览准备中`
              : '未载入图片'}
          </span>
          <span><i className="gpu-dot"/> {outputKind === 'generated' ? imageConfig?.model || '图像模型' : previewEngine === 'gpu' ? 'WebGL2 GPU 色彩引擎' : previewEngine === 'error' ? 'GPU 预览异常' : 'GPU 初始化中'}</span>
          <span>{activeRecipe?.title || (sourceData && method === 'local-parameters' ? '手动调色' : '未选择配方')}</span>
        </div>
      </section>

      <aside className="workspace-rail workspace-rail--right grade-recipes">
        <div className="panel-tabs" role="tablist" aria-label="AI 调色控制面板">
          <button
            type="button"
            role="tab"
            aria-selected={rightPanel === 'recipe'}
            className={rightPanel === 'recipe' ? 'is-active' : ''}
            onClick={() => setRightPanel('recipe')}
          >
            <Sparkles size={15}/><span>AI 调色</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={rightPanel === 'adjust'}
            className={rightPanel === 'adjust' ? 'is-active' : ''}
            onClick={() => setRightPanel('adjust')}
          >
            <SlidersHorizontal size={15}/><span>精细调整</span>
          </button>
        </div>

        <div className="panel-scroll">
          {rightPanel === 'recipe' ? (
            <div className="panel-content grade-recipe-panel">
              <div className="preset-strip recipe-panel-summary">
                <div>
                  <span>调色配方</span>
                  <strong>{selected?.title || importedPreset?.name || (source ? '可直接手动调色' : '选择照片')}</strong>
                </div>
                <span className={`recipe-count ${activeRecipe || isManualLocal ? 'is-ready' : ''}`}>
                  {importedPreset ? 'XMP' : workflows.length ? `${workflows.length}/3` : source ? '手动' : '0/3'}
                </span>
              </div>

              <div className="recipe-status" aria-label="调色工作流状态">
                <span className={source ? 'is-complete' : 'is-current'}><i>01</i>照片</span>
                <b/>
                <span className={activeRecipe ? 'is-complete' : source ? 'is-current' : ''}><i>02</i>配方</span>
                <b/>
                <span className={hasPreviewResult ? 'is-current' : ''}><i>03</i>预览</span>
              </div>

              <section className="rail-card recipe-prompt-card">
                <div className="rail-card__head">
                  <div><strong>风格提示</strong><small>可选 · 不填则自动判断</small></div>
                  <em className="rail-card__meta">{stylePrompt.length}/800</em>
                </div>
                <div className="style-prompt-field">
                  <div className="style-prompt-input">
                    <textarea
                      id="ai-color-style-prompt"
                      value={stylePrompt}
                      maxLength={800}
                      onChange={(event) => setStylePrompt(event.target.value)}
                      placeholder="例如：清透日系，高光偏冷，阴影微青，保留自然肤色"
                      aria-label="调色提示语"
                    />
                    <button
                      type="button"
                      className="prompt-optimize-button"
                      disabled={!source || !stylePrompt.trim() || promptBusy || analysisBusy}
                      title="优化提示词"
                      aria-label="优化提示词"
                      onClick={optimizeStylePrompt}
                    >
                      {promptBusy ? <LoaderCircle className="spin" size={14}/> : <WandSparkles size={14}/>}
                    </button>
                  </div>
                </div>
                <button className="button button--accent button--full recipe-prompt-card__action" disabled={!source || analysisBusy} onClick={analyze}>
                  {analysisBusy ? <LoaderCircle className="spin" size={16}/> : <Sparkles size={16}/>} {analysisButtonLabel}
                </button>
              </section>

              {importedPreset ? (
                <div className="recipe-list">
                  <button className="recipe-card recipe-card--xmp is-active" onClick={() => { setFineTuneAdjustments(importedPreset.adjustments); setFineTuneVisibility({}); if (sourceData) setOutputKind('local') }}>
                    <span className="recipe-card__index">XMP</span>
                    <span className="recipe-card__body"><strong>{importedPreset.name}</strong><small>{importedPreset.mappedFields.length} 类参数已映射</small></span>
                    <span className="recipe-card__check"><Check size={13}/></span>
                  </button>
                </div>
              ) : workflows.length ? (
                <div className="recipe-list">
                  {workflows.map((workflow, index) => (
                    <button key={workflow.id} className={`recipe-card ${selectedId === workflow.id ? 'is-active' : ''}`} onClick={() => chooseWorkflow(workflow)}>
                      <span className="recipe-card__index">0{index + 1}</span>
                      <span className="recipe-card__body"><strong>{workflow.title}</strong><small>{workflow.description}</small></span>
                      <span className="recipe-card__check">{selectedId === workflow.id ? <Check size={13}/> : null}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <section className="recipe-waiting">
                  <div className="recipe-waiting__intro">
                    <span className="recipe-waiting__icon"><SlidersHorizontal size={18}/></span>
                    <div>
                      <strong>{source ? '可不选配方，直接手动调色' : '先选择一张需要调色的照片'}</strong>
                    </div>
                  </div>
                  {source && method === 'local-parameters' ? (
                    <button className="button button--dark button--full" type="button" onClick={() => setRightPanel('adjust')}>
                      <SlidersHorizontal size={15}/> 打开精细调整
                    </button>
                  ) : (
                    <div className="recipe-placeholders" aria-hidden="true">
                      {[
                        ['01', '自然校正', '平衡曝光与肤色'],
                        ['02', '电影氛围', '重塑冷暖与层次'],
                        ['03', '风格表达', '强化色彩识别度'],
                      ].map(([index, title, description]) => (
                        <div className="recipe-card recipe-card--placeholder" key={index}>
                          <span className="recipe-card__index">{index}</span>
                          <span className="recipe-card__body"><strong>{title}</strong><small>{description}</small></span>
                          <span className="recipe-card__check"/>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {activeRecipe ? (
                <section className="recipe-detail">
                  <h3>{activeRecipe.title}</h3>
                  <p>{activeRecipe.rationale}</p>
                  <div className="parameter-cloud">
                    {parameterLabels.map(([key, label]) => {
                      const value = activeRecipe.parameters[key]
                      return <span key={key}><i>{label}</i><b>{value > 0 ? '+' : ''}{Number(value.toFixed(1))}</b></span>
                    })}
                  </div>

                  {importedPreset ? (
                    <div className="xmp-compatibility">
                      <div><span>本地映射</span><strong>{importedPreset.mappedFields.length} 类参数</strong></div>
                      {importedPreset.unsupportedFields.length ? <small>暂未应用：{importedPreset.unsupportedFields.join('、')}</small> : <small>主要调色参数均已映射。</small>}
                    </div>
                  ) : null}

                  {method === 'local-parameters' ? (
                    <div className="recipe-action">
                      {!importedPreset ? (
                        <label className="intensity-control"><span>配方强度 <b>{intensity}%</b></span><input type="range" min="0" max="100" value={intensity} onChange={(event) => setIntensity(Number(event.target.value))}/></label>
                      ) : null}
                    </div>
                  ) : (
                    <div className="recipe-action">
                      <div className="generation-request-options">
                        <div className="generation-request-options__head">
                          <span><strong>本次输出参数</strong><small>留空则由供应商使用默认值</small></span>
                          <button type="button" onClick={() => setImageRequestOptions({})}><RotateCcw size={12}/> 清空</button>
                        </div>
                        <div className="generation-request-options__grid">
                          <label>
                            <span>输出质量</span>
                            <select value={imageRequestOptions.quality || ''} onChange={(event) => setImageRequestOptions((current) => ({ ...current, quality: event.target.value ? event.target.value as ImageGenerationRequestOptions['quality'] : undefined }))}>
                              <option value="">不指定</option>
                              {imageConfig?.apiType === 'images-generations' ? <><option value="standard">standard</option><option value="hd">hd</option></> : <><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></>}
                            </select>
                          </label>
                          <label>
                            <span>输出尺寸</span>
                            <select value={imageRequestOptions.size || ''} onChange={(event) => setImageRequestOptions((current) => ({ ...current, size: event.target.value ? event.target.value as ImageGenerationRequestOptions['size'] : undefined }))}>
                              <option value="">不指定</option>
                              {imageConfig?.apiType === 'images-generations' ? <><option value="256x256">256 × 256</option><option value="512x512">512 × 512</option><option value="1024x1024">1024 × 1024</option><option value="1792x1024">1792 × 1024</option><option value="1024x1792">1024 × 1792</option></> : <><option value="auto">auto</option><option value="1024x1024">1024 × 1024</option><option value="1536x1024">1536 × 1024</option><option value="1024x1536">1024 × 1536</option></>}
                            </select>
                          </label>
                          {imageConfig?.apiType === 'images-generations' ? <>
                            <label>
                              <span>画风</span>
                              <select value={imageRequestOptions.style || ''} onChange={(event) => setImageRequestOptions((current) => ({ ...current, style: event.target.value ? event.target.value as ImageGenerationRequestOptions['style'] : undefined }))}>
                                <option value="">不指定</option><option value="vivid">vivid</option><option value="natural">natural</option>
                              </select>
                            </label>
                            <label>
                              <span>生成数量</span>
                              <input type="number" min="1" max="10" step="1" value={imageRequestOptions.n ?? ''} placeholder="不指定" onChange={(event) => {
                                const value = event.target.value
                                setImageRequestOptions((current) => ({
                                  ...current,
                                  n: value ? Math.min(10, Math.max(1, Math.round(Number(value)))) : undefined,
                                }))
                              }}/>
                            </label>
                            <label>
                              <span>返回方式</span>
                              <select value={imageRequestOptions.responseFormat || ''} onChange={(event) => setImageRequestOptions((current) => ({ ...current, responseFormat: event.target.value ? event.target.value as ImageGenerationRequestOptions['responseFormat'] : undefined }))}>
                                <option value="">不指定</option><option value="url">url</option><option value="b64_json">b64_json</option>
                              </select>
                            </label>
                          </> : null}
                        </div>
                      </div>
                      <label className="generation-instruction"><span>补充要求（可选）</span><textarea value={customInstruction} maxLength={500} onChange={(event) => setCustomInstruction(event.target.value)} placeholder="例如：保留自然肤色，降低高光暖色，不要增加颗粒"/></label>
                      <button className="button button--accent button--full" disabled={generationBusy} onClick={generateImage}>
                        {generationBusy ? <LoaderCircle className="spin" size={16}/> : <Send size={16}/>} {imageConfig?.apiType === 'images-generations' ? '通过提示词生成新图' : '通过图像模型生成调色图'}
                      </button>
                      <p><CloudUpload size={12}/> {imageConfig?.apiType === 'images-generations' ? '不上传原图，会重新生成内容。' : '会上传重编码图片，可能改变细节。'}</p>
                    </div>
                  )}

                  {revisedPrompt ? <details className="revised-prompt"><summary>查看模型修订提示</summary><p>{revisedPrompt}</p></details> : null}
                </section>
              ) : null}
            </div>
          ) : (
            <div className="panel-content">
              <div className="preset-strip">
                <div>
                  <span>当前基线</span>
                  <strong>{activeRecipe?.title || (source ? '手动调色' : '等待载入照片')}</strong>
                </div>
                <button
                  type="button"
                  title="重置精细调整"
                  onClick={() => {
                    setFineTuneAdjustments(importedPreset?.adjustments || createDefaultAdjustments())
                    setFineTuneVisibility({})
                  }}
                >
                  <RotateCcw size={14}/>
                </button>
              </div>
              <div className="fine-tune-intro">
                <p>
                  {outputKind === 'generated'
                    ? '在生成图之上追加本地精修，参数为 0 时不改变结果。'
                    : importedPreset
                      ? 'XMP 参数已转换为本地控制，可直接微调。'
                      : activeRecipe
                        ? '以配方为基线微调，参数为增量值，0 表示保留配方效果。'
                        : '未选配方时，此处参数即为最终调色结果。'}
                </p>
              </div>
              <FineTunePanels
                adjustments={fineTuneAdjustments}
                moduleVisibility={fineTuneVisibility}
                setModuleVisibility={setFineTuneVisibility}
                setAdjustments={(value) => {
                  setFineTuneAdjustments(value)
                  if (sourceData && method === 'local-parameters') {
                    setOutputKind((current) => (current === 'generated' ? current : 'local'))
                  }
                }}
              />
            </div>
          )}
        </div>

        <div className="grade-recipes__footer">
          <div>
            <span>当前执行方式</span>
            <strong>
              {importedPreset
                ? 'Lightroom XMP · 本地渲染'
                : method === 'local-parameters'
                  ? (activeRecipe ? 'AI 参数 · 本地渲染' : '手动参数 · 本地渲染')
                  : 'AI 图像模型 · 云端生成'}
            </strong>
          </div>
          <span className={`execution-state ${hasPreviewResult ? 'is-ready' : ''}`}>
            <i/>
            {hasPreviewResult
              ? (activeRecipe ? '可导出' : '手动调色中')
              : '等待照片'}
          </span>
        </div>
      </aside>
    </main>
    {savePresetOpen ? (
      <div className="preset-save-dialog__backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingPreset) setSavePresetOpen(false) }}>
        <section className="preset-save-dialog" role="dialog" aria-modal="true" aria-labelledby="preset-save-title">
          <div className="preset-save-dialog__head">
            <div><span>{'\u0041\u0049 \u8c03\u8272'}</span><h2 id="preset-save-title">{'\u4fdd\u5b58\u4e3a\u65b0\u9884\u8bbe'}</h2></div>
            <button type="button" className="icon-button" title={'\u5173\u95ed'} aria-label={'\u5173\u95ed'} disabled={savingPreset} onClick={() => setSavePresetOpen(false)}><X size={16}/></button>
          </div>
          <div className="preset-save-dialog__body">
            <label className="preset-save-dialog__field"><span>{'\u9884\u8bbe\u540d\u79f0'}</span><input autoFocus value={savePresetName} maxLength={80} onChange={(event) => setSavePresetName(event.target.value)} /></label>
            <label className="preset-save-dialog__field"><span>{'\u4fdd\u5b58\u4f4d\u7f6e'}</span><select value={savePresetFolder} onChange={(event) => setSavePresetFolder(event.target.value)}>{xmpFolders.map((folder) => <option key={folder} value={folder}>{folder || '\u0058\u004d\u0050 \u9884\u8bbe\u5e93\u6839\u76ee\u5f55'}</option>)}</select></label>
            <div className="preset-save-dialog__source"><span>{'\u53c2\u6570\u6765\u6e90'}</span><strong>{saveSourceLabel}</strong></div>
            <div className="preset-save-dialog__parameters"><div className="preset-save-dialog__section-title">{'\u9884\u8bbe\u53c2\u6570'}</div>{saveParameterGroups.map((group) => <div className="preset-save-dialog__group" key={group.title}><span>{group.title}</span><div>{group.values.map(([label, value]) => <small key={label}><b>{label}</b><em>{value}</em></small>)}</div></div>)}</div>
            <p className="preset-save-dialog__hint">{'\u4fdd\u5b58\u4e3a XMP \u540e\u53ef\u5728\u672c\u5e94\u7528\u548c Lightroom \u4e2d\u7ee7\u7eed\u4f7f\u7528\u3002'}</p>
          </div>
          <div className="preset-save-dialog__actions"><button type="button" className="button" disabled={savingPreset} onClick={() => setSavePresetOpen(false)}>{'\u53d6\u6d88'}</button><button type="button" className="button button--accent" disabled={savingPreset || !savePresetName.trim()} onClick={() => void savePreset()}>{savingPreset ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>} {'\u4fdd\u5b58'}</button></div>
        </section>
      </div>
    ) : null}
    </>
  )
})
