import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { analyzeImageData } from './colorEngine'
import {
  cancelWorkspaceImport, classifySourceVolumes, clearWorkspace as clearWorkspaceNative, DEFAULT_WORKSPACE_ID,
  decodeRawNative, deleteWorkspacePhotos, getWorkspaceDiskSpace, importWorkspaceFiles, importWorkspaceReference, isRawPath,
  listAbsentWorkspaceVolumes, pickDirectory, pickImagePaths, readNativeFile, readWorkspaceManifest,
  resolveVolumeMount, resolveWorkspacePhotoPaths, resolveWorkspaceReferencePath, setVolumePolicy,
  writeWorkspaceManifest,
} from './desktop'
import {
  ANALYSIS_MAX_SIDE, imageToImageDataAsync, loadImageBytes, loadImageFile, PREVIEW_MAX_SIDE, type LoadedImage,
} from './files'
import { formatBytes } from './format'
import { loadThumbnailObjectUrl, THUMBNAIL_CONCURRENCY } from './thumbnails'
import {
  applyDevelop, applyRecipeToPhotos, buildImportPlan, createEmptyDevelop, createEmptyManifest, effectiveReference,
  needsImportDecision, nextCurrentIdAfterRemoval, reclaimableBytesForRemoval,
  findPhoto, isRevisionConflict, normalizeManifest, relativeWithinVolume, toImportEntries, type ImportPlan,
} from './workspace'
import type {
  ColorStats, ResolvedWorkspacePhoto, SourceVolume, VolumePolicy, WorkspaceDevelop, WorkspaceImportProgress,
  WorkspaceManifest, WorkspacePhoto, WorkspaceReferenceEntry, WorkspaceVolumeAbsence,
} from './types'

type Notify = (message: string, kind?: 'ok' | 'error') => void

/** 分析图 LRU 容量：直方图 / 诊断 / 本地匹配读它，但不必常驻更多。 */
const ANALYSIS_CACHE_LIMIT = 5
/** 参数调整写盘防抖：合并高频拖动，避免写放大（plan §11 风险表）。 */
const MANIFEST_WRITE_DEBOUNCE_MS = 400
/** 已就该卷提示过“改为引用”的风险，不再重复打扰。撤销入口在「设置 → 资料库 → 卷记忆」。 */
const warnedReferenceVolumes = new Set<string>()

function revokeAll(urls: Record<string, string>) {
  for (const url of Object.values(urls)) URL.revokeObjectURL(url)
}

export interface WorkspaceReferenceView {
  entry: WorkspaceReferenceEntry | null
  image: LoadedImage | null
  stats: ColorStats | null
}

export interface UseWorkspaceResult {
  ready: boolean
  manifest: WorkspaceManifest | null
  photos: WorkspacePhoto[]
  currentPhoto: WorkspacePhoto | null
  currentId: string | null
  selection: string[]
  /** 当前图的全解析图，供「AI 追色」与「AI 调色」两套工作区共用。 */
  source: LoadedImage | null
  sourceData: ImageData | null
  sourceStats: ColorStats | null
  reference: WorkspaceReferenceView
  loadingCurrent: boolean
  thumbUrls: Record<string, string>
  absentVolumes: WorkspaceVolumeAbsence[]
  importing: WorkspaceImportProgress | null
  importPlan: ImportPlan | null
  importBusy: boolean
  importFailures: string[]
  selectPhoto: (photoId: string) => void
  deselect: () => void
  setSelection: (photoIds: string[]) => void
  updateDevelop: (patch: Partial<WorkspaceDevelop>) => void
  applyRecipeToSelection: () => void
  beginImport: (autoConfirmWhenTrivial?: boolean) => Promise<void>
  changeVolumePolicy: (volumeId: string, policy: VolumePolicy) => void
  confirmImport: () => Promise<void>
  cancelImport: () => void
  dismissImport: () => void
  clearWorkspace: () => Promise<void>
  removePhotos: (photoIds: string[]) => Promise<boolean>
  importSinglePath: (path: string, origin?: VolumePolicy) => Promise<void>
  importSingleFile: (file: File) => Promise<void>
  setReferenceFromPath: (path: string) => Promise<void>
  setReferenceFromFile: (file: File) => Promise<void>
  clearReference: () => Promise<void>
  dismissAbsentVolume: (volumeId: string) => void
  convertVolumeToCopy: (volumeId: string) => Promise<void>
  relocateVolume: (volumeId: string) => Promise<void>
  refresh: () => Promise<void>
}

async function loadImageFromPath(path: string): Promise<LoadedImage> {
  const name = path.split(/[\\/]/).pop() || 'image.jpg'
  if (isRawPath(path)) {
    const jpegBytes = await decodeRawNative(path, PREVIEW_MAX_SIDE)
    return loadImageBytes(jpegBytes, `${name.replace(/\.[^.]+$/, '')}.jpg`, path, { fromRaw: true })
  }
  const bytes = await readNativeFile(path)
  return loadImageBytes(bytes, name, path)
}

function createJobId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function joinPath(root: string, relative: string) {
  const separator = root.includes('\\') ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '')
  return `${base}${separator}${relative.replace(/\//g, separator)}`
}

/**
 * 工作区状态容器。
 *
 * 三条不变量：
 * 1. manifest 是唯一真相源：每张图的 develop 参数写在 `photos[i].develop` 上，不存在“切图时提交”，
 *    因此也不会“忘记保存就切图”而丢参数；本地状态只是镜像，变更后防抖写回。
 * 2. 内存三级管线：缩略图落盘、分析图有限 LRU、全解析图只保留当前一张。
 * 3. 参考图是工作区级属性，逐图覆盖由 `effectiveReference` 统一解析。
 *
 * `workspaceId` 变化即切换工作区。切换时必须**先 flush 再清缓存**（见下方切换 effect）：
 * - 不先 flush：上一个工作区最后 400ms 内的 develop 改动会被写进新工作区的 manifest（串区）。
 * - 不清缓存：`photoId` 与工作区无关（同一张图跨工作区 id 相同），上一个工作区的缩略图与
 *   分析图会被错误复用到新工作区（串图）。
 */
export function useWorkspace(notify: Notify, workspaceId: string = DEFAULT_WORKSPACE_ID): UseWorkspaceResult {
  const [manifest, setManifest] = useState<WorkspaceManifest | null>(null)
  const [ready, setReady] = useState(false)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [selection, setSelection] = useState<string[]>([])
  const [source, setSource] = useState<LoadedImage | null>(null)
  const [sourceData, setSourceData] = useState<ImageData | null>(null)
  const [sourceStats, setSourceStats] = useState<ColorStats | null>(null)
  const [referenceImage, setReferenceImage] = useState<LoadedImage | null>(null)
  const [referenceStats, setReferenceStats] = useState<ColorStats | null>(null)
  const [loadingCurrent, setLoadingCurrent] = useState(false)
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({})
  const [absentVolumes, setAbsentVolumes] = useState<WorkspaceVolumeAbsence[]>([])
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null)
  const [importing, setImporting] = useState<WorkspaceImportProgress | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importFailures, setImportFailures] = useState<string[]>([])

  const manifestRef = useRef<WorkspaceManifest | null>(null)
  const writeTimer = useRef<number | null>(null)
  const analysisCache = useRef(new Map<string, ImageData>())
  const thumbUrlsRef = useRef<Record<string, string>>({})
  /** 在途缩略图：photoId → 负责它的 effect 轮次号（见下方缩略图 effect 的取消逻辑）。 */
  const thumbInFlight = useRef(new Map<string, number>())
  /** 缩略图加载轮次号，用来标记「这张图当前由哪一轮负责」。 */
  const thumbRunSeq = useRef(0)
  const sourceRef = useRef<LoadedImage | null>(null)
  const referenceRef = useRef<LoadedImage | null>(null)
  const selectionToken = useRef(0)
  const referenceToken = useRef(0)
  const importPaths = useRef<string[]>([])
  const importVolumes = useRef<SourceVolume[]>([])
  const importOverrides = useRef<Record<string, VolumePolicy>>({})
  const diskSpace = useRef({ availableBytes: 0, path: '' })
  const jobIdRef = useRef<string | null>(null)
  /**
   * 本地 manifest 是否领先于磁盘。
   *
   * 光看 `writeTimer` 不够：计时器已经触发、写入还在途中或刚刚失败时，本地快照同样是
   * 「没落盘」的，而删除命令会直接接管磁盘上的 manifest —— 那会让这些改动凭空消失。
   */
  const manifestDirty = useRef(false)

  sourceRef.current = source
  referenceRef.current = referenceImage
  thumbUrlsRef.current = thumbUrls

  const adoptManifest = useCallback((next: WorkspaceManifest) => {
    const normalized = normalizeManifest(next)
    manifestRef.current = normalized
    setManifest(normalized)
    return normalized
  }, [])

  const notifyError = useCallback((error: unknown, fallback: string) => {
    notify(error instanceof Error ? error.message : typeof error === 'string' ? error : fallback, 'error')
  }, [notify])

  const flushManifest = useCallback(async () => {
    const current = manifestRef.current
    if (!current) return
    try {
      const saved = await writeWorkspaceManifest(current, current.revision, workspaceId)
      if (manifestRef.current === current) {
        adoptManifest(saved)
        manifestDirty.current = false
        return
      }
      /*
       * 写盘期间又排了新的改动（拖滑杆 / 统计回写）：这时只能把新 revision 吸收进来，
       * 绝不能拿旧快照覆盖 —— 否则界面上刚拖到的值会在这一瞬间被回退，随后防抖又把
       * 这份旧快照固化到磁盘，最后一次编辑就永久丢了。
       */
      const latest = manifestRef.current
      // 切换工作区会把 manifestRef 清空，此时什么都不该做（新工作区有自己的写入节奏）。
      if (latest) {
        manifestRef.current = { ...latest, revision: saved.revision, updatedAt: saved.updatedAt }
        setManifest(manifestRef.current)
      }
    } catch (error) {
      if (isRevisionConflict(error)) {
        // 冲突时以磁盘为准重新载入，绝不用旧快照覆盖别人的写入。
        try {
          adoptManifest(await readWorkspaceManifest(workspaceId))
          manifestDirty.current = false
          notify('工作区已在别处更新，已重新载入', 'error')
          return
        } catch {
          // 落回下面的通用错误提示
        }
      }
      notifyError(error, '保存工作区失败')
    }
  }, [adoptManifest, notify, notifyError, workspaceId])

  /** 本地立即生效 + 防抖落盘。 */
  const queueManifest = useCallback((next: WorkspaceManifest) => {
    manifestRef.current = next
    manifestDirty.current = true
    setManifest(next)
    if (writeTimer.current !== null) window.clearTimeout(writeTimer.current)
    writeTimer.current = window.setTimeout(() => {
      writeTimer.current = null
      void flushManifest()
    }, MANIFEST_WRITE_DEBOUNCE_MS)
  }, [flushManifest])

  const cacheAnalysis = useCallback((photoId: string, data: ImageData) => {
    const cache = analysisCache.current
    cache.delete(photoId)
    cache.set(photoId, data)
    while (cache.size > ANALYSIS_CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }, [])

  const refreshAbsence = useCallback(async () => {
    try {
      setAbsentVolumes(await listAbsentWorkspaceVolumes(workspaceId))
    } catch {
      // 卷缺席提示是辅助信息，取不到就不显示。
      setAbsentVolumes([])
    }
  }, [workspaceId])

  /** 载入工作区级共享参考图，并把首次算出的 ColorStats 落盘。 */
  const loadReference = useCallback(async (entry: WorkspaceReferenceEntry | null) => {
    const token = referenceToken.current + 1
    referenceToken.current = token
    const previous = referenceRef.current
    referenceRef.current = null
    setReferenceImage(null)
    setReferenceStats(null)
    if (previous) URL.revokeObjectURL(previous.url)
    if (!entry || entry.status !== 'ready') return

    try {
      const path = await resolveWorkspaceReferencePath(entry, workspaceId)
      if (referenceToken.current !== token) return
      if (!path) {
        notify('参考图当前不可用：请连接该设备或重新选择参考图', 'error')
        return
      }
      const loaded = await loadImageFromPath(path)
      if (referenceToken.current !== token) {
        URL.revokeObjectURL(loaded.url)
        return
      }
      referenceRef.current = loaded
      setReferenceImage(loaded)

      if (entry.stats) {
        setReferenceStats(entry.stats)
        return
      }
      const data = await imageToImageDataAsync(loaded.element, ANALYSIS_MAX_SIDE)
      if (referenceToken.current !== token) return
      const stats = analyzeImageData(data)
      setReferenceStats(stats)
      const base = manifestRef.current
      if (base?.reference && base.reference.id === entry.id) {
        queueManifest({ ...base, reference: { ...base.reference, stats } })
      }
    } catch (error) {
      if (referenceToken.current === token) notifyError(error, '参考图载入失败')
    }
  }, [notify, notifyError, queueManifest, workspaceId])

  const refresh = useCallback(async () => {
    try {
      const loaded = adoptManifest(await readWorkspaceManifest(workspaceId))
      const firstReady = loaded.photos.find((photo) => photo.status === 'ready') ?? loaded.photos[0]
      setCurrentId((current) => current ?? firstReady?.id ?? null)
      setSelection((current) => (current.length ? current : firstReady ? [firstReady.id] : []))
      await refreshAbsence()
    } catch (error) {
      notifyError(error, '工作区载入失败')
    } finally {
      setReady(true)
    }
  }, [adoptManifest, notifyError, refreshAbsence, workspaceId])

  /**
   * 切换工作区：**先 flush 上一个工作区，再清空全部按工作区隔离的缓存，最后载入新工作区**。
   *
   * 顺序不可颠倒：
   * - flush 必须在清缓存之前，否则上一个工作区最后 400ms 内的 develop 改动会随 `manifestRef`
   *   一起被丢弃，或（更糟）被写进新工作区的 manifest。
   * - 清缓存必须在载入新区之前，否则新区的缩略图会命中旧区的 objectURL（`photoId` 跨工作区同值）。
   */
  const activeWorkspaceRef = useRef(workspaceId)
  useEffect(() => {
    const switched = activeWorkspaceRef.current !== workspaceId
    activeWorkspaceRef.current = workspaceId

    // 第一次挂载只做载入，不做清理（此时没有任何需要清理的上一区状态）。
    if (!switched) {
      void refresh()
      return
    }

    let cancelled = false
    const switchWorkspace = async () => {
      // ① 先 flush 上一个工作区的防抖写入（此时 manifestRef 仍指向旧区）。
      if (writeTimer.current !== null) {
        window.clearTimeout(writeTimer.current)
        writeTimer.current = null
      }
      await flushManifest()
      if (cancelled) return

      // ② 作废在途请求：切图 / 参考图 effect 的 token 一旦落后就会自行丢弃结果。
      selectionToken.current += 1
      referenceToken.current += 1

      // ③ 清空按工作区隔离的缓存与派生状态。
      revokeAll(thumbUrlsRef.current)
      thumbUrlsRef.current = {}
      setThumbUrls({})
      thumbInFlight.current.clear()
      analysisCache.current.clear()
      if (sourceRef.current) {
        URL.revokeObjectURL(sourceRef.current.url)
        sourceRef.current = null
      }
      if (referenceRef.current) {
        URL.revokeObjectURL(referenceRef.current.url)
        referenceRef.current = null
      }
      manifestRef.current = null
      setManifest(null)
      setReferenceImage(null)
      setReferenceStats(null)
      setSource(null)
      setSourceData(null)
      setSourceStats(null)
      setCurrentId(null)
      setSelection([])
      setAbsentVolumes([])
      setImportPlan(null)
      setImporting(null)
      setImportFailures([])
      setReady(false)

      // ④ 载入新工作区。
      await refresh()
    }

    void switchWorkspace()
    return () => { cancelled = true }
  }, [workspaceId, refresh, flushManifest])

  useEffect(() => () => {
    if (writeTimer.current !== null) window.clearTimeout(writeTimer.current)
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url)
    if (referenceRef.current) URL.revokeObjectURL(referenceRef.current.url)
    for (const url of Object.values(thumbUrlsRef.current)) URL.revokeObjectURL(url)
  }, [])

  const photos = useMemo(() => manifest?.photos ?? [], [manifest])
  const currentPhoto = useMemo(() => findPhoto(manifest, currentId), [manifest, currentId])
  const referenceEntry = useMemo(() => effectiveReference(currentPhoto, manifest), [currentPhoto, manifest])

  // 切图：加载全解析图 + 分析图，释放上一张的 objectURL。token 防止快速切换时旧结果回写。
  useEffect(() => {
    const token = selectionToken.current + 1
    selectionToken.current = token
    let cancelled = false

    if (!currentId) {
      if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url)
      sourceRef.current = null
      setSource(null)
      setSourceData(null)
      setSourceStats(null)
      return
    }

    const load = async () => {
      setLoadingCurrent(true)
      try {
        const [resolved] = await resolveWorkspacePhotoPaths([currentId], workspaceId)
        if (cancelled || selectionToken.current !== token) return
        if (!resolved?.path) {
          if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url)
          sourceRef.current = null
          setSource(null)
          setSourceData(null)
          setSourceStats(null)
          if (resolved?.reason) notify(resolved.reason, 'error')
          return
        }

        const loaded = await loadImageFromPath(resolved.path)
        if (cancelled || selectionToken.current !== token) {
          URL.revokeObjectURL(loaded.url)
          return
        }
        if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url)
        sourceRef.current = loaded
        setSource(loaded)

        const cached = analysisCache.current.get(currentId)
        const data = cached ?? await imageToImageDataAsync(loaded.element, ANALYSIS_MAX_SIDE)
        if (cancelled || selectionToken.current !== token) return
        if (!cached) cacheAnalysis(currentId, data)
        setSourceData(data)

        const photo = findPhoto(manifestRef.current, currentId)
        if (photo?.stats) {
          setSourceStats(photo.stats)
          return
        }
        const stats = analyzeImageData(data)
        setSourceStats(stats)
        const base = manifestRef.current
        if (base) {
          queueManifest({
            ...base,
            photos: base.photos.map((item) => (item.id === currentId ? { ...item, stats } : item)),
          })
        }
      } catch (error) {
        if (!cancelled && selectionToken.current === token) {
          setSource(null)
          setSourceData(null)
          setSourceStats(null)
          notifyError(error, '图片载入失败')
        }
      } finally {
        if (!cancelled && selectionToken.current === token) setLoadingCurrent(false)
      }
    }

    void load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId])

  const referenceId = manifest?.reference?.id ?? null
  useEffect(() => {
    const base = manifestRef.current
    void loadReference(base?.reference ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceId, manifest?.reference?.workspacePath, manifest?.reference?.sourcePath])

  /*
   * 缩略图：只对 ready 的图片按需生成，命中缓存直接读盘。
   *
   * 三点必须守住，否则「进入工作区」本身就是一次卡顿：
   * 1. 并发：`loadThumbnailObjectUrl` 内部有并发闸门，但串行 await 会让那道闸门永远只看到 1 个任务，
   *    N 张图的总耗时等于逐张耗时之和；
   * 2. 合并提交：每解码完一张就 setThumbUrls 一次，就是一次整棵 App 重渲染（`useWorkspace` 位于
   *    App 渲染体内，没有 memo 边界）——N 张图 = N 次提交，每次都要重渲染几十个缩略图按钮、直方图
   *    与整块舞台。改为按 120ms 窗口合并、攒到 6 张立即提交，把提交次数压到个位数；
   * 3. 触发条件用「内容签名」而不是 `manifest` 对象身份：`queueManifest` 每次写盘都会换掉对象
   *    （拖动任意滑杆都会写一步 develop），若拿它当依赖，加载途中会被反复取消重启——已解码但没
   *    提交的结果被丢弃、在途请求重新排队，表现为「缩略图栏一直填不满」。签名只覆盖「哪些图需要
   *    缩略图、键是什么、状态如何」，develop 变化不再打断加载。
   */
  const thumbSignature = useMemo(
    () => photos.map((photo) => `${photo.id}:${photo.status}:${photo.thumbKey ?? ''}`).join('|'),
    [photos],
  )

  useEffect(() => {
    if (photos.length === 0) return
    const pending = photos.filter(
      (photo) => photo.status === 'ready'
        && !thumbUrlsRef.current[photo.id]
        && !thumbInFlight.current.has(photo.id),
    )
    if (pending.length === 0) return

    let cancelled = false
    const runId = ++thumbRunSeq.current
    let buffered: Array<[string, string]> = []
    let flushTimer = 0

    const flush = () => {
      if (flushTimer !== 0) {
        window.clearTimeout(flushTimer)
        flushTimer = 0
      }
      if (buffered.length === 0) return
      const entries = buffered
      buffered = []
      setThumbUrls((current) => {
        const next = { ...current }
        for (const [id, url] of entries) if (!next[id]) next[id] = url
        return next
      })
    }

    const scheduleFlush = () => {
      if (buffered.length >= 6) {
        flush()
        return
      }
      if (flushTimer !== 0) return
      flushTimer = window.setTimeout(flush, 120)
    }

    const run = async () => {
      let resolved: ResolvedWorkspacePhoto[] = []
      try {
        resolved = await resolveWorkspacePhotoPaths(pending.map((photo) => photo.id), workspaceId)
      } catch {
        return
      }
      if (cancelled) return
      const byId = new Map(resolved.map((item) => [item.photoId, item]))
      const queue = pending.filter((photo) => Boolean(byId.get(photo.id)?.path) && Boolean(photo.thumbKey))

      const worker = async () => {
        for (;;) {
          if (cancelled) return
          const photo = queue.shift()
          if (!photo) return
          const path = byId.get(photo.id)?.path
          const key = photo.thumbKey
          if (!path || !key || thumbInFlight.current.has(photo.id)) continue
          thumbInFlight.current.set(photo.id, runId)
          try {
            const url = await loadThumbnailObjectUrl({ workspaceId, key, path, isRaw: photo.isRaw })
            if (cancelled) {
              URL.revokeObjectURL(url)
              continue
            }
            buffered.push([photo.id, url])
            scheduleFlush()
          } catch {
            // 单张缩略图失败不影响其他图片；下次刷新会重试。
          } finally {
            if (thumbInFlight.current.get(photo.id) === runId) thumbInFlight.current.delete(photo.id)
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, queue.length) }, () => worker()),
      )
      if (!cancelled) flush()
    }

    void run()
    return () => {
      cancelled = true
      if (flushTimer !== 0) window.clearTimeout(flushTimer)
      // 取消时连「已解码但还没提交」的结果一起丢弃并释放：它们属于被切走的工作区 / 旧 manifest。
      for (const [, url] of buffered) URL.revokeObjectURL(url)
      buffered = []
      /*
       * 把本轮仍挂着的在途标记交还出去。
       *
       * 取消往往发生在「上一轮 worker 还卡在 IPC await」的时刻，而下一轮 effect 的 pending 快照
       * 就在同一次提交里紧接着这次清理计算：若不放行，这些图片会被下一轮当成「已有人在加载」而跳过，
       * 上一轮又已经放弃它们——这几张缩略图会永远停在转圈，直到 manifest 再次变化才解套。
       * 归属检查（owner === runId）保证上一轮的 finally 不会误删下一轮重新登记的标记。
       */
      for (const [id, owner] of thumbInFlight.current) {
        if (owner === runId) thumbInFlight.current.delete(id)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbSignature, workspaceId])

  const selectPhoto = useCallback((photoId: string) => {
    setCurrentId(photoId)
    setSelection((current) => (current.includes(photoId) ? current : [photoId]))
  }, [])

  /** 取消当前选中：图片仍留在工作区，只是不再作为当前修图对象。 */
  const deselect = useCallback(() => {
    setCurrentId(null)
    setSelection([])
  }, [])

  const updateDevelop = useCallback((patch: Partial<WorkspaceDevelop>) => {
    const base = manifestRef.current
    if (!base || !currentId) return
    const photo = findPhoto(base, currentId)
    const develop: WorkspaceDevelop = { ...(photo?.develop ?? createEmptyDevelop()), ...patch }
    queueManifest(applyDevelop(base, currentId, develop))
  }, [currentId, queueManifest])

  const applyRecipeToSelection = useCallback(() => {
    const base = manifestRef.current
    if (!base || !currentId) return
    const result = applyRecipeToPhotos(base, currentId, selection)
    if (result.applied.length === 0) {
      notify('请先选中其他图片，且当前图需要有可套用的配方', 'error')
      return
    }
    queueManifest(result.manifest)
    notify(`已把当前配方套用到 ${result.applied.length} 张图片`)
  }, [currentId, notify, queueManifest, selection])

  const rebuildPlan = useCallback((overrides: Record<string, VolumePolicy>) => {
    importOverrides.current = overrides
    setImportPlan(buildImportPlan({
      paths: importPaths.current,
      volumes: importVolumes.current,
      overrides,
      manifest: manifestRef.current,
      availableBytes: diskSpace.current.availableBytes,
      targetPath: diskSpace.current.path,
    }))
  }, [])

  /**
   * 真正执行导入。确认面板与「无需决策的直接导入」共用这一段，
   * 避免两条路径的落盘/通知逻辑各写一遍而慢慢分叉。
   */
  const runImport = useCallback(async (plan: ImportPlan) => {
    if (importBusy) return
    if (plan.blocked) {
      notify('目标磁盘剩余空间不足：请把对应卷改为直接引用，或先在「设置 → 资料库」更换到容量更大的位置', 'error')
      return
    }
    const entries = toImportEntries(plan)
    if (entries.length === 0) {
      notify('所选图片都已在工作区，无需重复导入')
      setImportPlan(null)
      return
    }

    const jobId = createJobId()
    jobIdRef.current = jobId
    setImportBusy(true)
    setImportFailures([])
    setImporting({
      jobId, phase: 'preparing', copiedBytes: 0, totalBytes: 0,
      copiedFiles: 0, totalFiles: entries.length, percent: 0, currentFile: null,
    })
    try {
      const report = await importWorkspaceFiles(entries, jobId, setImporting, workspaceId)
      adoptManifest(report.manifest)
      setImportPlan(null)
      setImportFailures(report.failed.map((failure) => `${failure.sourcePath}：${failure.error}`))
      const firstImported = report.imported.find((photo) => photo.status === 'ready')
      if (firstImported) setCurrentId((current) => current ?? firstImported.id)
      notify(report.cancelled
        ? `导入已取消，已完成 ${report.imported.length} 张`
        : `导入完成：新增 ${report.imported.length} 张，跳过 ${report.skipped.length} 张，失败 ${report.failed.length} 张`)
      await refreshAbsence()
    } catch (error) {
      notifyError(error, '工作区导入失败')
    } finally {
      setImporting(null)
      setImportBusy(false)
      jobIdRef.current = null
    }
  }, [adoptManifest, importBusy, notify, notifyError, refreshAbsence, workspaceId])

  /**
   * 选文件并组装导入计划。
   *
   * `autoConfirmWhenTrivial` 为真时（内容页 / 左栏的「导入图片」入口），
   * 若这次导入不需要用户决策就直接执行——选完文件应当立刻看到素材进网格，
   * 而不是先弹一个只是把推荐值念一遍的面板。需要决策时仍落到 `importPlan` 等确认。
   */
  const beginImport = useCallback(async (autoConfirmWhenTrivial = false) => {
    try {
      const paths = await pickImagePaths()
      if (paths.length === 0) return
      const [volumes, space] = await Promise.all([classifySourceVolumes(paths), getWorkspaceDiskSpace(workspaceId)])
      importPaths.current = paths
      importVolumes.current = volumes
      diskSpace.current = { availableBytes: space.availableBytes, path: space.path }
      importOverrides.current = {}
      setImportFailures([])

      const plan = buildImportPlan({
        paths,
        volumes,
        overrides: {},
        manifest: manifestRef.current,
        availableBytes: space.availableBytes,
        targetPath: space.path,
      })

      if (autoConfirmWhenTrivial && !needsImportDecision(plan)) {
        setImportPlan(null)
        await runImport(plan)
        return
      }
      setImportPlan(plan)
    } catch (error) {
      notifyError(error, '无法读取所选图片的来源信息')
    }
  }, [notifyError, runImport, workspaceId])

  const changeVolumePolicy = useCallback((volumeId: string, policy: VolumePolicy) => {
    const volume = importVolumes.current.find((candidate) => candidate.volumeId === volumeId)
    // 改判为“引用”只警告一次：此后不再重复打扰。
    if (policy === 'reference' && !warnedReferenceVolumes.has(volumeId)) {
      warnedReferenceVolumes.add(volumeId)
      const accepted = window.confirm(
        `将“${volume?.label ?? volumeId}”改为直接引用：\n\n`
        + `· 该卷当前 ${volume?.fileCount ?? 0} 张图片不会复制到资料库；\n`
        + '· 该设备不在位时，这些图片将不可编辑与导出；\n'
        + '· 这个选择会被记住，下次导入同一设备时不再询问。',
      )
      if (!accepted) return
    }
    // 按卷标识记忆而非盘符，否则换一次盘符就要重问一次。
    void setVolumePolicy(volumeId, policy, volume?.label ?? '').catch(() => undefined)
    rebuildPlan({ ...importOverrides.current, [volumeId]: policy })
  }, [rebuildPlan])

  const confirmImport = useCallback(async () => {
    const plan = importPlan
    if (!plan) return
    await runImport(plan)
  }, [importPlan, runImport])

  const cancelImport = useCallback(() => {
    const jobId = jobIdRef.current
    if (!jobId) {
      setImportPlan(null)
      setImporting(null)
      return
    }
    // 停止后续条目；已复制完成的保留 ready，正在复制的清半成品回 pending。
    void cancelWorkspaceImport(jobId).catch(() => undefined)
  }, [])

  const dismissImport = useCallback(() => {
    if (importBusy) return
    setImportPlan(null)
    setImportFailures([])
    importPaths.current = []
    importVolumes.current = []
    importOverrides.current = {}
  }, [importBusy])

  const clearWorkspace = useCallback(async () => {
    const reclaimable = photos.reduce(
      (total, photo) => total + (photo.origin === 'copy' ? photo.sizeBytes : 0),
      0,
    )
    const accepted = window.confirm(
      '将清空当前工作区：\n\n'
      + `· 删除全部 ${photos.length} 张图片的编辑记录；\n`
      + `· 删除 originals/ 与 references/ 下的副本，预计可回收 ${formatBytes(reclaimable)}；\n`
      + '· 一并清理缩略图缓存。\n\n此操作不可撤销，是否继续？',
    )
    if (!accepted) return
    try {
      const report = await clearWorkspaceNative(workspaceId)
      revokeAll(thumbUrlsRef.current)
      setThumbUrls({})
      thumbInFlight.current.clear()
      analysisCache.current.clear()
      if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url)
      if (referenceRef.current) URL.revokeObjectURL(referenceRef.current.url)
      sourceRef.current = null
      referenceRef.current = null
      setSource(null)
      setSourceData(null)
      setSourceStats(null)
      setReferenceImage(null)
      setReferenceStats(null)
      setCurrentId(null)
      setSelection([])
      // 清空后必须保留当前工作区 id，否则后续写入会落到 default。
      adoptManifest(createEmptyManifest(workspaceId))
      notify(`工作区已清空，回收 ${formatBytes(report.freedBytes)}`)
    } catch (error) {
      notifyError(error, '清空工作区失败')
    }
  }, [adoptManifest, notify, notifyError, photos, workspaceId])

  /**
   * 从工作区删除若干图片（内容页多选批量删除）。
   *
   * 三步顺序不能乱：
   * 1. 先 flush 尚在防抖窗口里的 manifest —— 删除命令改的是磁盘上的 manifest，
   *    若本地还留着一份旧快照，它随后会以旧 revision 写回去，删掉的图就又回来了；
   * 2. 交给后端删除（后端自己持锁、自增 revision，并回收工作区副本）；
   * 3. 按被删的 id 释放缩略图 objectURL 与分析缓存 —— 否则内存里会留下再也点不到的幽灵图。
   */
  const removePhotos = useCallback(async (photoIds: string[]): Promise<boolean> => {
    const wanted = [...new Set(photoIds)]
    const base = manifestRef.current
    if (!base || wanted.length === 0) return false
    const targets = base.photos.filter((photo) => wanted.includes(photo.id))
    if (targets.length === 0) return false

    const copiedCount = targets.filter((photo) => photo.origin === 'copy').length
    const reclaimable = reclaimableBytesForRemoval(base.photos, wanted)
    const accepted = window.confirm(
      `将从当前工作区移除 ${targets.length} 张图片：\n\n`
      + '· 删除它们的编辑记录与缩略图缓存；\n'
      + (copiedCount ? `· 删除 originals/ 下的 ${copiedCount} 份副本，预计回收 ${formatBytes(reclaimable)}；\n` : '')
      + '· 不会删除磁盘上的原始照片，也不影响其他工作区。\n\n此操作不可撤销，是否继续？',
    )
    if (!accepted) return false

    // 先把没落盘的本地改动写出去：删除命令返回的 manifest 会直接接管，否则这些改动就没了。
    if (writeTimer.current !== null) {
      window.clearTimeout(writeTimer.current)
      writeTimer.current = null
    }
    if (manifestDirty.current) await flushManifest()

    try {
      const report = await deleteWorkspacePhotos(wanted, workspaceId)
      const removed = new Set(report.removedPhotoIds)
      const next = adoptManifest(report.manifest)

      const remainingUrls: Record<string, string> = {}
      for (const [id, url] of Object.entries(thumbUrlsRef.current)) {
        if (removed.has(id)) {
          URL.revokeObjectURL(url)
          continue
        }
        remainingUrls[id] = url
      }
      thumbUrlsRef.current = remainingUrls
      setThumbUrls(remainingUrls)
      for (const id of removed) {
        thumbInFlight.current.delete(id)
        analysisCache.current.delete(id)
      }

      setCurrentId((current) => nextCurrentIdAfterRemoval(next.photos, removed, current))
      setSelection((current) => current.filter((id) => !removed.has(id)))
      notify(`已从工作区移除 ${report.removedPhotoIds.length} 张图片，回收 ${formatBytes(report.freedBytes)}`)
      await refreshAbsence()
      return true
    } catch (error) {
      notifyError(error, '删除图片失败')
      return false
    }
  }, [adoptManifest, flushManifest, notify, notifyError, refreshAbsence, workspaceId])

  /** 单图入口（选择原片 / 拖入 / 文件输入）统一汇入工作区，避免两套真相源。 */
  const importSinglePath = useCallback(async (path: string, origin?: VolumePolicy) => {
    const [volume] = await classifySourceVolumes([path])
    if (!volume) throw new Error('无法识别图片来源')
    const relative = relativeWithinVolume(path, volume.rootPath) || path.split(/[\\/]/).pop() || path
    const policy = origin ?? volume.recommendation
    const jobId = createJobId()
    setImportBusy(true)
    setImporting({
      jobId, phase: 'preparing', copiedBytes: 0, totalBytes: 0,
      copiedFiles: 0, totalFiles: 1, percent: 0, currentFile: null,
    })
    try {
      const report = await importWorkspaceFiles(
        [{ sourcePath: path, volumeId: volume.volumeId, relativeSourcePath: relative, targetRelative: relative, origin: policy }],
        jobId,
        setImporting,
        workspaceId,
      )
      adoptManifest(report.manifest)
      const imported = report.imported[0]
      if (imported) setCurrentId(imported.id)
      notify(policy === 'copy' ? '图片已复制到工作区并载入' : '图片已加入工作区并载入')
    } finally {
      setImporting(null)
      setImportBusy(false)
    }
  }, [adoptManifest, notify, workspaceId])

  /** 浏览器预览没有本机路径，只能作为临时当前图载入。 */
  const importSingleFile = useCallback(async (file: File) => {
    const loaded = await loadImageFile(file)
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url)
    sourceRef.current = loaded
    setSource(loaded)
    const data = await imageToImageDataAsync(loaded.element, ANALYSIS_MAX_SIDE)
    setSourceData(data)
    setSourceStats(analyzeImageData(data))
    notify('图片已载入当前编辑（未能获取本机路径，未写入工作区）')
  }, [notify])

  const setReferenceFromPath = useCallback(async (path: string) => {
    const [volume] = await classifySourceVolumes([path])
    if (!volume) throw new Error('无法识别参考图来源')
    const relative = relativeWithinVolume(path, volume.rootPath) || path.split(/[\\/]/).pop() || path
    const saved = await importWorkspaceReference({
      sourcePath: path,
      volumeId: volume.volumeId,
      relativeSourcePath: relative,
      targetRelative: relative,
      origin: volume.recommendation,
    }, null, workspaceId)
    adoptManifest(saved)
    notify('参考图已设为工作区共享参考')
  }, [adoptManifest, notify, workspaceId])

  const setReferenceFromFile = useCallback(async (file: File) => {
    const loaded = await loadImageFile(file)
    if (referenceRef.current) URL.revokeObjectURL(referenceRef.current.url)
    referenceRef.current = loaded
    setReferenceImage(loaded)
    const data = await imageToImageDataAsync(loaded.element, ANALYSIS_MAX_SIDE)
    setReferenceStats(analyzeImageData(data))
    notify('参考图已载入当前编辑（未能获取本机路径，未写入工作区）')
  }, [notify])

  const clearReference = useCallback(async () => {
    const base = manifestRef.current
    if (!base) return
    if (referenceRef.current) URL.revokeObjectURL(referenceRef.current.url)
    referenceRef.current = null
    setReferenceImage(null)
    setReferenceStats(null)
    manifestRef.current = { ...base, reference: null }
    setManifest(manifestRef.current)
    await flushManifest()
    notify('已清除工作区参考图')
  }, [flushManifest, notify])

  const dismissAbsentVolume = useCallback((volumeId: string) => {
    setAbsentVolumes((current) => current.filter((volume) => volume.volumeId !== volumeId))
  }, [])

  /** 卷缺席汇总条上的「改为复制」：要求设备已连接，否则明确失败而不是静默无效。 */
  const convertVolumeToCopy = useCallback(async (volumeId: string) => {
    const base = manifestRef.current
    if (!base) return
    const targets = base.photos.filter(
      (photo) => photo.volumeId === volumeId && photo.origin === 'reference' && photo.status !== 'ready',
    )
    const pending = base.photos.filter((photo) => photo.volumeId === volumeId && photo.origin === 'reference')
    if (pending.length === 0) {
      notify('该卷没有需要转为复制的图片')
      return
    }
    const mount = await resolveVolumeMount(volumeId)
    if (!mount) {
      // 卷不在位就不能复制——文案必须是“请连接设备”，而不是“文件已被删除”。
      notify(`请先连接该设备（${volumeId}）后再改为复制`, 'error')
      return
    }
    const entries = pending
      .map((photo) => {
        const absolute = `${mount}${mount.endsWith('\\') || mount.endsWith('/') ? '' : '/'}${photo.relativeSourcePath}`
        return {
          sourcePath: photo.sourcePath || absolute,
          volumeId,
          relativeSourcePath: photo.relativeSourcePath,
          targetRelative: photo.relativeSourcePath,
          origin: 'copy' as const,
        }
      })
      .filter((entry) => entry.relativeSourcePath.length > 0)
    if (entries.length === 0) return

    void setVolumePolicy(volumeId, 'copy').catch(() => undefined)
    const jobId = createJobId()
    setImportBusy(true)
    try {
      const report = await importWorkspaceFiles(entries, jobId, setImporting, workspaceId)
      adoptManifest(report.manifest)
      notify(`已把 ${report.imported.length} 张图片转为副本${targets.length ? `，失败 ${targets.length - report.imported.length} 张` : ''}`)
      await refreshAbsence()
    } catch (error) {
      notifyError(error, '转为复制失败')
    } finally {
      setImporting(null)
      setImportBusy(false)
    }
  }, [adoptManifest, notify, notifyError, refreshAbsence, workspaceId])

  /**
   * 卷缺席汇总条上的「重新定位」：源文件被移动、卷标识无法匹配时的兜底。
   * 选定新根目录后按卷内相对路径逐张重挂，保留原 volumeId，因此身份与缩略图缓存都不失效。
   */
  const relocateVolume = useCallback(async (volumeId: string) => {
    const base = manifestRef.current
    if (!base) return
    const affected = base.photos.filter((photo) => photo.volumeId === volumeId && photo.origin === 'reference')
    if (affected.length === 0) {
      notify('该卷没有需要重新定位的图片')
      return
    }
    const root = await pickDirectory('选择该设备 / 文件夹的新位置')
    if (!root) return
    const photos = base.photos.map((photo) => {
      if (photo.volumeId !== volumeId || photo.origin !== 'reference') return photo
      return { ...photo, sourcePath: joinPath(root, photo.relativeSourcePath) }
    })
    adoptManifest({ ...base, photos })
    await flushManifest()
    await refreshAbsence()
    notify(`已把 ${affected.length} 张图片重新定位到 ${root}`)
  }, [adoptManifest, flushManifest, notify, refreshAbsence])

  return {
    ready,
    manifest,
    photos,
    currentPhoto,
    currentId,
    selection,
    source,
    sourceData,
    sourceStats,
    reference: { entry: referenceEntry, image: referenceImage, stats: referenceStats },
    loadingCurrent,
    thumbUrls,
    absentVolumes,
    importing,
    importPlan,
    importBusy,
    importFailures,
    selectPhoto,
    deselect,
    setSelection,
    updateDevelop,
    applyRecipeToSelection,
    beginImport,
    changeVolumePolicy,
    confirmImport,
    cancelImport,
    dismissImport,
    clearWorkspace,
    removePhotos,
    importSinglePath,
    importSingleFile,
    setReferenceFromPath,
    setReferenceFromFile,
    clearReference,
    dismissAbsentVolume,
    convertVolumeToCopy,
    relocateVolume,
    refresh,
  }
}
