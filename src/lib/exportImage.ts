import { processImageDataAsync, yieldToUi } from './colorEngine'
import { canvasToBlob, imageToImageDataAsync } from './files'
import { GpuPreviewRenderer } from './gpuPreview'
import type { CubeLut3D } from './cubeLut'
import type { Adjustments, MatchProfile } from './types'

export interface GradedExportResult {
  bytes: Uint8Array
  width: number
  height: number
  engine: 'gpu' | 'cpu'
}

export interface GradedExportOptions {
  profile?: MatchProfile | null
  cubeLut?: CubeLut3D | null
  /** JPEG quality 0–1. Default 0.92 (near-original visual, Lightroom-like). */
  quality?: number
  /**
   * Optional longest-side cap. Default: full native resolution
   * (only reduced if GPU texture limits require it).
   */
  maxSide?: number
}

function fitWithinMaxSide(width: number, height: number, maxSide: number) {
  const longest = Math.max(width, height)
  if (longest <= maxSide) return { width, height, scale: 1 }
  const scale = maxSide / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

function prepareSourceBitmap(
  image: HTMLImageElement,
  maxSide: number,
): { source: HTMLImageElement | HTMLCanvasElement; width: number; height: number } {
  const nativeW = image.naturalWidth || image.width
  const nativeH = image.naturalHeight || image.height
  if (!nativeW || !nativeH) throw new Error('图片尚未解码完成')

  const fitted = fitWithinMaxSide(nativeW, nativeH, maxSide)
  if (fitted.scale >= 1) {
    return { source: image, width: nativeW, height: nativeH }
  }

  // Only scale when forced by maxSide / GPU limits — never by arbitrary preview caps.
  const canvas = document.createElement('canvas')
  canvas.width = fitted.width
  canvas.height = fitted.height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('无法创建导出画布')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, fitted.width, fitted.height)
  return { source: canvas, width: fitted.width, height: fitted.height }
}

async function exportWithGpu(
  image: HTMLImageElement,
  adjustments: Adjustments,
  options: GradedExportOptions,
  maxSide: number,
): Promise<GradedExportResult> {
  const presentCanvas = document.createElement('canvas')
  let renderer: GpuPreviewRenderer | null = null
  try {
    renderer = new GpuPreviewRenderer(presentCanvas)
    const texLimit = Math.max(2048, Math.min(renderer.getMaxTextureSize(), maxSide))
    const prepared = prepareSourceBitmap(image, texLimit)
    renderer.setSourceFromBitmap(prepared.source, prepared.width, prepared.height)
    if (options.cubeLut) {
      try {
        renderer.setCubeLut(options.cubeLut)
      } catch {
        // LUT optional on GPU; continue without rather than fail the whole export.
        renderer.setCubeLut(null)
      }
    }
    await yieldToUi()
    const canvas = renderer.renderForExport(adjustments, options.profile ?? null)
    const blob = await canvasToBlob(canvas, options.quality ?? 0.92)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return {
      bytes,
      width: prepared.width,
      height: prepared.height,
      engine: 'gpu',
    }
  } finally {
    renderer?.dispose()
  }
}

async function exportWithCpu(
  image: HTMLImageElement,
  adjustments: Adjustments,
  options: GradedExportOptions,
  maxSide: number,
): Promise<GradedExportResult> {
  // Full-res by default; maxSide only caps extreme GPU-limit fallbacks.
  const exportData = await imageToImageDataAsync(image, maxSide)
  await yieldToUi()
  const processed = await processImageDataAsync(
    exportData,
    adjustments,
    options.profile ?? null,
    options.cubeLut ?? null,
    { rowsPerSlice: 16 },
  )
  const canvas = document.createElement('canvas')
  canvas.width = processed.width
  canvas.height = processed.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建导出画布')
  context.putImageData(processed, 0, 0)
  const blob = await canvasToBlob(canvas, options.quality ?? 0.92)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return {
    bytes,
    width: processed.width,
    height: processed.height,
    engine: 'cpu',
  }
}

/**
 * Full-resolution graded export.
 * Prefers WebGL (Lightroom-like speed), falls back to chunked CPU if GPU fails.
 */
export async function exportGradedImage(
  image: HTMLImageElement,
  adjustments: Adjustments,
  options: GradedExportOptions = {},
): Promise<GradedExportResult> {
  await yieldToUi()
  const nativeLongest = Math.max(image.naturalWidth || 1, image.naturalHeight || 1)
  // Prefer full native size; caller can pass a higher/lower cap explicitly.
  const maxSide = options.maxSide ?? nativeLongest

  try {
    return await exportWithGpu(image, adjustments, options, maxSide)
  } catch (gpuError) {
    console.warn('GPU export failed; falling back to CPU.', gpuError)
    return exportWithCpu(image, adjustments, options, maxSide)
  }
}
