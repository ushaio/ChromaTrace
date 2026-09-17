import { formatBytes, groupDigits } from './format'
import type {
  PropertiesField, PropertiesGroup, WorkspacePhoto, WorkspacePhotoOrigin, WorkspacePhotoProperties,
  WorkspacePhotoStatus,
} from './types'

/**
 * 属性弹窗要显示的内容：**文件信息在前端组装，EXIF 用后端给的成品分组**。
 *
 * 分开的理由是职责而不是省事：文件信息里有大小与时间，需要按本地时区与统一单位渲染；
 * 而光圈/快门/ISO 已经是摄影语义的成品文案（`1/250 秒`、`f/2.8`），
 * 在后端定稿后前端不必再认识 EXIF 标签表，加标签也不用改 TS。
 */

const ORIGIN_LABELS: Record<WorkspacePhotoOrigin, string> = {
  copy: '已复制到工作区',
  reference: '直接引用原文件',
}

const STATUS_LABELS: Record<WorkspacePhotoStatus, string> = {
  pending: '待复制',
  copying: '复制中',
  ready: '就绪',
  failed: '复制失败',
  missing: '不可用',
}

export interface FileInfoOptions {
  /** 时间戳 → 文案。默认按浏览器本地时区渲染；测试注入固定实现以保证断言稳定。 */
  formatTime?: (ms: number) => string
}

function localTime(ms: number): string {
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false })
}

export function fileNameOf(photo: WorkspacePhoto): string {
  const name = photo.relativeSourcePath.split(/[\\/]/).pop()
  return name || photo.sourcePath.split(/[\\/]/).pop() || 'image'
}

/** 扩展名 + 大类，例如 `CR3（相机 RAW）`。 */
export function describeFileType(photo: WorkspacePhoto, properties: WorkspacePhotoProperties | null): string {
  const isRaw = properties?.isRaw ?? photo.isRaw
  const name = fileNameOf(photo)
  // 没有点号的文件名不能被当成扩展名（"IMG_0001" 不是扩展名为 IMG_0001 的文件）。
  const extension = (properties?.extension || (name.includes('.') ? name.split('.').pop() ?? '' : '')).toUpperCase()
  if (!extension) return isRaw ? '相机 RAW' : '未知格式'
  return isRaw ? `${extension}（相机 RAW）` : extension
}

/** 像素尺寸；两个数都缺时返回 null（标签随之整行不显示）。 */
export function describePixelSize(
  dimensions: { width: number | null; height: number | null },
): string | null {
  const { width, height } = dimensions
  if (!width || !height) return null
  return `${width} × ${height} 像素（${(width * height / 1_000_000).toFixed(1)} MP）`
}

/**
 * 文件信息分组。
 *
 * `properties` 为 null（浏览器预览，或读取失败）时只渲染 manifest 里已有的字段——
 * 文件名、大小、来源、状态本来就在 manifest 上，不该因为拿不到 EXIF 而整块空着。
 */
export function fileInfoGroup(
  photo: WorkspacePhoto,
  properties: WorkspacePhotoProperties | null,
  options: FileInfoOptions = {},
): PropertiesGroup {
  const formatTime = options.formatTime ?? localTime
  const fields: PropertiesField[] = []
  const push = (label: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined) return
    const text = String(value).trim()
    if (text) fields.push({ label, value: text })
  }

  const sizeBytes = properties?.sizeBytes ?? photo.sizeBytes

  push('文件名', properties?.fileName ?? fileNameOf(photo))
  push('文件类型', describeFileType(photo, properties))
  push('像素尺寸', describePixelSize({
    width: properties?.width ?? photo.width,
    height: properties?.height ?? photo.height,
  }))
  push('文件大小', `${formatBytes(sizeBytes)}（${groupDigits(sizeBytes)} 字节）`)
  // 时间以 manifest 记录的源文件时间为准（导入时读到的），磁盘上那个文件的时间另起一行：
  // 副本的 mtime 其实是复制时刻，当成「文件修改时间」会让人以为照片刚被改过。
  push('文件修改时间', formatTime(photo.mtimeMs))
  push(
    '磁盘文件时间',
    properties?.modifiedMs && properties.modifiedMs !== photo.mtimeMs ? formatTime(properties.modifiedMs) : null,
  )
  push('编辑时间', properties?.editedAt ? formatTime(properties.editedAt) : null)
  push('来源', ORIGIN_LABELS[properties?.origin ?? photo.origin])
  push('状态', [
    STATUS_LABELS[properties?.status ?? photo.status],
    properties?.statusReason,
  ].filter(Boolean).join('：'))
  push('原始位置', properties?.sourcePath || photo.sourcePath)
  push('工作区副本', properties?.workspacePath ?? photo.workspacePath ?? '未复制（直接引用）')
  push('读取路径', properties?.resolvedPath)
  push('卷内相对路径', properties?.relativeSourcePath ?? photo.relativeSourcePath)
  push('设备标识', properties?.volumeId ?? photo.volumeId)

  return { title: '文件', fields }
}

/** 弹窗最终渲染的分组：文件信息 + 后端给的 EXIF 分组。 */
export function propertiesGroups(
  photo: WorkspacePhoto,
  properties: WorkspacePhotoProperties | null,
  options: FileInfoOptions = {},
): PropertiesGroup[] {
  return [fileInfoGroup(photo, properties, options), ...(properties?.exifGroups ?? [])]
}

/** EXIF 来源提示：让用户知道这组数据是从哪来的。 */
export function describeExifSource(source: WorkspacePhotoProperties['exifSource']): string | null {
  if (source === 'file') return '读取自文件内 EXIF'
  if (source === 'rawler') return '读取自相机 RAW 元数据'
  return null
}
