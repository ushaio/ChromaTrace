import { decodeRawThumbnailNative, readNativeFile, readWorkspaceThumbnail, writeWorkspaceThumbnail } from './desktop'
import { canvasToBlob, loadImageBytes } from './files'
import { sha1Hex } from './hash'

/**
 * 缩略图导航栏使用的尺寸。必须与 Rust 侧 `workspace.rs::THUMBNAIL_MAX_SIDE` 保持一致，
 * 否则缓存键会对不上（键里含 maxSide）。
 */
export const THUMBNAIL_MAX_SIDE = 256

/** 缩略图并按需重建；并发上限 3，避免一次导入几十张时把解码线程打满。 */
export const THUMBNAIL_CONCURRENCY = 3

/** 与 Rust `to_ascii_lowercase` 逐字节一致：非 ASCII 字符保持原样。 */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

export interface ThumbnailIdentity {
  volumeId: string
  relativeSourcePath: string
  sizeBytes: number
  mtimeMs: number
}

/**
 * 缓存键 = sha1(volumeId|卷内相对路径|size|mtime|maxSide)。
 *
 * * 用卷标识而非盘符：移动硬盘换 USB 口后盘符会漂移，用盘符会让整栏缩略图白白重建；
 * * `size` / `mtime` 参与摘要，源文件被替换必然导致 key 变化，因此不需要额外的失效状态。
 */
export function thumbnailCacheKey(identity: ThumbnailIdentity, maxSide = THUMBNAIL_MAX_SIDE): string {
  return sha1Hex(
    [
      identity.volumeId,
      asciiLower(identity.relativeSourcePath),
      identity.sizeBytes,
      identity.mtimeMs,
      maxSide,
    ].join('|'),
  )
}

/** 简单的并发闸门：超过上限的调用排队，而不是无限制地同时解码。 */
export function createTaskGate(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []

  const acquire = () => {
    if (active < limit) {
      active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiting.push(() => {
        active += 1
        resolve()
      })
    })
  }

  const release = () => {
    active -= 1
    waiting.shift()?.()
  }

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    await acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }
}

const runThumbnailTask = createTaskGate(THUMBNAIL_CONCURRENCY)

async function rasterizeToJpeg(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxSide: number,
): Promise<Uint8Array> {
  const longest = Math.max(sourceWidth, sourceHeight)
  const scale = longest > maxSide ? maxSide / longest : 1
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建 Canvas 上下文。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'medium'
  context.drawImage(source, 0, 0, width, height)
  const blob = await canvasToBlob(canvas, 0.82)
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * 生成缩略图字节。
 *
 * RAW 走 `decode_raw_thumbnail` 的内嵌预览快路径——完整解码会把一次 256px 缩略图的成本
 * 抬到与 4000px 预览相同（45MP 展开为 RGB8 约 135MB）。
 */
async function createThumbnailBytes(path: string, isRaw: boolean): Promise<Uint8Array> {
  if (isRaw) return decodeRawThumbnailNative(path, THUMBNAIL_MAX_SIDE)

  const bytes = await readNativeFile(path)
  const name = path.split(/[\\/]/).pop() || 'image.jpg'
  const blob = new Blob([bytes.slice().buffer], { type: 'image/jpeg' })

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    try {
      return await rasterizeToJpeg(bitmap, bitmap.width, bitmap.height, THUMBNAIL_MAX_SIDE)
    } finally {
      bitmap.close()
    }
  }

  const loaded = await loadImageBytes(bytes, name)
  try {
    return await rasterizeToJpeg(loaded.element, loaded.width, loaded.height, THUMBNAIL_MAX_SIDE)
  } finally {
    URL.revokeObjectURL(loaded.url)
  }
}

export interface ThumbnailRequest {
  workspaceId: string
  key: string
  /** 后端可直接读取的绝对路径（copy 走工作区副本，reference 走当前挂载点）。 */
  path: string
  isRaw: boolean
}

/** 命中缓存直接读盘，未命中才生成并回写；返回可直接给 `<img>` 用的 objectURL。 */
export async function loadThumbnailObjectUrl(request: ThumbnailRequest): Promise<string> {
  return runThumbnailTask(async () => {
    let bytes: Uint8Array | null = null
    try {
      bytes = await readWorkspaceThumbnail(request.workspaceId, request.key)
    } catch {
      // 缓存读不出来不是致命错误——按未命中处理，重新生成即可。
      bytes = null
    }

    if (!bytes || bytes.length === 0) {
      bytes = await createThumbnailBytes(request.path, request.isRaw)
      try {
        await writeWorkspaceThumbnail(request.workspaceId, request.key, bytes)
      } catch {
        // 落盘失败只影响下次启动的命中率，本次仍可正常显示。
      }
    }

    return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'image/jpeg' }))
  })
}
