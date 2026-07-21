export interface LoadedImage {
  name: string
  url: string
  element: HTMLImageElement
  width: number
  height: number
  path?: string
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
  if (!file.type.startsWith('image/')) throw new Error('请选择 JPG、PNG 或 WebP 图片。')
  return decodeImage(URL.createObjectURL(file), file.name)
}

export async function loadImageBytes(bytes: Uint8Array, name: string, path?: string): Promise<LoadedImage> {
  const blob = new Blob([bytes.slice().buffer], { type: mimeFromName(name) })
  return decodeImage(URL.createObjectURL(blob), name, path)
}

export async function loadImageDataUrl(dataUrl: string, name = 'ai-colored.jpg'): Promise<LoadedImage> {
  if (!dataUrl.startsWith('data:image/')) throw new Error('图像模型返回了无效的图片数据。')
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return decodeImage(URL.createObjectURL(blob), name)
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
