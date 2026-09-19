import {
  Aperture, ArrowRight, Check, ChevronDown, CircleHelp, CloudCog, Download, FolderKanban,
  LoaderCircle, LockKeyhole, LayoutGrid, Minus, Moon, Palette, RotateCcw, Save, ScanSearch, Settings2, SlidersHorizontal,
  Sparkles, Square, Sun, Upload, WandSparkles, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { AiColorWorkspace, type AiColorWorkspaceHandle } from './components/AiColorWorkspace'
import {
  afterLayerStyle, CompareDivider, CompareModeControls, CompareSlider, previewFrameClass,
  type CompareMode,
} from './components/CompareModeControls'
import { LibrarySettingsPanel } from './components/LibrarySettingsPanel'
import { ModelSettingsWorkspace } from './components/ModelSettingsWorkspace'
import { Control } from './components/Control'
import { Filmstrip } from './components/Filmstrip'
import { Histogram } from './components/Histogram'
import { ImportConfirmPanel } from './components/ImportConfirmPanel'
import { FineTunePanels } from './components/FineTunePanels'
import { ImageDrop } from './components/ImageDrop'
import { VolumeBanner } from './components/VolumeBanner'
import { WorkspaceContentPage } from './components/WorkspaceContentPage'
import {
  createMatchProfile, createModelMatchContext, processImageData, suggestMatchControls,
} from './lib/colorEngine'
import {
  analyzeWithModel, createWorkspace, DEFAULT_WORKSPACE_ID, deleteWorkspace, hasProviderApiKey, isTauri, listWorkspaces,
  loadModelSettings, openWorkspaceFolder, persistModelSettings, pickImagePath, readWorkspaceManifest,
  refineMatchWithModel, renameWorkspace, revealPhotoLocation, saveJpegNative,
} from './lib/desktop'
import { exportGradedImage } from './lib/exportImage'
import {
  canvasToBlob, drawImageDataToCanvas, imageToDataUrl, imageToViewportImageData, isViewportMeasured,
} from './lib/files'
import { createDefaultAdjustments, DEFAULT_MODEL_SETTINGS } from './lib/defaults'
import { applyFineTuneModuleVisibility, type FineTuneModuleVisibility } from './lib/fineTuneVisibility'
import { GpuPreviewRenderer } from './lib/gpuPreview'
import { resolveImageModel, resolveVisionModel } from './lib/modelSettings'
import type {
  Adjustments, ColorStats, MatchProfile, ModelColorParameters, ModelSettings, WorkspaceDevelop, WorkspaceInfo,
} from './lib/types'
import { useElementSize } from './lib/useElementSize'
import { createEmptyDevelop } from './lib/workspace'
import { useWorkspace } from './lib/useWorkspace'
import './styles.css'

type Panel = 'match' | 'adjust'
/**
 * 'content' 是工作区内容页（看该工作区的素材），位于「工作区列表页」与「修图菜单」之间。
 * 点工作区卡片先落到它，而不是直接跳进追色——否则用户会丢掉「进了哪个区、里面有什么」的上下文。
 */
type WorkspaceMode = 'workspaces' | 'content' | 'match' | 'grade' | 'settings'
type SettingsSection = 'appearance' | 'library' | 'model'
type ThemeMode = 'light' | 'dark'
type Toast = { message: string; kind: 'ok' | 'error' }
type ImageKind = 'source' | 'reference'
type MatchRenderMode = 'none' | 'local' | 'ai'
type PreviewEngine = 'initializing' | 'gpu' | 'error'

/** 记住上次进入的工作区，重启后直接恢复；失效时由 listWorkspaces 结果比对清除。 */
const ACTIVE_WORKSPACE_KEY = 'chroma-trace-active-workspace'

const tabs: Array<{ id: Panel; label: string; icon: typeof Sparkles }> = [
  { id: 'match', label: 'AI 追色', icon: ScanSearch },
  { id: 'adjust', label: '精细调整', icon: SlidersHorizontal },
]


function toHex(stats?: ColorStats | null) {
  if (!stats) return '#2b2d2a'
  return `#${stats.mean.map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
}

/** 本地编辑状态与图片 develop 是否一致；一致就不必再写盘。 */
function sameDevelop(left: WorkspaceDevelop, right: WorkspaceDevelop) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function imageDataToDataUrl(imageData: ImageData, quality = .9) {
  const canvas = document.createElement('canvas')
  drawImageDataToCanvas(canvas, imageData)
  return canvas.toDataURL('image/jpeg', quality)
}

interface WorkspacesPageProps {
  workspaces: WorkspaceInfo[]
  activeWorkspaceId: string | null
  loaded: boolean
  onEnter: (id: string) => void
  onCreate: (name: string) => void | Promise<void>
  onRename: (id: string, name: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
  onNotify: (message: string, kind?: 'ok' | 'error') => void
}

/**
 * 一级页：工作区列表（文件夹语义）。
 *
 * 张数与封面按需读各工作区的 manifest 惰性补全，因此注册表只需承载名称，
 * 不会因为素材变动而与 manifest 产生一致性负担。
 */
function WorkspacesPage({
  workspaces, activeWorkspaceId, loaded, onEnter, onCreate, onRename, onDelete, onNotify,
}: WorkspacesPageProps) {
  const [counter, setCounter] = useState<Record<string, { count: number; cover: string | null }>>({})
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  // 惰性补全每卡片的张数与封面（取第一张 ready 图的缩略图键）。
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const entries = await Promise.all(workspaces.map(async (entry) => {
        try {
          const manifest = await readWorkspaceManifest(entry.id)
          const first = manifest.photos[0] ?? null
          return [entry.id, { count: manifest.photos.length, cover: first?.thumbKey ?? null }] as const
        } catch {
          return [entry.id, { count: 0, cover: null }] as const
        }
      }))
      if (!cancelled) setCounter(Object.fromEntries(entries))
    }
    if (workspaces.length) void load()
    return () => { cancelled = true }
  }, [workspaces])

  const submitCreate = () => {
    const name = draftName.trim()
    if (!name) return
    void onCreate(name)
    setDraftName('')
    setCreating(false)
  }

  const submitRename = (id: string) => {
    const name = renameDraft.trim()
    setRenamingId(null)
    if (name) void onRename(id, name)
  }

  return (
    <main className="workspaces-page">
      <header className="workspaces-page__head">
        <div>
          <h1>工作区</h1>
        </div>
        <button type="button" className="button button--accent" onClick={() => setCreating(true)}>
          <Upload size={15} /> 新建工作区
        </button>
      </header>

      {creating ? (
        <div className="workspace-create-row">
          <input
            autoFocus
            className="text-input"
            placeholder="工作区名称，例如：风光精选"
            value={draftName}
            maxLength={48}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitCreate()
              if (event.key === 'Escape') { setCreating(false); setDraftName('') }
            }}
          />
          <button type="button" className="button button--accent" onClick={submitCreate}>创建</button>
          <button type="button" className="button button--ghost" onClick={() => { setCreating(false); setDraftName('') }}>取消</button>
        </div>
      ) : null}

      {!loaded ? (
        <div className="workspaces-page__empty"><LoaderCircle className="spin" size={18} /><span>正在载入工作区…</span></div>
      ) : workspaces.length === 0 ? (
        <div className="workspaces-page__empty">
          <LayoutGrid size={20} />
          <span>还没有工作区</span>
        </div>
      ) : (
        <div className="workspaces-grid">
          {workspaces.map((entry) => {
            const stats = counter[entry.id]
            const isActive = entry.id === activeWorkspaceId
            return (
              <article key={entry.id} className={`workspace-card ${isActive ? 'is-active' : ''}`}>
                <button type="button" className="workspace-card__open" onClick={() => onEnter(entry.id)}>
                  <span className="workspace-card__cover" aria-hidden="true">
                    <FolderKanban size={26} />
                  </span>
                  <span className="workspace-card__body">
                    {renamingId === entry.id ? (
                      <input
                        autoFocus
                        className="text-input"
                        value={renameDraft}
                        maxLength={48}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onBlur={() => submitRename(entry.id)}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === 'Enter') submitRename(entry.id)
                          if (event.key === 'Escape') setRenamingId(null)
                        }}
                      />
                    ) : (
                      <strong>{entry.name}</strong>
                    )}
                    <em>{stats ? `${stats.count} 张` : '读取中…'}</em>
                  </span>
                </button>
                <div className="workspace-card__actions">
                  {isActive ? <span className="workspace-card__badge">当前</span> : null}
                  <button
                    type="button"
                    className="icon-button"
                    title="重命名"
                    onClick={() => { setRenamingId(entry.id); setRenameDraft(entry.name) }}
                  ><Save size={14} /></button>
                  <button
                    type="button"
                    className="icon-button"
                    title={workspaces.length <= 1 ? '至少需要保留一个工作区' : '删除工作区'}
                    disabled={workspaces.length <= 1}
                    onClick={() => {
                      const count = counter[entry.id]?.count ?? 0
                      onNotify(`将删除工作区「${entry.name}」及其 ${count} 张编辑记录，此操作不可撤销`, 'error')
                      if (window.confirm(`删除工作区「${entry.name}」？\n\n· 删除 ${count} 张图片的编辑记录；\n· 删除 originals/ 与 references/ 下的副本；\n· 一并清理缩略图缓存。\n\n此操作不可撤销，是否继续？`)) {
                        void onDelete(entry.id)
                      }
                    }}
                  ><X size={14} /></button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </main>
  )
}

function App() {
  const [toast, setToast] = useState<Toast | null>(null)
  const notify = useCallback((message: string, kind: Toast['kind'] = 'ok') => {
    setToast({ message, kind })
  }, [])

  // 工作区是图像状态的唯一真相源：source / sourceData / sourceStats / reference 全部由它派生。
  // 两套编辑工作区（AI 追色 / AI 调色）继续共用同一个 source，避免出现第二套真相源。
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(() => {
    const stored = window.localStorage.getItem(ACTIVE_WORKSPACE_KEY)
    return stored && stored.trim() ? stored : null
  })
  const [workspaceSwitchPending, setWorkspaceSwitchPending] = useState<string | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  /**
   * 内容页里「高亮」的素材。它只是浏览态的选择，**不驱动全尺寸载入**——
   * 载入发生在进入修图菜单时（openPhotoInEditor）。这样在网格里单击浏览
   * 不会每次都跑一遍完整 RAW 显影（Rust 侧不可取消，连点会堆积）。
   *
   * 放 App 层而非内容页内部，是为了让顶部的「AI 追色 / AI 调色」也知道
   * 高亮的是哪张，保证「高亮的那张 = 即将修的那张」。
   */
  const [contentSelection, setContentSelection] = useState<string | null>(null)
  const switcherRef = useRef<HTMLDivElement>(null)
  const workspace = useWorkspace(notify, activeWorkspaceId ?? DEFAULT_WORKSPACE_ID)
  const source = workspace.source
  const sourceData = workspace.sourceData
  const sourceStats = workspace.sourceStats
  const reference = workspace.reference.image
  const referenceStats = workspace.reference.stats
  const [adjustments, setAdjustments] = useState<Adjustments>(createDefaultAdjustments)
  const [fineTuneVisibility, setFineTuneVisibility] = useState<FineTuneModuleVisibility>({})
  const [panel, setPanel] = useState<Panel>('match')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('match')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance')
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => window.localStorage.getItem('chroma-trace-theme') === 'light' ? 'light' : 'dark')
  const [compare, setCompare] = useState(50)
  const [compareMode, setCompareMode] = useState<CompareMode>('wipe')
  const [previewEngine, setPreviewEngine] = useState<PreviewEngine>('initializing')
  const [exporting, setExporting] = useState(false)
  const [matchRenderMode, setMatchRenderMode] = useState<MatchRenderMode>('none')
  const [modelTask, setModelTask] = useState<'idle' | 'analyze' | 'refine'>('idle')
  const [modelSettings, setModelSettings] = useState<ModelSettings>(DEFAULT_MODEL_SETTINGS)
  const [credentialStatus, setCredentialStatus] = useState<Record<string, boolean>>({})
  const [modelStyle, setModelStyle] = useState('')
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [gradeExportState, setGradeExportState] = useState({ canExport: false, exporting: false })
  const [windowMaximized, setWindowMaximized] = useState(false)
  const originalCanvas = useRef<HTMLCanvasElement>(null)
  const gpuResultCanvas = useRef<HTMLCanvasElement>(null)
  const gpuPreviewRenderer = useRef<GpuPreviewRenderer | null>(null)
  const previewFrame = useRef<number | null>(null)
  const pendingGpuPreview = useRef<{ adjustments: Adjustments; profile: MatchProfile | null } | null>(null)
  const browserSourceInput = useRef<HTMLInputElement>(null)
  const workspaceModeRef = useRef<WorkspaceMode>('match')
  const aiColorWorkspaceRef = useRef<AiColorWorkspaceHandle>(null)
  const helpMenuRef = useRef<HTMLDivElement>(null)
  const matchPreviewFrameRef = useRef<HTMLDivElement>(null)
  /**
   * 已按当前图片 develop 播种过本地编辑状态的 key，避免重复播种覆盖用户输入。
   *
   * key 必须带工作区前缀：photoId = sha1(volumeId + "|" + relativeSourcePath) 与工作区无关，
   * 同一张图在两个工作区里 id 相同。只按 photoId 记账会让切区后的播种被跳过，
   * 使新区继承上一个区的滑块值（manifest 才是真相源，本地状态只是镜像）。
   */
  const seededPhotoRef = useRef<string | null>(null)
  const currentIdRef = useRef<string | null>(null)
  const currentDevelopRef = useRef<WorkspaceDevelop | null>(null)

  workspaceModeRef.current = workspaceMode
  currentIdRef.current = workspace.currentId
  currentDevelopRef.current = workspace.currentPhoto?.develop ?? null

  // ---------------------------------------------------------------------------
  // 工作区注册表与切换
  // ---------------------------------------------------------------------------

  /**
   * 拉取工作区列表，并校验 localStorage 里记住的 id 是否仍然存在。
   *
   * 注册表由 Rust 侧维护（`library_root/workspaces.json`），首次运行会以现有 `default`
   * 目录播种，因此这里不需要为「default 不存在」做特殊处理。失效 id 会被清除，
   * 使 `canUseEditor` 落回 false，从而拦住修图菜单。
   */
  const refreshWorkspaces = useCallback(async () => {
    try {
      const list = await listWorkspaces()
      setWorkspaces(list)
      const stored = window.localStorage.getItem(ACTIVE_WORKSPACE_KEY)
      if (stored && !list.some((entry) => entry.id === stored)) {
        window.localStorage.removeItem(ACTIVE_WORKSPACE_KEY)
        setActiveWorkspaceId(null)
      } else if (!stored && list.length === 1) {
        // 只有一个工作区时直接进入，避免首次运行的死胡同体验。
        window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, list[0].id)
        setActiveWorkspaceId(list[0].id)
      }
      return list
    } catch (error) {
      notify(errorMessage(error, '工作区列表载入失败'), 'error')
      return []
    } finally {
      setWorkspacesLoaded(true)
    }
  }, [notify])

  useEffect(() => { void refreshWorkspaces() }, [refreshWorkspaces])

  /** 修图菜单准入：必须已进入一个真实存在的工作区。空工作区不拦（左栏可导入）。 */
  const canUseEditor = activeWorkspaceId !== null
    && workspaces.some((entry) => entry.id === activeWorkspaceId)

  /**
   * 未进入任何工作区时，修图菜单是禁用态——此时必须把用户落在工作区列表页，
   * 否则开局就是一个点不动的修图界面。
   */
  useEffect(() => {
    if (!workspacesLoaded) return
    if (!canUseEditor && workspaceMode !== 'workspaces') setWorkspaceMode('workspaces')
  }, [workspacesLoaded, canUseEditor, workspaceMode])

  const activeWorkspace = useMemo(
    () => workspaces.find((entry) => entry.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  )

  /**
   * 进入指定工作区的内容页（列表页点卡片 / 下拉直切 / 从修图返回共用）。
   * 只切工作区，不改修图菜单——留在哪个修图页由调用方后续决定。
   */
  const enterWorkspace = useCallback((id: string) => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, id)
    setActiveWorkspaceId(id)
    // 高亮属于「上一个区浏览到哪」的临时状态，切区必须清掉，否则会指向新区里不存在的图。
    setContentSelection(null)
    setWorkspaceMode('content')
  }, [])

  /** 从内容页进入修图菜单：选中该素材并切到对应工作区。 */
  const openPhotoInEditor = useCallback((photoId: string, target: 'match' | 'grade') => {
    workspace.selectPhoto(photoId)
    if (target === 'match') { setWorkspaceMode('match'); setPanel('match') }
    else setWorkspaceMode('grade')
  }, [workspace.selectPhoto])

  /**
   * 顶部修图菜单按钮。在内容页时先确定要打开哪张——
   * 否则会出现「我明明点了这张，切过去却是另一张」。
   * 取不到任何素材时（0 张的工作区）直接切模式，让舞台显示自己的空态。
   */
  const openEditorFromNav = useCallback((target: 'match' | 'grade') => {
    if (workspaceMode === 'content') {
      const exists = (id: string | null | undefined) => id && workspace.photos.some((photo) => photo.id === id)
      // 本次高亮 → 工作区记住的那张 → 第一张。逐级回落，且必须确认仍在 photos 里，
      // 否则拿一个已失效的 id 去载入只会得到一条错误提示。
      const highlighted = [contentSelection, workspace.currentId].find(exists) ?? workspace.photos[0]?.id
      if (highlighted) {
        openPhotoInEditor(highlighted, target)
        return
      }
    }
    if (target === 'match') { setWorkspaceMode('match'); setPanel('match') }
    else setWorkspaceMode('grade')
  }, [contentSelection, openPhotoInEditor, workspace.currentId, workspace.photos, workspaceMode])

  /** 点下拉里的另一个工作区：先弹确认，确认后才真正切换。 */
  const requestWorkspaceSwitch = useCallback((id: string) => {
    if (id === activeWorkspaceId) {
      setSwitcherOpen(false)
      return
    }
    setSwitcherOpen(false)
    setWorkspaceSwitchPending(id)
  }, [activeWorkspaceId])

  const confirmWorkspaceSwitch = useCallback(() => {
    const id = workspaceSwitchPending
    setWorkspaceSwitchPending(null)
    if (!id) return
    enterWorkspace(id)
  }, [workspaceSwitchPending, enterWorkspace])

  // 下拉/确认框点击外部关闭。
  useEffect(() => {
    if (!switcherOpen && !workspaceSwitchPending) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (switcherOpen && !switcherRef.current?.contains(target)) setSwitcherOpen(false)
      if (workspaceSwitchPending && !(target as HTMLElement).closest?.('.workspace-switch-confirm')) {
        setWorkspaceSwitchPending(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSwitcherOpen(false)
        setWorkspaceSwitchPending(null)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [switcherOpen, workspaceSwitchPending])

  const matchFrameSize = useElementSize(matchPreviewFrameRef, workspaceMode === 'match' && Boolean(source))
  const [stableMatchFrame, setStableMatchFrame] = useState(matchFrameSize)
  /** 是否已经拿到过一次真实尺寸（见下：首次测量立即提交，此后才做 80ms 抖动抑制）。 */
  const matchFrameMeasuredRef = useRef(false)
  useEffect(() => {
    // 首次真实测量立即提交。进页面时再等一个 80ms 防抖窗口没有收益——此前根本没有尺寸可比，
    // 只会把照片首帧整体推后一个防抖周期；抖动抑制只对「已有尺寸之后再变化」才有意义。
    if (!matchFrameMeasuredRef.current && isViewportMeasured(matchFrameSize.width, matchFrameSize.height)) {
      matchFrameMeasuredRef.current = true
      setStableMatchFrame(matchFrameSize)
      return
    }
    const timer = window.setTimeout(() => setStableMatchFrame(matchFrameSize), 80)
    return () => window.clearTimeout(timer)
  }, [matchFrameSize.width, matchFrameSize.height])
  /** Viewport-matched pixels for BEFORE/AFTER (not the analysis thumbnail). */
  const matchPreviewData = useMemo(() => {
    /*
     * 只在追色菜单里算。它是对 4096px 的图做高质量 drawImage + getImageData，全程同步阻塞主线程；
     * 而它只被 match 的预览与合成路径消费（下方几个 workspaceMode !== 'match' 直接 return 的 effect、
     * 以及 stage 底栏）。放在内容页算等于白冻一次界面。
     */
    if (workspaceMode !== 'match' || !source) return null
    // 尺寸未测量时直接不画（阈值与 computeViewportPreviewSize 一致）：此时它必然走 1920px 回退分支，
    // 对原图同步 drawImage + getImageData（实测单次阻塞 200–320ms），而这一帧随后必被真实尺寸的
    // 结果替换——等于每次进追色页白冻一次主线程。
    if (!isViewportMeasured(stableMatchFrame.width, stableMatchFrame.height)) return null
    return imageToViewportImageData(source.element, stableMatchFrame.width, stableMatchFrame.height)
  }, [workspaceMode, source, stableMatchFrame.width, stableMatchFrame.height])

  const profile = useMemo(
    () => sourceStats && referenceStats
      ? createMatchProfile(sourceStats, referenceStats)
      : null,
    [sourceStats, referenceStats],
  )

  // 切图：把该图的 develop 播种到本地编辑状态。manifest 是唯一真相源，本地状态只是镜像，
  // 因此不存在“切图时提交参数”这一步，也就不会“忘记保存就切图”而丢参数。
  useEffect(() => {
    const photoId = workspace.currentId
    if (!photoId) return
    const seedKey = `${activeWorkspaceId ?? DEFAULT_WORKSPACE_ID}|${photoId}`
    if (seededPhotoRef.current === seedKey) return
    seededPhotoRef.current = seedKey
    const develop = workspace.currentPhoto?.develop ?? createEmptyDevelop()
    setAdjustments(develop.adjustments)
    setFineTuneVisibility(develop.fineTuneVisibility)
    setMatchRenderMode(develop.matchRenderMode)
    setModelStyle(develop.modelStyle)
  }, [workspace.currentId, workspace.currentPhoto, activeWorkspaceId])

  // 参数变化直接写回 photos[currentId].develop（hook 内 400ms 防抖合并写入）。
  // 同样带工作区前缀：切区瞬间 currentIdRef 已被清空，写入不会串到新区。
  const updateDevelop = workspace.updateDevelop
  useEffect(() => {
    const photoId = currentIdRef.current
    if (!photoId) return
    if (seededPhotoRef.current !== `${activeWorkspaceId ?? DEFAULT_WORKSPACE_ID}|${photoId}`) return
    const next: WorkspaceDevelop = { adjustments, fineTuneVisibility, matchRenderMode, modelStyle }
    const current = currentDevelopRef.current
    if (current && sameDevelop(current, next)) return
    updateDevelop(next)
  }, [adjustments, fineTuneVisibility, matchRenderMode, modelStyle, updateDevelop, activeWorkspaceId])
  const activeVisionModel = useMemo(() => resolveVisionModel(modelSettings), [modelSettings])
  const activeImageModel = useMemo(() => resolveImageModel(modelSettings), [modelSettings])
  const visionApiKeyPresent = activeVisionModel ? Boolean(credentialStatus[activeVisionModel.providerId]) : false
  const imageApiKeyPresent = activeImageModel ? Boolean(credentialStatus[activeImageModel.providerId]) : false
  const activeMatchProfile = matchRenderMode === 'local' ? profile : null
  const visibleAdjustments = useMemo(
    () => applyFineTuneModuleVisibility(adjustments, fineTuneVisibility),
    [adjustments, fineTuneVisibility],
  )
  const hasResult = Boolean(sourceData && matchRenderMode !== 'none')
  const modelBusy = modelTask !== 'idle'
  const matchMethodLabel = matchRenderMode === 'ai'
    ? 'AI 语义配方 · 本地渲染'
    : matchRenderMode === 'local'
      ? '本地统计快速匹配'
      : '等待执行'
  const currentStyleLabel = modelStyle || matchMethodLabel
  const canvasEngineLabel = matchRenderMode === 'ai'
    ? 'AI 配方 · 本地渲染'
    : matchRenderMode === 'local'
      ? '本地 OKLab 迁移'
      : '基础'
  const helpContent = workspaceMode === 'match'
    ? {
        title: '如何使用 AI 追色',
        steps: ['选择待调整的原片与色彩参考图。', '优先运行 AI 语义追色；本地快速匹配仅适合场景和光线接近的图片。', '按需进行 AI 二次校正和精细调整，然后从顶栏导出。'],
        note: 'AI 语义追色会区分场景环境与可迁移风格，不使用同图像素对应。',
      }
    : workspaceMode === 'grade'
      ? {
          title: '如何使用 AI 调色',
          steps: ['选择照片，并选择参数调色或图生图路径。', '输入目标风格，生成并选择一个调色配方。', '在右侧切换到精细调整，完成后从顶栏导出。'],
          note: '参数调色的最终像素由本地 Canvas 生成；图生图路径可能改变局部细节。',
        }
      : {
          title: '设置使用说明',
          steps: ['在左侧选择需要配置的设置模块。', '进入模型设置，配置服务地址、模型与 API Key。', '保存后运行连接测试，再按需启用模型能力。'],
          note: 'API Key 保存在系统凭据存储中，不会写入前端配置文件。',
        }
  const canExport = workspaceMode === 'match'
    ? Boolean(source && reference && hasResult)
    : workspaceMode === 'grade' && gradeExportState.canExport
  /** 只有两个修图菜单才有「帮助 / 导出」；内容页与列表页都不该出现这两个入口。 */
  const isEditorMode = workspaceMode === 'match' || workspaceMode === 'grade'
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
    if (!isTauri()) return
    // 桌面端只有一体化窗口一种形态：清掉旧版的窗口样式偏好，并确保系统标题栏保持关闭。
    window.localStorage.removeItem('chroma-trace-integrated-window')
    void getCurrentWindow().setDecorations(false).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    const appWindow = getCurrentWindow()
    let unlisten: (() => void) | undefined
    void appWindow.isMaximized().then(setWindowMaximized).catch(() => undefined)
    void appWindow.onResized(() => {
      void appWindow.isMaximized().then(setWindowMaximized).catch(() => undefined)
    }).then((fn) => { unlisten = fn }).catch(() => undefined)
    return () => unlisten?.()
  }, [])

  const windowControl = async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    if (!isTauri()) return
    const appWindow = getCurrentWindow()
    try {
      if (action === 'minimize') await appWindow.minimize()
      else if (action === 'toggleMaximize') await appWindow.toggleMaximize()
      else await appWindow.close()
    } catch {
      // Window controls are best-effort in constrained hosts.
    }
  }

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
    if (workspaceMode !== 'match' || !matchPreviewData || !originalCanvas.current) return
    // 依赖必须带 sourceData：BEFORE canvas 由 `sourceData` 门禁挂载，而它与派生数据不同步到位
    // （source 先到，sourceData 隔一帧才到）。缺这一项时，只要 canvas 晚于派生数据挂载，
    // 就再没有任何事件把它画出来——舞台会一直空着。
    drawImageDataToCanvas(originalCanvas.current, matchPreviewData)
  }, [workspaceMode, matchPreviewData, sourceData])

  useEffect(() => {
    if (workspaceMode !== 'match' || !matchPreviewData || !gpuResultCanvas.current) return

    setPreviewEngine('initializing')
    let renderer: GpuPreviewRenderer | null = null
    let initializationFrame: number | null = null
    let disposed = false
    const canvas = gpuResultCanvas.current
    const sourceImage = matchPreviewData
    const initialAdjustments = visibleAdjustments
    const initialProfile = activeMatchProfile

    const paintCpuPreview = () => {
      drawImageDataToCanvas(canvas, processImageData(sourceImage, initialAdjustments, initialProfile))
    }

    const fallbackToCpu = (error: unknown) => {
      console.error('WebGL2 preview failed; falling back to CPU.', error)
      renderer?.dispose()
      renderer = null
      gpuPreviewRenderer.current = null
      if (!disposed) {
        paintCpuPreview()
        setPreviewEngine('error')
      }
    }

    try {
      renderer = new GpuPreviewRenderer(canvas)
      renderer.setSource(sourceImage)
      initializationFrame = window.requestAnimationFrame(() => {
        initializationFrame = null
        if (disposed || !renderer) return
        try {
          renderer.render(initialAdjustments, initialProfile)
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
  }, [workspaceMode, matchPreviewData, hasResult])

  useEffect(() => {
    pendingGpuPreview.current = { adjustments: visibleAdjustments, profile: activeMatchProfile }
    /*
     * `hasResult` 必须进门禁。结果层 canvas 只在有追色结果时挂载（见 stage 的 JSX），
     * 没有结果时 `gpuResultCanvas.current` 是 null，而早先这里只门禁了 matchPreviewData：
     * 于是每次它变化（进页面 / 切图 / 改窗口大小）都会把整张视口图先跑完一遍 CPU 调色
     * （`processImageData` 是逐像素 JS 管线，视口级一次就是数百毫秒），再把它画进 null。
     * 这既是纯浪费，抛出的 TypeError 又打断了这一帧——刚算好的 BEFORE 像素因此迟迟上不了屏，
     * 表现为「进 AI 追色要等一会图片才显示出来」。调色页的同位代码一直有这层守卫
     * （`AiColorWorkspace.paintCpuPreview` 内部先判 canvas 为空），所以它没有这段停顿。
     */
    if (workspaceMode !== 'match' || !matchPreviewData || !hasResult || previewFrame.current !== null) return

    previewFrame.current = window.requestAnimationFrame(() => {
      previewFrame.current = null
      const pending = pendingGpuPreview.current
      // 再判一次：canvas 可能在本帧被卸载（结果被重置），此时绝不触发 CPU 渲染。
      const canvas = gpuResultCanvas.current
      if (!pending || !canvas) return

      const renderer = gpuPreviewRenderer.current
      if (renderer && previewEngine === 'gpu') {
        try {
          renderer.render(pending.adjustments, pending.profile)
          return
        } catch (error) {
          console.error('WebGL2 preview render failed; falling back to CPU.', error)
          renderer.dispose()
          if (gpuPreviewRenderer.current === renderer) gpuPreviewRenderer.current = null
          pendingGpuPreview.current = null
          setPreviewEngine('error')
        }
      }

      if (previewEngine === 'error' || !gpuPreviewRenderer.current) {
        drawImageDataToCanvas(canvas, processImageData(matchPreviewData, pending.adjustments, pending.profile))
      }
    })
  }, [workspaceMode, matchPreviewData, hasResult, visibleAdjustments, activeMatchProfile, previewEngine])

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop' || event.payload.paths.length === 0) return
      const imagePaths = event.payload.paths.filter((path) => /\.(jpe?g|png|webp)$/i.test(path)).slice(0, 2)
      if (imagePaths.length === 0) return notify('请拖入 JPG、PNG 或 WebP 图片', 'error')
      // 工作区为空时第一张作为原片、第二张作为参考图；已有图片时拖入即新增到工作区。
      if (workspace.photos.length === 0) {
        void handleNativePath(imagePaths[0], 'source')
        if (imagePaths[1]) void handleNativePath(imagePaths[1], 'reference')
      } else if (!workspace.reference.entry) {
        void handleNativePath(imagePaths[0], 'reference')
      } else {
        void handleNativePath(imagePaths[0], 'source')
      }
    }).then((fn) => { unlisten = fn })
    return () => unlisten?.()
  }, [workspace.photos.length, workspace.reference.entry])

  /** 单图入口统一汇入工作区（浏览器 / File 输入走内存载入），避免出现第二套图像真相源。 */
  const handleFile = async (file: File, kind: ImageKind) => {
    try {
      if (kind === 'source') await workspace.importSingleFile(file)
      else await workspace.setReferenceFromFile(file)
    } catch (error) { notify(errorMessage(error, '图片载入失败'), 'error') }
  }

  async function handleNativePath(path: string, kind: ImageKind) {
    try {
      if (kind === 'source') {
        await workspace.importSinglePath(path)
      } else {
        notify('正在解析参考图…')
        await workspace.setReferenceFromPath(path)
      }
    } catch (error) { notify(errorMessage(error, '本地图片读取失败'), 'error') }
  }

  const pickNativeImage = async (kind: ImageKind) => {
    try {
      const path = await pickImagePath()
      if (path) await handleNativePath(path, kind)
    } catch (error) { notify(errorMessage(error, '无法打开文件选择器'), 'error') }
  }

  /**
   * 工作区导入入口（内容页 / 追色与调色的左栏 / 空态 CTA 共用）。
   * 传入 true：不需要决策时直接导完，选完文件就能在网格里看到素材。
   */
  const pickWorkspaceImages = async () => {
    try { await workspace.beginImport(true) }
    catch (error) { notify(errorMessage(error, '无法打开文件选择器'), 'error') }
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
    setFineTuneVisibility({})
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
    setFineTuneVisibility({})
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
      const currentResult = processImageData(sourceData, visibleAdjustments, null)
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
    setFineTuneVisibility({})
    setModelStyle('')
    setMatchRenderMode('none')
    notify('参数已重置')
  }

  const clearImage = (kind: ImageKind) => {
    setAdjustments(createDefaultAdjustments())
    setFineTuneVisibility({})
    setModelStyle('')
    setMatchRenderMode('none')
    if (kind === 'source') {
      // 图片属于工作区，这里只取消当前选中；真正删除走「清空工作区」。
      workspace.deselect()
      notify('已取消当前选中；如需移除图片请使用「清空工作区」')
    } else {
      void workspace.clearReference()
    }
  }

  const exportPreview = async () => {
    if (!source || !reference || matchRenderMode === 'none') return notify('请先完成追色', 'error')
    setExporting(true)
    try {
      // Full native resolution via GPU (CPU fallback). No 2400px preview-style cap.
      const result = await exportGradedImage(source.element, visibleAdjustments, {
        profile: activeMatchProfile,
        quality: 0.92,
      })
      const defaultName = `${source.name.replace(/\.[^.]+$/, '')}-chromatrace.jpg`
      const saved = await saveJpegNative(result.bytes, defaultName)
      if (saved) {
        notify(`JPEG 已导出 · ${result.width}×${result.height} · ${result.engine.toUpperCase()}`)
      }
    } catch (error) { notify(errorMessage(error, '导出失败'), 'error') }
    finally { setExporting(false) }
  }


  const pickSourceFromStage = () => {
    if (isTauri()) void pickWorkspaceImages()
    else browserSourceInput.current?.click()
  }

  return (
    <div className={`app-shell ${isTauri() ? 'app-shell--compact app-shell--integrated' : ''}`}>
      <input
        ref={browserSourceInput}
        className="visually-hidden"
        type="file"
        accept="image/jpeg,image/png,image/webp,.cr2,.cr3,.nef,.nrw,.arw,.raf,.orf,.rw2,.pef,.dng,.raw"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handleFile(file, 'source')
          event.target.value = ''
        }}
      />
      {/* 一体化窗口的拖动区：Tauri 只让 drag region 响应拖动与双击最大化。
          顶栏整片留作可拖区，按钮等可交互元素由 runtime 自动排除。 */}
      <header className="topbar" data-tauri-drag-region={isTauri() ? 'deep' : undefined}>
        <div className="topbar__left">
          <div className="brand">
            <span className="brand__mark"><Aperture size={18} strokeWidth={1.7} /></span>
            <div>
              <strong>色迹</strong>
              <span>CHROMA TRACE</span>
            </div>
          </div>
          {/* 工作区控件留在左侧组、与品牌同列：它表达「在哪个库里」，
              而中间的 AI 追色 / 调色 / 设置表达「在哪个模式」，两者语义不同组。 */}
          <div className="workspace-switcher" ref={switcherRef}>
            <button
              type="button"
              className={`workspace-switcher__label ${workspaceMode === 'content' ? 'is-active' : ''}`}
              onClick={() => setWorkspaceMode(activeWorkspaceId ? 'content' : 'workspaces')}
              title={activeWorkspace ? `打开工作区「${activeWorkspace.name}」的素材` : '进入工作区'}
            >
              <FolderKanban size={15} />
              <span>{activeWorkspace ? activeWorkspace.name : '工作区'}</span>
            </button>
            <button
              type="button"
              className={`workspace-switcher__caret ${switcherOpen ? 'is-open' : ''}`}
              aria-haspopup="menu"
              aria-expanded={switcherOpen}
              aria-label="切换工作区"
              title="切换到其他工作区"
              onClick={() => setSwitcherOpen((open) => !open)}
            >
              <ChevronDown size={14} />
            </button>
            {switcherOpen ? (
              <div className="workspace-switcher__menu" role="menu" aria-label="工作区列表" data-tauri-drag-region="false">
                {workspaces.length === 0 ? (
                  <p className="workspace-switcher__empty">暂无工作区</p>
                ) : workspaces.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={entry.id === activeWorkspaceId}
                    className={`workspace-switcher__item ${entry.id === activeWorkspaceId ? 'is-current' : ''}`}
                    onClick={() => requestWorkspaceSwitch(entry.id)}
                  >
                    <span>{entry.name}</span>
                    {entry.id === activeWorkspaceId ? <Check size={14} /> : null}
                  </button>
                ))}
                <button
                  type="button"
                  className="workspace-switcher__new"
                  onClick={() => { setSwitcherOpen(false); setWorkspaceMode('workspaces') }}
                >
                  + 新建 / 管理
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <nav className="workspace-nav" aria-label="工作区导航">
          <button
            className={workspaceMode === 'match' ? 'is-active' : ''}
            disabled={!canUseEditor}
            title={canUseEditor ? undefined : '请先进入一个工作区'}
            onClick={() => openEditorFromNav('match')}
          ><ScanSearch size={15}/> AI 追色</button>
          <button
            className={workspaceMode === 'grade' ? 'is-active' : ''}
            disabled={!canUseEditor}
            title={canUseEditor ? undefined : '请先进入一个工作区'}
            onClick={() => openEditorFromNav('grade')}
          ><Palette size={15}/> AI 调色</button>
          <button className={workspaceMode === 'settings' ? 'is-active' : ''} onClick={() => setWorkspaceMode('settings')}><Settings2 size={15}/> 设置</button>
        </nav>
        {workspaceSwitchPending ? (
          <div className="workspace-switch-confirm" role="dialog" aria-label="确认切换工作区" data-tauri-drag-region="false">
            <p>
              正在编辑「{activeWorkspace?.name ?? '当前工作区'}」，
              切换到「{workspaces.find((entry) => entry.id === workspaceSwitchPending)?.name ?? workspaceSwitchPending}」？
            </p>
            <div className="workspace-switch-confirm__actions">
              <button type="button" className="button button--ghost" onClick={() => setWorkspaceSwitchPending(null)}>取消</button>
              <button type="button" className="button button--accent" onClick={confirmWorkspaceSwitch}>切换</button>
            </div>
          </div>
        ) : null}
        <div className="topbar__actions">
          {isEditorMode ? (
            <>
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
              <section id="workspace-help" className="help-popover" role="dialog" aria-label={helpContent.title} data-tauri-drag-region="false">
                <div className="help-popover__head">
                  <div><h2>{helpContent.title}</h2></div>
                  <button type="button" className="icon-button" title="关闭帮助" onClick={() => setHelpOpen(false)}><X size={15}/></button>
                </div>
                <ol>{helpContent.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                <p>{helpContent.note}</p>
              </section>
            ) : null}
              </div>
            </>
          ) : null}
          {isEditorMode ? (
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
          {isTauri() ? (
            <div className="window-controls" role="group" aria-label="窗口控制">
              <button type="button" className="window-control" title="最小化" aria-label="最小化" onClick={() => void windowControl('minimize')}>
                <Minus size={14} strokeWidth={2.2} />
              </button>
              <button type="button" className="window-control" title={windowMaximized ? '向下还原' : '最大化'} aria-label={windowMaximized ? '向下还原' : '最大化'} onClick={() => void windowControl('toggleMaximize')}>
                {windowMaximized ? <span className="window-control__restore" aria-hidden="true" /> : <Square size={12} strokeWidth={2.2} />}
              </button>
              <button type="button" className="window-control window-control--close" title="关闭" aria-label="关闭" onClick={() => void windowControl('close')}>
                <X size={14} strokeWidth={2.2} />
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {workspaceMode === 'workspaces' ? (
        <WorkspacesPage
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          loaded={workspacesLoaded}
          onEnter={(id) => enterWorkspace(id)}
          onCreate={async (name) => {
            try {
              const created = await createWorkspace(name)
              await refreshWorkspaces()
              enterWorkspace(created.id)
              notify(`工作区「${created.name}」已创建`)
            } catch (error) { notify(errorMessage(error, '创建工作区失败'), 'error') }
          }}
          onRename={async (id, name) => {
            try {
              await renameWorkspace(id, name)
              await refreshWorkspaces()
              notify('工作区已重命名')
            } catch (error) { notify(errorMessage(error, '重命名失败'), 'error') }
          }}
          onDelete={async (id) => {
            try {
              await deleteWorkspace(id)
              await refreshWorkspaces()
              notify('工作区已删除')
            } catch (error) { notify(errorMessage(error, '删除工作区失败'), 'error') }
          }}
          onNotify={notify}
        />
      ) : workspaceMode === 'content' ? (
        <WorkspaceContentPage
          name={activeWorkspace?.name ?? '工作区'}
          photos={workspace.photos}
          // 没有本次高亮时回落到工作区记住的那张，让「上次编辑到哪」仍然可见。
          highlightId={contentSelection ?? workspace.currentId}
          thumbUrls={workspace.thumbUrls}
          busy={workspace.importBusy}
          onBack={() => setWorkspaceMode('workspaces')}
          onImport={pickSourceFromStage}
          onHighlight={setContentSelection}
          onOpen={openPhotoInEditor}
          onClearWorkspace={() => { void workspace.clearWorkspace() }}
          workspaceId={activeWorkspaceId ?? DEFAULT_WORKSPACE_ID}
          onReveal={(photoId) => {
            void revealPhotoLocation(photoId, activeWorkspaceId ?? DEFAULT_WORKSPACE_ID)
              .then((path) => notify(`已在文件管理器中定位：${path}`))
              .catch((error) => notify(errorMessage(error, '无法打开文件所在位置'), 'error'))
          }}
          onRemovePhotos={(photoIds) => workspace.removePhotos(photoIds)}
          onNotify={notify}
        />
      ) : workspaceMode === 'grade' ? (
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
          onPick={pickSourceFromStage}
          onClear={() => clearImage('source')}
          onOpenSettings={() => { setSettingsSection('model'); setWorkspaceMode('settings') }}
          onPrivacyAccepted={markModelPrivacyAccepted}
          notify={notify}
          onExportStateChange={setGradeExportState}
        />
      ) : workspaceMode === 'settings' ? (
        <main className="settings-workspace">
          <aside className="settings-rail" aria-label="设置导航">
            <header className="settings-rail__head">
              <span className="settings-rail__mark"><Settings2 size={16}/></span>
              <div>
                <h1>设置</h1>
              </div>
            </header>

            <nav className="settings-nav" aria-label="设置模块">
              <button
                type="button"
                className={settingsSection === 'appearance' ? 'is-active' : ''}
                aria-current={settingsSection === 'appearance' ? 'page' : undefined}
                onClick={() => setSettingsSection('appearance')}
              >
                <span className="settings-nav__index">01</span>
                <span className="settings-nav__icon">{themeMode === 'dark' ? <Moon size={16} /> : <Sun size={16} />}</span>
                <span className="settings-nav__copy">
                  <strong>外观</strong>
                </span>
                <em className="settings-nav__chip">{themeMode === 'dark' ? '夜间' : '日间'}</em>
              </button>
              <button
                type="button"
                className={settingsSection === 'library' ? 'is-active' : ''}
                aria-current={settingsSection === 'library' ? 'page' : undefined}
                onClick={() => setSettingsSection('library')}
              >
                <span className="settings-nav__index">02</span>
                <span className="settings-nav__icon"><FolderKanban size={16}/></span>
                <span className="settings-nav__copy">
                  <strong>资料库</strong>
                </span>
                <em className="settings-nav__chip">本地</em>
              </button>
              <button
                type="button"
                className={settingsSection === 'model' ? 'is-active' : ''}
                aria-current={settingsSection === 'model' ? 'page' : undefined}
                onClick={() => setSettingsSection('model')}
              >
                <span className="settings-nav__index">03</span>
                <span className="settings-nav__icon"><CloudCog size={16}/></span>
                <span className="settings-nav__copy">
                  <strong>模型</strong>
                </span>
                <em className={`settings-nav__chip ${modelSettings.enabled ? 'is-on' : ''}`}>
                  {modelSettings.enabled ? '启用' : '离线'}
                </em>
              </button>
            </nav>

            <section className="settings-rail__status" aria-label="当前配置摘要">
              <div>
                <span>模型能力</span>
                <strong className={modelSettings.enabled ? 'is-on' : ''}>{modelSettings.enabled ? '已启用' : '已关闭'}</strong>
              </div>
              <div>
                <span>视觉路由</span>
                <strong>{activeVisionModel?.name || '未选择'}</strong>
              </div>
              <div>
                <span>图像路由</span>
                <strong>{activeImageModel?.name || '未选择'}</strong>
              </div>
              <div>
                <span>主题</span>
                <strong>{themeMode === 'dark' ? '夜间模式' : '日间模式'}</strong>
              </div>
            </section>

            <footer className="settings-rail__foot">
              <LockKeyhole size={13}/>
              <span>本地优先 · API Key 存于系统凭据存储</span>
            </footer>
          </aside>

          <div className="settings-main">
            {settingsSection === 'appearance' ? (
              <section className="settings-panel appearance-panel">
                <header className="settings-panel__head">
                  <div>
                    <h2>外观</h2>
                  </div>
                  <div className={`settings-panel__pulse ${themeMode === 'dark' ? 'is-dark' : 'is-light'}`}>
                    {themeMode === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
                    <span>
                      <strong>{themeMode === 'dark' ? '夜间模式' : '日间模式'}</strong>
                    </span>
                  </div>
                </header>

                <div className="settings-panel__body">
                  <section className="settings-card appearance-theme-card">
                    <div className="settings-card__head">
                      <div>
                        <h3>界面主题</h3>
                      </div>
                    </div>

                    <div className="theme-stage" role="radiogroup" aria-label="界面主题">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={themeMode === 'light'}
                        className={`theme-tile ${themeMode === 'light' ? 'is-active' : ''}`}
                        onClick={() => setThemeMode('light')}
                      >
                        <span className="theme-tile__preview theme-tile__preview--light" aria-hidden="true">
                          <i className="theme-tile__bar"/><i className="theme-tile__side"/><i className="theme-tile__stage"/><i className="theme-tile__rail"/>
                        </span>
                        <span className="theme-tile__meta">
                          <Sun size={15}/>
                          <span><strong>日间</strong></span>
                          {themeMode === 'light' ? <Check size={14} className="theme-tile__check"/> : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={themeMode === 'dark'}
                        className={`theme-tile ${themeMode === 'dark' ? 'is-active' : ''}`}
                        onClick={() => setThemeMode('dark')}
                      >
                        <span className="theme-tile__preview theme-tile__preview--dark" aria-hidden="true">
                          <i className="theme-tile__bar"/><i className="theme-tile__side"/><i className="theme-tile__stage"/><i className="theme-tile__rail"/>
                        </span>
                        <span className="theme-tile__meta">
                          <Moon size={15}/>
                          <span><strong>夜间</strong></span>
                          {themeMode === 'dark' ? <Check size={14} className="theme-tile__check"/> : null}
                        </span>
                      </button>
                    </div>
                  </section>
                </div>
              </section>
            ) : settingsSection === 'library' ? (
              <LibrarySettingsPanel notify={notify} />
            ) : (
              <ModelSettingsWorkspace
                settings={modelSettings}
                credentialStatus={credentialStatus}
                settingsLoaded={settingsLoaded}
                onChange={setModelSettings}
                onCredentialStatusChange={(providerId, present) => setCredentialStatus((current) => ({ ...current, [providerId]: present }))}
                notify={notify}
              />
            )}
          </div>
        </main>
      ) : (
      <main className="workspace-layout workspace">
        <aside className="workspace-rail workspace-rail--left input-rail left-console">
          <header className="left-console__head">
            <div className="rail-heading">
              <div><h2>匹配样本</h2></div>
              <span className={`status-dot ${profile ? 'is-ready' : ''}`}>{profile ? '可追色' : '待分析'}</span>
            </div>
            <ol className="rail-progress" aria-label="追色准备进度">
              <li className={reference ? 'is-done' : 'is-current'}><i>1</i><span>参考</span></li>
              <li className={profile ? 'is-done' : reference ? 'is-current' : ''}><i>2</i><span>分析</span></li>
            </ol>
          </header>

          <div className="left-console__body">
            <section className="rail-card">
              <div className="rail-card__head">
                <div><strong>双图样本</strong></div>
              </div>
              <div className="match-pair">
                <div className="match-pair__slot">
                  <div className="match-pair__label"><span>原片</span><b>{source ? '工作区素材' : '暂无素材'}</b></div>
                  {/*
                    原片是只读回显：它由工作区当前素材决定，所以这里不再提供拖入/更换，
                    点击回到工作区内容页去挑图——避免出现「左栏选一张、网格选另一张」的双真相源。
                  */}
                  <ImageDrop
                    title={source ? '回到工作区内容页切换' : '去导入素材'}
                    image={source}
                    accent="source"
                    readOnly
                    onPick={() => setWorkspaceMode('content')}
                  />
                </div>
                <div className="match-pair__bridge" aria-hidden="true"><ArrowRight size={14}/></div>
                <div className="match-pair__slot">
                  {/* 参考图存在工作区层面、对该区所有素材共用，所以标签写明「工作区共享」，
                      避免被读成「只对这张原片生效」。 */}
                  <div className="match-pair__label match-pair__label--ref"><span>参考</span><b>{reference ? '工作区共享' : '待选择'}</b></div>
                  <ImageDrop
                    title="选择参考" image={reference} accent="reference"
                    onFile={(file) => void handleFile(file, 'reference')}
                    onPick={isTauri() ? () => void pickNativeImage('reference') : undefined}
                    onClear={() => clearImage('reference')}
                  />
                </div>
              </div>
            </section>

            <section className="rail-card">
              <div className="rail-card__head">
                <div><strong>样本分析</strong></div>
                <em className="rail-card__meta">{profile ? '2 / 2' : source || reference ? '1 / 2' : '0 / 2'}</em>
              </div>
              <div className="analysis-card analysis-card--compact">
                <Histogram values={referenceStats?.histogram || sourceStats?.histogram} />
                <div className="swatch-row">
                  <div><i style={{ background: toHex(sourceStats) }}/><span>原片均值</span><b>{toHex(sourceStats).toUpperCase()}</b></div>
                  <div><i style={{ background: toHex(referenceStats) }}/><span>目标均值</span><b>{toHex(referenceStats).toUpperCase()}</b></div>
                </div>
              </div>
            </section>
          </div>

          <footer className="left-console__foot">
            <button type="button" className="match-button" disabled={!profile || modelBusy || !modelSettings.enabled} onClick={runModelMatch}>
              {modelTask === 'analyze' ? <LoaderCircle className="spin" size={17}/> : <WandSparkles size={17}/>}
              <span><strong>开始 AI 语义追色</strong></span><ArrowRight size={17}/>
            </button>
          </footer>
        </aside>

        <section className="workspace-stage stage">
          <div className="stage__toolbar">
            <div className="stage__title"><strong>{source?.name || '等待载入原片'}</strong></div>
            {compareMode === 'toggle' ? (
              <CompareSlider
                value={compare}
                onChange={setCompare}
                label="前后"
                disabled={!hasResult}
              />
            ) : (
              <div className="view-switch view-switch--hint"><span>{compareMode === 'wipe' ? '拖动预览分割线' : compareMode === 'side' ? '左右分屏' : '上下分屏'}</span></div>
            )}
            <div className="stage__tools">
              <CompareModeControls mode={compareMode} onChange={setCompareMode} disabled={!sourceData} />
              <button className="icon-button" title="重置" onClick={reset}><RotateCcw size={16}/></button>
            </div>
          </div>

          <div className="stage__slot stage__slot--banner">
            <VolumeBanner
              volumes={workspace.absentVolumes}
              busy={workspace.importBusy}
              onConvertToCopy={(volumeId) => { void workspace.convertVolumeToCopy(volumeId) }}
              onRelocate={(volumeId) => { void workspace.relocateVolume(volumeId) }}
              onDismiss={workspace.dismissAbsentVolume}
            />
          </div>

          <div
            ref={matchPreviewFrameRef}
            className={previewFrameClass(compareMode, Boolean(sourceData), hasResult)}
          >
            {sourceData ? (
              <>
                <div className="preview-layer preview-layer--before">
                  <canvas ref={originalCanvas} className="preview-canvas preview-canvas--before" />
                </div>
                {hasResult ? (
                  <div className="preview-layer preview-layer--after preview-after" style={afterLayerStyle(compareMode, compare, true)}>
                    <canvas ref={gpuResultCanvas} className="preview-canvas" />
                  </div>
                ) : null}
                {hasResult && compareMode !== 'toggle' ? (
                  <CompareDivider
                    mode={compareMode}
                    value={compare}
                    onChange={setCompare}
                    frameRef={matchPreviewFrameRef}
                  />
                ) : null}
              </>
            ) : (
              <div className="empty-stage">
                <button className="button button--light empty-stage__cta" type="button" onClick={pickSourceFromStage}>
                  <Upload size={16} /> 导入图片到工作区
                </button>
                <p className="empty-stage__hint">支持多选 JPG / PNG / WebP / 相机 RAW；可移动设备上的图片会自动复制一份到资料库</p>
              </div>
            )}
          </div>

          <div className="stage__slot stage__slot--filmstrip">
            <Filmstrip
              photos={workspace.photos}
              currentId={workspace.currentId}
              selection={workspace.selection}
              thumbUrls={workspace.thumbUrls}
              busy={workspace.importBusy}
              onSelect={workspace.selectPhoto}
              onSelectionChange={workspace.setSelection}
              onApplyRecipe={workspace.applyRecipeToSelection}
              onClearWorkspace={() => { void workspace.clearWorkspace() }}
              onFocusAbsentVolumes={() => setWorkspaceMode('match')}
            />
          </div>

          <div className="stage__footer">
            <span>
              {source
                ? matchPreviewData
                  ? `${matchPreviewData.width} × ${matchPreviewData.height} 预览 · 原片 ${source.width}×${source.height}`
                  : `原片 ${source.width}×${source.height} · 预览准备中`
                : '未载入图片'}
            </span>
            <span><i className="gpu-dot"/> {previewEngine === 'gpu' ? 'WebGL2 GPU' : previewEngine === 'error' ? 'GPU 异常' : 'GPU 初始化中'} · {canvasEngineLabel}</span>
            <span>sRGB / 8 BIT</span>
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
                    <div><h3>追色控制</h3></div>
                    <span className="ai-badge">{matchRenderMode === 'ai' ? 'AI' : '本地'}</span>
                  </div>
                  {matchRenderMode === 'ai' ? (
                    <>
                      <div className="semantic-match-note">
                        <WandSparkles size={16}/>
                        <div>
                          <strong>AI 独立配方正在生效</strong>
                        </div>
                      </div>
                      <Control label="肤色保护" value={adjustments.skinProtect} min={0} max={100} suffix="%" onChange={(v) => setAdjustment('skinProtect', v)} />
                    </>
                  ) : (
                    <>
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
                <FineTunePanels
                  adjustments={adjustments}
                  setAdjustments={setAdjustments}
                  moduleVisibility={fineTuneVisibility}
                  setModuleVisibility={setFineTuneVisibility}
                />

              </div>
            ) : null}

          </div>
        </aside>
      </main>
      )}

      {/*
        导入确认弹窗挂在 app-shell 顶层，而不是某个模式的左栏里。
        导入入口分布在内容页 / 追色 / 调色三处，面板若只挂在其中一个模式内，
        其余模式选完文件就会「状态变了但界面不动」——原先只有追色能显示它。
      */}
      {workspace.importPlan ? (
        <div className="import-dialog" role="dialog" aria-modal="true" aria-label="导入确认">
          <div className="import-dialog__card">
            <ImportConfirmPanel
              plan={workspace.importPlan}
              progress={workspace.importing}
              busy={workspace.importBusy}
              failures={workspace.importFailures}
              onPolicyChange={workspace.changeVolumePolicy}
              onConfirm={() => { void workspace.confirmImport() }}
              onCancel={workspace.cancelImport}
              onDismiss={workspace.dismissImport}
              onOpenFolder={() => { void openWorkspaceFolder().catch((error) => notify(errorMessage(error, '无法打开工作区文件夹'), 'error')) }}
            />
          </div>
        </div>
      ) : null}

      {toast ? <div className={`toast toast--${toast.kind}`}>{toast.kind === 'ok' ? <Check size={16}/> : <X size={16}/>}<span>{toast.message}</span></div> : null}
    </div>
  )
}

export default App







