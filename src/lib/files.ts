export interface LoadedImage {
  name: string
  url: string
  element: HTMLImageElement
  width: number
  height: number
  path?: string
  /** True when the source was decoded from camera RAW (preview is sRGB JPEG). */
  fromRaw?: boolean
}

const RASTER_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])

export function isRasterImageName(name: string) {
  const extension = name.split('.').pop()?.toLowerCase() || ''
  return RASTER_EXTENSIONS.has(extension)
}

function mimeFromName(name: string) {
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return 'image/jpeg'
}

async function decodeImage(url: string, name: string, path?: string): Promise<LoadedImage> {
  const element = new Image()
  element.decoding = 'async'
  element.src = url
  try {
    await element.decode()
  } catch {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    throw new Error('图片解码失败，请确认文件没有损坏。')
  }
  return { name, url, element, width: element.naturalWidth, height: element.naturalHeight, path }
}

export async function loadImageFile(file: File): Promise<LoadedImage> {
  if (file.type.startsWith('image/')) return decodeImage(URL.createObjectURL(file), file.name)
  if (isRasterImageName(file.name)) return decodeImage(URL.createObjectURL(file), file.name)
  throw new Error('请选择 JPG、PNG、WebP 或（桌面端）相机 RAW 文件。')
}

export async function loadImageBytes(
  bytes: Uint8Array,
  name: string,
  path?: string,
  options?: { fromRaw?: boolean },
): Promise<LoadedImage> {
  const type = options?.fromRaw ? 'image/jpeg' : mimeFromName(name)
  const blob = new Blob([bytes.slice().buffer], { type })
  const loaded = await decodeImage(URL.createObjectURL(blob), name, path)
  return options?.fromRaw ? { ...loaded, fromRaw: true } : loaded
}

export async function loadImageDataUrl(dataUrl: string, name = 'ai-colored.jpg'): Promise<LoadedImage> {
  if (!dataUrl.startsWith('data:image/')) throw new Error('图像模型返回了无效的图片数据。')
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return decodeImage(URL.createObjectURL(blob), name)
}

/** Analysis / stats path: intentionally smaller for speed. */
export const ANALYSIS_MAX_SIDE = 1200
/**
 * Preview path budget (device pixels, longest side).
 * High enough for large windows / HiDPI, capped for GPU upload cost.
 */
export const PREVIEW_MAX_SIDE = 4096
/** While the preview frame has not laid out yet, use this interim longest side. */
export const PREVIEW_FALLBACK_MAX_SIDE = 1920

/**
 * 预览框是否已经完成布局测量。
 *
 * 阈值与 `computeViewportPreviewSize` 内部保持一致：视口任一边 < 2px 都会被当成「还没布局」，
 * 转而按 `PREVIEW_FALLBACK_MAX_SIDE` 回退处理。调用方据此跳过这一次回退计算——它是对原图的
 * 同步 drawImage + getImageData，而结果随后必然被真实尺寸的结果替换，属于白冻一次主线程。
 */
export function isViewportMeasured(viewportCssWidth: number, viewportCssHeight: number) {
  return viewportCssWidth >= 2 && viewportCssHeight >= 2
}

export interface ViewportPreviewOptions {
  maxSide?: number
  fallbackMaxSide?: number
  devicePixelRatio?: number
}

/**
 * Compute contain-fit pixel size for a Lightroom-style Fit preview:
 * scale the image to fill the viewport in device pixels, never upscale, optional max-side cap.
 */
export function computeViewportPreviewSize(
  imageWidth: number,
  imageHeight: number,
  viewportCssWidth: number,
  viewportCssHeight: number,
  options: ViewportPreviewOptions = {},
): { width: number; height: number; scale: number } {
  const maxSide = options.maxSide ?? PREVIEW_MAX_SIDE
  const fallbackMaxSide = options.fallbackMaxSide ?? PREVIEW_FALLBACK_MAX_SIDE
  const dpr = options.devicePixelRatio
    ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const srcW = Math.max(1, imageWidth)
  const srcH = Math.max(1, imageHeight)
  const longest = Math.max(srcW, srcH)

  let scale: number
  if (viewportCssWidth < 2 || viewportCssHeight < 2) {
    scale = Math.min(1, fallbackMaxSide / longest, maxSide / longest)
  } else {
    const boxW = Math.max(1, Math.floor(viewportCssWidth * dpr))
    const boxH = Math.max(1, Math.floor(viewportCssHeight * dpr))
    const fit = Math.min(boxW / srcW, boxH / srcH)
    scale = Math.min(1, fit, maxSide / longest)
  }

  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
    scale,
  }
}

export function imageToImageData(image: HTMLImageElement, maxSide = 900) {
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器无法创建 Canvas 上下文。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
}

/** Decode + downscale off the critical click path after the UI has painted. */
export async function imageToImageDataAsync(image: HTMLImageElement, maxSide = 900): Promise<ImageData> {
  // Yield once so “正在导出” can paint before we allocate a large canvas.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
  return imageToImageData(image, maxSide)
}

/** Rasterize an image for on-screen BEFORE/AFTER preview (viewport-matched). */
export function imageToViewportImageData(
  image: HTMLImageElement,
  viewportCssWidth: number,
  viewportCssHeight: number,
  options: ViewportPreviewOptions = {},
): ImageData {
  const { width, height } = computeViewportPreviewSize(
    image.naturalWidth,
    image.naturalHeight,
    viewportCssWidth,
    viewportCssHeight,
    options,
  )
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器无法创建 Canvas 上下文。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
}

export function imageToDataUrl(image: HTMLImageElement, maxSide = 1024, quality = 0.82) {
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建模型缩略图。')
  context.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', quality)
}

export function drawImageDataToCanvas(canvas: HTMLCanvasElement, imageData: ImageData) {
  canvas.width = imageData.width
  canvas.height = imageData.height
  const context = canvas.getContext('2d')
  context?.putImageData(imageData, 0, 0)
}

export function drawImageToCanvas(canvas: HTMLCanvasElement, image: HTMLImageElement) {
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  context?.drawImage(image, 0, 0)
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.94) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法生成 JPEG 文件。')), 'image/jpeg', quality)
  })
}
