import {
  ArrowRight, Check, CloudUpload, Eye, FileUp, ImageIcon, LoaderCircle, LockKeyhole,
  MonitorCog, RotateCcw, Send, SlidersHorizontal, Sparkles, WandSparkles,
} from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { FineTunePanels } from './FineTunePanels'
import { ImageDrop } from './ImageDrop'
import { mergeGradeWithFineTune } from '../lib/aiColor'
import { processImageData } from '../lib/colorEngine'
import { createDefaultAdjustments } from '../lib/defaults'
import { GpuPreviewRenderer } from '../lib/gpuPreview'
import { parseLightroomXmp, validateXmpFile, type LightroomXmpPreset } from '../lib/lightroomXmp'
import {
  generateColoredImage, isTauri, optimizeColorPrompt, pickLightroomXmpPath, readNativeFile, saveJpegNative, suggestColorWorkflows,
} from '../lib/desktop'
import {
  canvasToBlob, drawImageDataToCanvas, imageToDataUrl, imageToImageData,
  loadImageDataUrl, type LoadedImage,
} from '../lib/files'
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
  const [intensity, setIntensity] = useState(100)
  const [fineTuneAdjustments, setFineTuneAdjustments] = useState<Adjustments>(createDefaultAdjustments)
  const [compare, setCompare] = useState(50)
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
  const xmpInputRef = useRef<HTMLInputElement>(null)

  generatedRef.current = generatedImage
  const selected = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedId) || null,
    [selectedId, workflows],
  )
  const importedRecipe = useMemo<ColorWorkflowSuggestion | null>(() => importedPreset ? ({
    id: `xmp-${importedPreset.fileName}`,
    title: importedPreset.name,
    description: `Lightroom XMP · 已映射 ${importedPreset.mappedFields.length} 类参数`,
    rationale: '预设参数已在本地转换为 Chroma Trace 的调色控制。高级参数可在“精细调整”中继续修改。',
    generationPrompt: '',
    parameters: toGradeParameters(importedPreset.adjustments),
  }) : null, [importedPreset])
  const activeRecipe = importedRecipe || selected
  const effectiveLocalAdjustments = useMemo(
    () => importedPreset
      ? fineTuneAdjustments
      : selected
        ? mergeGradeWithFineTune(selected.parameters, intensity, fineTuneAdjustments)
        : fineTuneAdjustments,
    [fineTuneAdjustments, importedPreset, intensity, selected],
  )

  useEffect(() => {
    if (sourceData && originalCanvas.current) drawImageDataToCanvas(originalCanvas.current, sourceData)
  }, [sourceData])

  useEffect(() => {
    setImageRequestOptions({})
  }, [imageConfig?.apiType, imageConfig?.id])

  useEffect(() => {
    setWorkflows([])
    setSelectedId('')
    setOutputKind('none')
    setRevisedPrompt('')
    setFineTuneAdjustments(importedPreset?.adjustments || createDefaultAdjustments())
    setGeneratedSourceData(null)
    if (generatedRef.current) URL.revokeObjectURL(generatedRef.current.url)
    setGeneratedImage(null)
  }, [source?.url])

  useEffect(() => () => {
    if (generatedRef.current) URL.revokeObjectURL(generatedRef.current.url)
  }, [])

  useEffect(() => {
    if (importedPreset && sourceData) setOutputKind('local')
  }, [importedPreset, sourceData])

  const renderSource = outputKind === 'generated' ? generatedSourceData : sourceData
  const renderAdjustments = outputKind === 'local' ? effectiveLocalAdjustments : fineTuneAdjustments
  const hasPreviewResult = outputKind !== 'none'
    && Boolean(renderSource)
    && (outputKind !== 'local' || Boolean(activeRecipe))

  useEffect(() => {
    if (!hasPreviewResult || !renderSource || !gpuResultCanvas.current) return

    setPreviewEngine('initializing')
    let renderer: GpuPreviewRenderer | null = null
    let initializationFrame: number | null = null
    let disposed = false
    const canvas = gpuResultCanvas.current

    try {
      renderer = new GpuPreviewRenderer(canvas)
      renderer.setSource(renderSource)
      initializationFrame = window.requestAnimationFrame(() => {
        initializationFrame = null
        if (disposed || !renderer) return
        try {
          renderer.render(renderAdjustments, null)
          gpuPreviewRenderer.current = renderer
          setPreviewEngine('gpu')
        } catch (error) {
          console.error('WebGL2 AI color preview initialization failed.', error)
          renderer.dispose()
          renderer = null
          gpuPreviewRenderer.current = null
          setPreviewEngine('error')
        }
      })
    } catch (error) {
      console.error('WebGL2 AI color preview initialization failed.', error)
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
  }, [hasPreviewResult, renderSource])

  useEffect(() => {
    pendingGpuPreview.current = { adjustments: renderAdjustments }
    if (!hasPreviewResult || !gpuPreviewRenderer.current || previewFrame.current !== null) return

    previewFrame.current = window.requestAnimationFrame(() => {
      previewFrame.current = null
      const renderer = gpuPreviewRenderer.current
      const pending = pendingGpuPreview.current
      if (!renderer || !pending) return
      try {
        renderer.render(pending.adjustments, null)
      } catch (error) {
        console.error('WebGL2 AI color preview render failed.', error)
        renderer.dispose()
        if (gpuPreviewRenderer.current === renderer) gpuPreviewRenderer.current = null
        pendingGpuPreview.current = null
        setPreviewEngine('error')
      }
    })
  }, [hasPreviewResult, previewEngine, renderAdjustments])

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

  const importXmpPreset = async (file: File) => {
    try {
      validateXmpFile(file)
      const preset = parseLightroomXmp(await file.text(), file.name)
      setImportedPreset(preset)
      setSelectedId('')
      setMethod('local-parameters')
      setFineTuneAdjustments(preset.adjustments)
      setOutputKind(sourceData ? 'local' : 'none')
      setGeneratedSourceData(null)
      setRevisedPrompt('')
      setRightPanel('recipe')
      const suffix = preset.unsupportedFields.length
        ? `；${preset.unsupportedFields.length} 类参数暂未应用`
        : ''
      notify(`已导入“${preset.name}”，映射 ${preset.mappedFields.length} 类参数${suffix}`)
    } catch (error) {
      notify(errorMessage(error, 'XMP 预设导入失败'), 'error')
    } finally {
      if (xmpInputRef.current) xmpInputRef.current.value = ''
    }
  }

  const pickXmpPreset = async () => {
    if (!isTauri()) {
      xmpInputRef.current?.click()
      return
    }

    try {
      const path = await pickLightroomXmpPath()
      if (!path) return
      const bytes = await readNativeFile(path)
      const fileName = path.split(/[\\/]/).pop() || 'lightroom-preset.xmp'
      const file = new File([bytes.slice().buffer], fileName, { type: 'application/rdf+xml' })
      await importXmpPreset(file)
    } catch (error) {
      notify(errorMessage(error, '无法打开 XMP 预设'), 'error')
    }
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
      setOutputKind('none')
      setFineTuneAdjustments(createDefaultAdjustments())
      setGeneratedSourceData(null)
      notify('已生成 3 个针对当前照片的调色方案')
    } catch (error) {
      notify(errorMessage(error, 'AI 调色分析失败'), 'error')
    } finally {
      setAnalysisBusy(false)
    }
  }
  const chooseMethod = (next: AiColorMethod) => {
    setImportedPreset(null)
    setMethod(next)
    setCompare(50)
    setRevisedPrompt('')
    setFineTuneAdjustments(createDefaultAdjustments())
    if (next === 'local-parameters' && selected && sourceData) {
      setOutputKind('local')
      return
    }
    setOutputKind('none')
  }

  const chooseWorkflow = (workflow: ColorWorkflowSuggestion) => {
    setImportedPreset(null)
    setSelectedId(workflow.id)
    setFineTuneAdjustments(createDefaultAdjustments())
    setRevisedPrompt('')
    if (method === 'local-parameters' && sourceData) {
      setOutputKind('local')
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
    if (!source || outputKind === 'none' || !activeRecipe) return notify('请先应用或生成调色结果', 'error')
    setExporting(true)
    try {
      const canvas = document.createElement('canvas')
      if (outputKind === 'generated' && generatedImage) {
        const maxSide = Math.max(generatedImage.element.naturalWidth, generatedImage.element.naturalHeight)
        const exportData = imageToImageData(generatedImage.element, maxSide)
        drawImageDataToCanvas(canvas, processImageData(exportData, fineTuneAdjustments, null))
      } else {
        const exportData = imageToImageData(source.element, 3000)
        drawImageDataToCanvas(canvas, processImageData(exportData, effectiveLocalAdjustments, null))
      }
      const blob = await canvasToBlob(canvas, .94)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const suffix = outputKind === 'generated' ? 'ai-image-color' : importedPreset ? 'lightroom-xmp' : 'ai-local-color'
      const defaultName = `${source.name.replace(/\.[^.]+$/, '')}-${suffix}.jpg`
      const saved = await saveJpegNative(bytes, defaultName, '导出 AI 调色效果图')
      if (saved) notify('AI 调色 JPEG 已导出')
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
    onExportStateChange({
      canExport: Boolean(source && activeRecipe && outputKind !== 'none'),
      exporting,
    })
  }, [activeRecipe, exporting, onExportStateChange, outputKind, source])

  const analysisButtonLabel = stylePrompt.trim()
    ? '根据风格提示生成配方'
    : '分析照片并生成调色方案'

  return (
    <main className="workspace-layout ai-grade-workspace">
      <aside className="workspace-rail workspace-rail--left grade-steps">
        <div className="rail-heading">
          <div><span className="kicker">AI COLOR / WORKFLOW</span><h2>AI 调色</h2></div>
          <span className={`status-dot ${source ? 'is-ready' : ''}`}>{source ? 'READY' : 'STEP 1'}</span>
        </div>

        <section className="grade-step">
          <div className="grade-step__head"><span>01</span><div><strong>选择照片</strong><small>JPG · PNG · WebP</small></div></div>
          <ImageDrop
            title="载入需要调色的照片" eyebrow="SOURCE / 原片" image={source} accent="source"
            onFile={onFile} onPick={onPick} onClear={onClear}
          />
        </section>

        <section className="grade-step">
          <div className="grade-step__head"><span>02</span><div><strong>选择调色方式</strong><small>同一份 AI 配方，两种执行路径</small></div></div>
          <div className="method-stack">
            <button className={`method-card ${method === 'local-parameters' ? 'is-active' : ''}`} onClick={() => chooseMethod('local-parameters')}>
              <span className="method-card__icon"><SlidersHorizontal size={18}/></span>
              <span><strong>AI 参数调色</strong><small>视觉模型给出配方，本地 Canvas 执行</small></span>
              {method === 'local-parameters' ? <Check size={15}/> : <ArrowRight size={15}/>}
            </button>
            <button className={`method-card method-card--image ${method === 'image-generation' ? 'is-active' : ''}`} onClick={() => chooseMethod('image-generation')}>
              <span className="method-card__icon"><WandSparkles size={18}/></span>
              <span><strong>AI 图生图调色</strong><small>选择配方后交给图像编辑或生成模型</small></span>
              {method === 'image-generation' ? <Check size={15}/> : <ArrowRight size={15}/>}
            </button>
            <input
              ref={xmpInputRef}
              type="file"
              accept=".xmp,application/rdf+xml,application/xml,text/xml"
              hidden
              onChange={(event) => { const file = event.target.files?.[0]; if (file) void importXmpPreset(file) }}
            />
            <button className={`method-card method-card--xmp ${importedPreset ? 'is-active' : ''}`} onClick={() => void pickXmpPreset()}>
              <span className="method-card__icon"><FileUp size={18}/></span>
              <span>
                <strong>导入 Lightroom XMP <em className="beta-badge">BETA</em></strong>
                <small>{importedPreset ? `已载入：${importedPreset.name}` : '本地解析预设，转换为可继续编辑的参数'}</small>
              </span>
              {importedPreset ? <Check size={15}/> : <ArrowRight size={15}/>}
            </button>
          </div>
        </section>

        <section className="grade-step grade-guidance">
          <div className="grade-step__head"><span>03</span><div><strong>描述目标风格</strong><small>可选，不填写则由 AI 自动判断</small></div></div>
          <div className="style-prompt-field">
            <div className="style-prompt-field__head">
              <label htmlFor="ai-color-style-prompt">调色提示语</label>
              <small>{stylePrompt.length}/800</small>
            </div>
            <div className="style-prompt-input">
              <textarea
                id="ai-color-style-prompt"
                value={stylePrompt}
                maxLength={800}
                onChange={(event) => setStylePrompt(event.target.value)}
                placeholder="例如：清透日系，降低高光暖色，阴影微微偏青，保留自然肤色与柔和反差"
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
            <small className="style-prompt-hint">AI 会补全为可执行的摄影调色语言</small>
          </div>
        </section>

        <section className="grade-privacy-note">
          {method === 'local-parameters' ? <MonitorCog size={16}/> : <CloudUpload size={16}/>} 
          <div><strong>{method === 'local-parameters' ? '本地完成最终渲染' : '会上传重编码图片'}</strong><span>{method === 'local-parameters' ? '模型只看缩略图并输出参数。' : '请检查生成图中的人物、文字与细节。'}</span></div>
        </section>

        <button className="button button--accent button--full" disabled={!source || analysisBusy} onClick={analyze}>
          {analysisBusy ? <LoaderCircle className="spin" size={16}/> : <Sparkles size={16}/>} {analysisButtonLabel}
        </button>
        {!enabled || !visionApiKeyPresent ? (
          <button className="grade-settings-link" onClick={onOpenSettings}><LockKeyhole size={13}/> 模型尚未就绪，前往设置</button>
        ) : null}
      </aside>

      <section className="workspace-stage stage grade-stage">
        <div className="stage__toolbar">
          <div className="stage__title"><span className="kicker">PREVIEW / 04</span><strong>{source?.name || '等待选择照片'}</strong></div>
          <div className="view-switch">
            <span>对比</span><input aria-label="AI 调色前后对比" type="range" min="0" max="100" value={compare} onChange={(event) => setCompare(Number(event.target.value))}/><output>{compare}%</output>
          </div>
          <div className="stage__tools">
            <button className="icon-button" title="清除当前结果" onClick={() => { setOutputKind('none') }}><RotateCcw size={16}/></button>
          </div>
        </div>

        <div className={`preview-frame ${sourceData ? 'has-image' : ''}`}>
          {sourceData ? (
            <>
              <canvas ref={originalCanvas} className="preview-canvas preview-canvas--before" />
              {hasPreviewResult ? (
                <div className="preview-after" style={{ clipPath: `inset(0 0 0 ${compare}%)` }}>
                  <canvas ref={gpuResultCanvas} className="preview-canvas" />
                </div>
              ) : null}
              {hasPreviewResult ? <div className="compare-line" style={{ left: `${compare}%` }}><span><Eye size={13}/></span></div> : null}
              <span className="preview-label preview-label--before">BEFORE</span>
              <span className="preview-label preview-label--after">{outputKind === 'none' ? 'SELECT RECIPE' : outputKind === 'local' ? 'LOCAL' : 'AI IMAGE'}</span>
              {generationBusy ? <span className="rendering-pill"><LoaderCircle className="spin" size={14}/> 图像模型生成中</span> : null}
            </>
          ) : (
            <div className="empty-stage">
              <div className="empty-stage__reticle"><span/><ImageIcon size={38} strokeWidth={1}/><span/></div>
              <span className="kicker">STEP 01 · SELECT A PHOTOGRAPH</span>
              <h1>先理解画面，<br/>再决定颜色。</h1>
              <p>选择一张照片，视觉模型会给出三套可选调色配方。你可以让本地引擎执行参数，也可以交给图像模型完成调色。</p>
              {onPick ? <button className="button button--light" onClick={onPick}><ImageIcon size={16}/> 选择照片</button> : null}
            </div>
          )}
        </div>

        <div className="stage__footer">
          <span>{sourceData ? `${sourceData.width} × ${sourceData.height} PREVIEW` : 'NO IMAGE'}</span>
          <span><i className="gpu-dot"/> {outputKind === 'generated' ? imageConfig?.model || 'IMAGE MODEL' : previewEngine === 'gpu' ? 'WEBGL2 GPU COLOR ENGINE' : previewEngine === 'error' ? 'GPU PREVIEW ERROR' : 'GPU INITIALIZING'}</span>
          <span>{activeRecipe?.title || 'NO RECIPE SELECTED'}</span>
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
                <div><span>调色配方</span><strong>{selected?.title || '选择调色配方'}</strong></div>
                <span className={`recipe-count ${activeRecipe ? 'is-ready' : ''}`}>{importedPreset ? 'XMP' : `${workflows.length}/3`}</span>
              </div>

              <div className="recipe-status" aria-label="调色工作流状态">
                <span className={source ? 'is-complete' : 'is-current'}><i>01</i>照片</span>
                <b/>
                <span className={workflows.length ? 'is-complete' : source ? 'is-current' : ''}><i>02</i>配方</span>
                <b/>
                <span className={selected ? 'is-current' : ''}><i>03</i>执行</span>
              </div>

              {importedPreset ? (
                <div className="recipe-list">
                  <button className="recipe-card recipe-card--xmp is-active" onClick={() => { setFineTuneAdjustments(importedPreset.adjustments); if (sourceData) setOutputKind('local') }}>
                    <span className="recipe-card__index">XMP</span>
                    <span className="recipe-card__body"><strong>{importedPreset.name}</strong><small>{importedPreset.mappedFields.length} 类参数已映射 · 点击重新应用</small></span>
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
                    <span className="recipe-waiting__icon"><Sparkles size={18}/></span>
                    <div><strong>{source ? '照片已就绪，等待生成配方' : '先选择一张需要调色的照片'}</strong><span>视觉模型会从画面内容、光线和色彩关系出发，给出三种可直接执行的方向。</span></div>
                  </div>
                  <div className="recipe-placeholders" aria-hidden="true">
                    {[
                      ['01', '自然校正', '平衡曝光、白平衡与肤色'],
                      ['02', '电影氛围', '重塑冷暖关系与明暗层次'],
                      ['03', '风格表达', '强化画面的色彩识别度'],
                    ].map(([index, title, description]) => (
                      <div className="recipe-card recipe-card--placeholder" key={index}>
                        <span className="recipe-card__index">{index}</span>
                        <span className="recipe-card__body"><strong>{title}</strong><small>{description}</small></span>
                        <span className="recipe-card__check"/>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeRecipe ? (
                <section className="recipe-detail">
                  <span className="kicker">WHY THIS WORKS</span>
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
                      <p>{importedPreset.profile ? `配置文件“${importedPreset.profile}”不会嵌入，但可调整参数已应用。` : 'XMP 只在本机解析，不会上传文件。'}</p>
                      {importedPreset.unsupportedFields.length ? <small>暂未应用：{importedPreset.unsupportedFields.join('、')}</small> : <small>当前文件中的主要调色参数均已映射。</small>}
                    </div>
                  ) : null}

                  {method === 'local-parameters' ? (
                    <div className="recipe-action">
                      {importedPreset ? (
                        <button className="xmp-reimport" type="button" onClick={() => void pickXmpPreset()}><FileUp size={14}/> 更换 XMP 预设</button>
                      ) : (
                        <label className="intensity-control"><span>配方强度 <b>{intensity}%</b></span><input type="range" min="0" max="100" value={intensity} onChange={(event) => setIntensity(Number(event.target.value))}/></label>
                      )}
                      <p><LockKeyhole size={12}/> 最终像素只由本地 Canvas 引擎生成。</p>
                    </div>
                  ) : (
                    <div className="recipe-action">
                      <div className="generation-request-options">
                        <div className="generation-request-options__head">
                          <span><strong>本次输出参数</strong><small>留空时不发送，由供应商使用默认值；多张结果当前仅使用第一张</small></span>
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
                      <p><CloudUpload size={12}/> {imageConfig?.apiType === 'images-generations' ? '仅发送提示词，不上传原图；会重新生成构图与内容。' : '会上传重编码图片；模型可能改变细节。'}</p>
                    </div>
                  )}

                  {revisedPrompt ? <details className="revised-prompt"><summary>查看模型修订提示</summary><p>{revisedPrompt}</p></details> : null}
                </section>
              ) : null}
            </div>
          ) : (
            <div className="panel-content">
              <div className="preset-strip">
                <div><span>当前基线</span><strong>{activeRecipe?.title || '等待应用调色配方'}</strong></div>
                <button type="button" title="重置精细调整" onClick={() => setFineTuneAdjustments(importedPreset?.adjustments || createDefaultAdjustments())}><RotateCcw size={14}/></button>
              </div>
              <div className="fine-tune-intro">
                <p>
                  {outputKind === 'generated'
                    ? '在 AI 生成图之上追加本地精修；所有参数为 0 时不改变生成结果。'
                    : importedPreset
                      ? 'Lightroom XMP 参数已转换到本地控制；这里显示的是当前实际值，可继续微调。'
                      : '以 AI 配方为基线继续微调；基础参数为增量值，0 表示保留当前配方效果。'}
                </p>
              </div>
              <FineTunePanels adjustments={fineTuneAdjustments} setAdjustments={setFineTuneAdjustments}/>
            </div>
          )}
        </div>

        <div className="grade-recipes__footer">
          <div><span>当前执行方式</span><strong>{importedPreset ? 'Lightroom XMP · 本地渲染' : method === 'local-parameters' ? 'AI 参数 · 本地渲染' : 'AI 图像模型 · 云端生成'}</strong></div>
          <span className={`execution-state ${activeRecipe ? 'is-ready' : ''}`}><i/>{activeRecipe ? '可执行' : '等待配方'}</span>
        </div>
      </aside>
    </main>
  )
})


