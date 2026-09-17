import { createDefaultAdjustments } from './defaults'
import { DEFAULT_WORKSPACE_ID } from './desktop'
import { sha1Hex } from './hash'
import { thumbnailCacheKey, THUMBNAIL_MAX_SIDE } from './thumbnails'
import type {
  SourceVolume, VolumeDriveType, VolumePolicy, WorkspaceDevelop, WorkspaceImportEntry, WorkspaceManifest,
  WorkspacePhoto, WorkspacePhotoOrigin, WorkspacePhotoStatus, WorkspaceReferenceEntry, WorkspaceRenderMode,
} from './types'

/** 默认开发参数：每张图片独立持有，切图不共享。 */
export function createEmptyDevelop(): WorkspaceDevelop {
  return {
    adjustments: createDefaultAdjustments(),
    fineTuneVisibility: {},
    matchRenderMode: 'none',
    modelStyle: '',
  }
}

export function createEmptyManifest(id = DEFAULT_WORKSPACE_ID): WorkspaceManifest {
  const now = Date.now()
  return { version: 1, id, createdAt: now, updatedAt: now, revision: 0, reference: null, photos: [] }
}

/**
 * 图片身份 = sha1(volumeId + "|" + 卷内相对路径)。
 *
 * 刻意不用盘符、也不用内容哈希：盘符会漂移（同一块移动硬盘今天 E: 明天 F:），
 * 而内容哈希需要完整读取全部原片数据，代价远大于收益。
 */
export function photoIdentity(volumeId: string, relativeSourcePath: string): string {
  return sha1Hex(`${volumeId}|${relativeSourcePath}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

const PHOTO_ORIGINS: WorkspacePhotoOrigin[] = ['copy', 'reference']
const PHOTO_STATUSES: WorkspacePhotoStatus[] = ['pending', 'copying', 'ready', 'failed', 'missing']

function readOrigin(value: unknown): WorkspacePhotoOrigin {
  return PHOTO_ORIGINS.includes(value as WorkspacePhotoOrigin) ? (value as WorkspacePhotoOrigin) : 'reference'
}

function readStatus(value: unknown, origin: WorkspacePhotoOrigin): WorkspacePhotoStatus {
  if (PHOTO_STATUSES.includes(value as WorkspacePhotoStatus)) return value as WorkspacePhotoStatus
  return origin === 'copy' ? 'pending' : 'ready'
}

function normalizeReference(value: unknown): WorkspaceReferenceEntry | null {
  if (!isRecord(value)) return null
  const volumeId = readString(value.volumeId)
  const relativeSourcePath = readString(value.relativeSourcePath)
  if (!volumeId || !relativeSourcePath) return null
  const origin = readOrigin(value.origin)
  return {
    id: readString(value.id) || `ref_${photoIdentity(volumeId, relativeSourcePath)}`,
    origin,
    volumeId,
    relativeSourcePath,
    sourcePath: readString(value.sourcePath),
    workspacePath: typeof value.workspacePath === 'string' ? value.workspacePath : null,
    status: readStatus(value.status, origin),
    stats: isRecord(value.stats) ? (value.stats as unknown as WorkspaceReferenceEntry['stats']) : null,
  }
}

function normalizeDevelop(value: unknown): WorkspaceDevelop | null {
  if (!isRecord(value)) return null
  const defaults = createEmptyDevelop()
  const adjustments = isRecord(value.adjustments) ? value.adjustments : {}
  const mode = value.matchRenderMode
  return {
    // 旧版本可能只存了部分字段，缺的用默认值补齐而不是整条丢弃。
    adjustments: { ...defaults.adjustments, ...adjustments } as WorkspaceDevelop['adjustments'],
    fineTuneVisibility: isRecord(value.fineTuneVisibility)
      ? (value.fineTuneVisibility as WorkspaceDevelop['fineTuneVisibility'])
      : {},
    matchRenderMode: (mode === 'none' || mode === 'local' || mode === 'ai' ? mode : 'none') as WorkspaceRenderMode,
    modelStyle: readString(value.modelStyle),
  }
}

function normalizePhoto(value: unknown): WorkspacePhoto | null {
  if (!isRecord(value)) return null
  const volumeId = readString(value.volumeId)
  const relativeSourcePath = readString(value.relativeSourcePath)
  if (!volumeId || !relativeSourcePath) return null
  const origin = readOrigin(value.origin)
  const id = readString(value.id) || photoIdentity(volumeId, relativeSourcePath)
  const sizeBytes = readNumber(value.sizeBytes)
  const mtimeMs = readNumber(value.mtimeMs)
  return {
    id,
    volumeId,
    relativeSourcePath,
    sourcePath: readString(value.sourcePath),
    origin,
    workspacePath: typeof value.workspacePath === 'string' ? value.workspacePath : null,
    status: readStatus(value.status, origin),
    sizeBytes,
    mtimeMs,
    isRaw: readBoolean(value.isRaw),
    width: typeof value.width === 'number' ? value.width : null,
    height: typeof value.height === 'number' ? value.height : null,
    thumbKey: readString(value.thumbKey)
      || thumbnailCacheKey({ volumeId, relativeSourcePath, sizeBytes, mtimeMs }, THUMBNAIL_MAX_SIDE),
    stats: isRecord(value.stats) ? (value.stats as unknown as WorkspacePhoto['stats']) : null,
    referenceOverride: normalizeReference(value.referenceOverride),
    develop: normalizeDevelop(value.develop),
    editedAt: typeof value.editedAt === 'number' ? value.editedAt : null,
  }
}

/**
 * 容错归一化：manifest 被截断或缺字段时降级为可用状态，而不是抛错让整页打不开。
 * 单张图片缺关键字段时只丢那一条。
 */
export function normalizeManifest(value: unknown, id = DEFAULT_WORKSPACE_ID): WorkspaceManifest {
  const source = isRecord(value) ? value : {}
  const photos = Array.isArray(source.photos)
    ? source.photos.map(normalizePhoto).filter((photo): photo is WorkspacePhoto => photo !== null)
    : []
  const now = Date.now()
  return {
    version: 1,
    id: readString(source.id) || id,
    createdAt: readNumber(source.createdAt, now),
    updatedAt: readNumber(source.updatedAt, now),
    revision: readNumber(source.revision),
    reference: normalizeReference(source.reference),
    photos,
  }
}

/** 后端用 revision 做乐观并发；这里只负责识别该冲突，方便调用方决定是否重载。 */
export function isRevisionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.includes('已在别处修改')
}

/**
 * 预览 / 导出 / AI 追色 / AI 二次校正四条路径共用的参考图入口。
 * 单图专属覆盖优先，否则回落到工作区级共享参考。
 */
export function effectiveReference(
  photo: WorkspacePhoto | null,
  manifest: WorkspaceManifest | null,
): WorkspaceReferenceEntry | null {
  if (!photo || !manifest) return null
  return photo.referenceOverride ?? manifest.reference ?? null
}

export function photoDisplayName(photo: WorkspacePhoto): string {
  return photo.relativeSourcePath.split('/').pop() || photo.sourcePath.split(/[\\/]/).pop() || 'image.jpg'
}

export function findPhoto(manifest: WorkspaceManifest | null, photoId: string | null): WorkspacePhoto | null {
  if (!manifest || !photoId) return null
  return manifest.photos.find((photo) => photo.id === photoId) ?? null
}

/** 某个绝对路径在所在卷内的相对路径；不在卷根下时返回 null。 */
export function relativeWithinVolume(filePath: string, volumeRoot: string): string | null {
  const file = filePath.replace(/\\/g, '/')
  const root = volumeRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root) return file.replace(/^\/+/, '')
  if (!file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null
  return file.slice(root.length + 1)
}

export interface ImportPlanItem {
  path: string
  relativeSourcePath: string
  isRaw: boolean
  /** 已在工作区（同 volumeId + 卷内相对路径），导入时会跳过。 */
  duplicate: boolean
}

export interface ImportPlanVolume {
  volumeId: string
  label: string
  rootPath: string
  driveType: VolumeDriveType
  policy: VolumePolicy
  /** 该策略来自上次记忆，而非本次判断 —— 面板据此折叠为摘要。 */
  remembered: boolean
  items: ImportPlanItem[]
  totalBytes: number
  copyBytes: number
}

export interface ImportPlan {
  volumes: ImportPlanVolume[]
  copyBytes: number
  copyCount: number
  referenceCount: number
  duplicateCount: number
  newCount: number
  /** 复制目标盘的可用容量与实际目标路径，用于空间预检。 */
  availableBytes: number
  targetPath: string
  /** 空间不足时必须阻止导入，而不是复制到一半才失败。 */
  blocked: boolean
}

export interface BuildImportPlanOptions {
  paths: string[]
  volumes: SourceVolume[]
  /** 用户在本次面板上的逐卷改判；缺省时用卷判定给出的推荐值。 */
  overrides?: Record<string, VolumePolicy>
  manifest: WorkspaceManifest | null
  availableBytes: number
  targetPath: string
}

function isRawName(name: string): boolean {
  const extension = name.split('.').pop()?.toLowerCase() || ''
  return ['3fr', 'ari', 'arw', 'bay', 'cr2', 'cr3', 'crw', 'cs1', 'dcr', 'dng', 'erf', 'fff', 'iiq',
    'k25', 'kdc', 'mdc', 'mef', 'mos', 'mrw', 'nef', 'nrw', 'obm', 'orf', 'pef', 'ptx', 'pxn',
    'r3d', 'raf', 'raw', 'rw2', 'rwl', 'sr2', 'srf', 'srw', 'x3f'].includes(extension)
}

function sizeOfPath(path: string, volumes: SourceVolume[]): number {
  // 逐卷统计已经在 Rust 侧完成；这里只在能定位到卷时按均值兜底，避免前端重复扫描磁盘。
  const volume = volumes.find((candidate) => relativeWithinVolume(path, candidate.rootPath) !== null)
  if (!volume || volume.fileCount === 0) return 0
  return Math.round(volume.totalBytes / volume.fileCount)
}

/** 组装导入确认面板需要的数据：按卷分组、重复项标注、空间账。 */
export function buildImportPlan(options: BuildImportPlanOptions): ImportPlan {
  const { paths, volumes, overrides = {}, manifest, availableBytes, targetPath } = options
  const existing = new Set((manifest?.photos ?? []).map((photo) => photo.id))

  const grouped = new Map<string, ImportPlanVolume>()
  let duplicateCount = 0

  for (const path of paths) {
    const volume = volumes.find((candidate) => relativeWithinVolume(path, candidate.rootPath) !== null)
    if (!volume) continue
    const relativeSourcePath = relativeWithinVolume(path, volume.rootPath)
    if (!relativeSourcePath) continue

    const policy = overrides[volume.volumeId] ?? volume.recommendation
    const group = grouped.get(volume.volumeId) ?? {
      volumeId: volume.volumeId,
      label: volume.label,
      rootPath: volume.rootPath,
      driveType: volume.driveType,
      policy,
      remembered: volume.rememberedPolicy !== null,
      items: [],
      totalBytes: 0,
      copyBytes: 0,
    }
    group.policy = policy

    const duplicate = existing.has(photoIdentity(volume.volumeId, relativeSourcePath))
      || group.items.some((item) => item.relativeSourcePath === relativeSourcePath)
    if (duplicate) duplicateCount += 1

    const sizeBytes = sizeOfPath(path, volumes)
    group.totalBytes += sizeBytes
    if (policy === 'copy' && !duplicate) group.copyBytes += sizeBytes
    group.items.push({ path, relativeSourcePath, isRaw: isRawName(path), duplicate })
    grouped.set(volume.volumeId, group)
  }

  const list = [...grouped.values()].sort((left, right) =>
    left.rootPath.toLowerCase().localeCompare(right.rootPath.toLowerCase()))
  const copyBytes = list.reduce((total, group) => total + group.copyBytes, 0)
  const copyCount = list.reduce(
    (total, group) => total + group.items.filter((item) => group.policy === 'copy' && !item.duplicate).length,
    0,
  )
  const referenceCount = list.reduce(
    (total, group) => total + group.items.filter((item) => group.policy === 'reference' && !item.duplicate).length,
    0,
  )

  return {
    volumes: list,
    copyBytes,
    copyCount,
    referenceCount,
    duplicateCount,
    newCount: copyCount + referenceCount,
    availableBytes,
    targetPath,
    // 按实际字节数判断，不用剩余百分比之类的软阈值。
    blocked: copyBytes > availableBytes,
  }
}

/**
 * 判断这次导入是否需要用户拿主意。
 *
 * 只有三种情形值得打断用户：空间不足（必须改判为引用才能继续）、有重复项会被跳过
 * （不说明的话用户会以为导入漏了）、来源不是内部硬盘（复制整卷可能很贵，得先确认）。
 * 其余「内部硬盘 + 空间充足 + 无重复」是绝大多数情况，直接导入即可——
 * 此时弹面板只是把已经确定的推荐值再念一遍。
 */
export function needsImportDecision(plan: ImportPlan): boolean {
  if (plan.blocked) return true
  if (plan.duplicateCount > 0) return true
  return plan.volumes.some((volume) => volume.driveType !== 'fixed')
}

/** 面板确认后转成后端导入条目；重复项在这里就被过滤掉。 */
export function toImportEntries(plan: ImportPlan, targetFolder = ''): WorkspaceImportEntry[] {
  const entries: WorkspaceImportEntry[] = []
  for (const group of plan.volumes) {
    for (const item of group.items) {
      if (item.duplicate) continue
      const targetRelative = targetFolder ? `${targetFolder}/${item.relativeSourcePath}` : item.relativeSourcePath
      entries.push({
        sourcePath: item.path,
        volumeId: group.volumeId,
        relativeSourcePath: item.relativeSourcePath,
        targetRelative,
        origin: group.policy,
      })
    }
  }
  return entries
}

/** 调整参数直接写回 `photos[currentId].develop`，不存在“切图时提交”这一步。 */
export function applyDevelop(
  manifest: WorkspaceManifest,
  photoId: string,
  develop: WorkspaceDevelop,
  editedAt = Date.now(),
): WorkspaceManifest {
  return {
    ...manifest,
    photos: manifest.photos.map((photo) =>
      photo.id === photoId ? { ...photo, develop, editedAt } : photo),
  }
}

export interface ApplyRecipeResult {
  manifest: WorkspaceManifest
  applied: string[]
  skipped: string[]
}

/**
 * 唯一的批量动作：把当前图片的配方套用到所选。
 * 源图自己不在所选里也会被排除，避免无意义的写入。
 */
export function applyRecipeToPhotos(
  manifest: WorkspaceManifest,
  sourcePhotoId: string,
  targetPhotoIds: string[],
): ApplyRecipeResult {
  const source = findPhoto(manifest, sourcePhotoId)
  if (!source?.develop) {
    return { manifest, applied: [], skipped: [...targetPhotoIds] }
  }

  const applied: string[] = []
  const skipped: string[] = []
  const targets = new Set(targetPhotoIds)

  const photos = manifest.photos.map((photo) => {
    if (!targets.has(photo.id) || photo.id === sourcePhotoId) {
      if (targets.has(photo.id)) skipped.push(photo.id)
      return photo
    }
    applied.push(photo.id)
    return { ...photo, develop: structuredClone(source.develop as WorkspaceDevelop), editedAt: Date.now() }
  })

  return { manifest: { ...manifest, photos }, applied, skipped }
}

/** 缩略图栏角标所需的派生状态。 */
export function photoBadges(photo: WorkspacePhoto) {
  return {
    raw: photo.isRaw,
    edited: photo.editedAt !== null,
    overriddenReference: photo.referenceOverride !== null,
    status: photo.status,
  }
}

/**
 * 删除若干图片后，当前编辑对象应该落到哪一张。
 *
 * 只有被删的正好是当前图时才改选（优先下一张 ready）；否则保持不动——
 * 批量删除删掉的往往不是正在编辑的那张，无谓地跳走会让人以为「编辑丢了」。
 */
export function nextCurrentIdAfterRemoval(
  photos: WorkspacePhoto[],
  removedIds: ReadonlySet<string>,
  currentId: string | null,
): string | null {
  // 没有当前图时保持「没有」：用户主动取消过选中（deselect），删别的图不该替他选一张。
  if (currentId === null) return null
  if (!removedIds.has(currentId)) return currentId
  // 只回落到仍可用的图：pending / failed 的图被选中后会立刻弹出「副本缺失，需要重新复制」。
  return photos.find((photo) => photo.status === 'ready')?.id ?? null
}

/** 删除这些图片能回收多少字节：只有副本占工作区空间，引用不占。 */
export function reclaimableBytesForRemoval(
  photos: WorkspacePhoto[],
  photoIds: readonly string[],
): number {
  const wanted = new Set(photoIds)
  return photos.reduce(
    (total, photo) => (wanted.has(photo.id) && photo.origin === 'copy' ? total + photo.sizeBytes : total),
    0,
  )
}
