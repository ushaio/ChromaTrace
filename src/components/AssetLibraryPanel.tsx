import {
  Check, ChevronDown, ChevronRight, FilePlus2, FileUp, Folder, FolderInput,
  GripVertical, Import, LoaderCircle, Pencil, Trash2,
} from 'lucide-react'
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'
import {
  deleteLibraryAsset,
  deleteLibraryFolder,
  importLibraryAssetBytes,
  isTauri,
  listLibraryAssets,
  loadLibraryOrder,
  moveLibraryAsset,
  moveLibraryFolder,
  pickAndImportLibraryAssets,
  pickAndImportLibraryFolder,
  renameLibraryAsset,
  renameLibraryFolder,
  saveLibraryOrder,
  type LibraryAsset,
  type LibraryAssetKind,
  type LibraryOrderState,
} from '../lib/desktop'

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

interface FolderNode {
  path: string
  name: string
  depth: number
  assets: LibraryAsset[]
  childPaths: string[]
}

type DragPayload =
  | { type: 'asset'; relativePath: string; folder: string }
  | { type: 'folder'; path: string; parent: string }

type DropHover =
  | { kind: 'asset'; relativePath: string; folder: string; placeAfter: boolean }
  | { kind: 'folder'; path: string; placeAfter: boolean }
  | { kind: 'root'; placeAfter: boolean }

type PointerDragSession = {
  payload: DragPayload
  pointerId: number
  startX: number
  startY: number
  activated: boolean
}

function parentOf(path: string) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function folderDepth(path: string) {
  if (!path) return 0
  return path.split('/').filter(Boolean).length
}

/**
 * Default expand policy (Lightroom-like library rail):
 * - root / top-level folders: expanded
 * - nested folders (depth ≥ 2): collapsed
 */
function defaultFolderCollapsed(path: string, depth = folderDepth(path)) {
  if (!path) return false
  return depth > 1
}

function isUnderPath(path: string, folder: string) {
  if (!folder) return true
  return path === folder || path.startsWith(`${folder}/`)
}

/** Rewrite collapse overrides when a folder path prefix changes (rename / move). */
function rewriteCollapsedKeys(
  state: Record<string, boolean>,
  from: string,
  to: string,
): Record<string, boolean> {
  if (!from || from === to) return state
  let changed = false
  const next: Record<string, boolean> = {}
  for (const [path, value] of Object.entries(state)) {
    if (path === from) {
      next[to] = value
      changed = true
      continue
    }
    if (path.startsWith(`${from}/`)) {
      next[`${to}${path.slice(from.length)}`] = value
      changed = true
      continue
    }
    next[path] = value
  }
  return changed ? next : state
}

/** Drop overrides for paths that no longer exist in the tree. */
function pruneCollapsedKeys(
  state: Record<string, boolean>,
  knownPaths: Iterable<string>,
): Record<string, boolean> {
  const known = new Set(knownPaths)
  let changed = false
  const next: Record<string, boolean> = {}
  for (const [path, value] of Object.entries(state)) {
    if (!path || known.has(path)) next[path] = value
    else changed = true
  }
  return changed ? next : state
}

function applySiblingOrder(items: string[], preferred: string[] | undefined) {
  if (!preferred?.length) return items
  const remaining = new Set(items)
  const ordered: string[] = []
  for (const id of preferred) {
    if (remaining.has(id)) {
      ordered.push(id)
      remaining.delete(id)
    }
  }
  for (const id of items) {
    if (remaining.has(id)) ordered.push(id)
  }
  return ordered
}

function buildFolderTree(
  assets: LibraryAsset[],
  order: LibraryOrderState,
): { nodes: Map<string, FolderNode> } {
  const nodes = new Map<string, FolderNode>()
  const ensure = (folderPath: string) => {
    if (nodes.has(folderPath)) return nodes.get(folderPath)!
    const parts = folderPath ? folderPath.split('/') : []
    const node: FolderNode = {
      path: folderPath,
      name: folderPath ? parts[parts.length - 1] : '全部',
      depth: parts.length,
      assets: [],
      childPaths: [],
    }
    nodes.set(folderPath, node)
    if (folderPath) {
      const parent = parts.slice(0, -1).join('/')
      const parentNode = ensure(parent)
      if (!parentNode.childPaths.includes(folderPath)) parentNode.childPaths.push(folderPath)
    }
    return node
  }

  ensure('')
  for (const asset of assets) {
    if (asset.folder) {
      const segments = asset.folder.split('/')
      for (let index = 1; index <= segments.length; index += 1) {
        ensure(segments.slice(0, index).join('/'))
      }
    } else {
      ensure('')
    }
    ensure(asset.folder).assets.push(asset)
  }

  for (const node of nodes.values()) {
    const folderOrder = order.folders[node.path]
    node.childPaths = applySiblingOrder(
      [...node.childPaths].sort((left, right) => left.localeCompare(right, 'zh')),
      folderOrder,
    )
    const assetOrder = order.assets[node.path]
    const sortedByName = [...node.assets].sort((left, right) => left.name.localeCompare(right.name, 'zh'))
    if (assetOrder?.length) {
      const byPath = new Map(sortedByName.map((asset) => [asset.relativePath, asset]))
      const ordered: LibraryAsset[] = []
      for (const path of assetOrder) {
        const asset = byPath.get(path)
        if (asset) {
          ordered.push(asset)
          byPath.delete(path)
        }
      }
      for (const asset of sortedByName) {
        if (byPath.has(asset.relativePath)) ordered.push(asset)
      }
      node.assets = ordered
    } else {
      node.assets = sortedByName
    }
  }

  return { nodes }
}

function countSubtreeAssets(nodes: Map<string, FolderNode>, folderPath: string): number {
  const node = nodes.get(folderPath)
  if (!node) return 0
  return node.assets.length + node.childPaths.reduce((sum, child) => sum + countSubtreeAssets(nodes, child), 0)
}

function reorderSiblingList(list: string[], sourceId: string, targetId: string, placeAfter: boolean) {
  if (sourceId === targetId) return list
  const next = list.filter((id) => id !== sourceId)
  const targetIndex = next.indexOf(targetId)
  if (targetIndex < 0) return list
  next.splice(targetIndex + (placeAfter ? 1 : 0), 0, sourceId)
  return next
}

interface AssetLibraryPanelProps {
  kind: LibraryAssetKind
  title: string
  emptyHint: string
  activeRelativePath?: string | null
  /** When omitted, row click only highlights (settings manage mode). */
  onApply?: (asset: LibraryAsset) => void | Promise<void>
  onNotify: (message: string, kind?: 'ok' | 'error') => void
  refreshKey?: number
  /** Called when library paths change so parent can update active selection. */
  onAssetPathChange?: (fromRelativePath: string, toRelativePath: string) => void
  /**
   * Drag-to-reorder / move. Off in the grade sidebar; on in Settings → 资料库.
   * @default false
   */
  enableDragReorder?: boolean
  /** Start with the panel body expanded. @default true */
  defaultExpanded?: boolean
  /** Extra class on the root section (e.g. settings layout). */
  className?: string
}

export function AssetLibraryPanel({
  kind,
  title,
  emptyHint,
  activeRelativePath,
  onApply,
  onNotify,
  refreshKey = 0,
  onAssetPathChange,
  enableDragReorder = false,
  defaultExpanded = true,
  className = '',
}: AssetLibraryPanelProps) {
  const [assets, setAssets] = useState<LibraryAsset[]>([])
  const [order, setOrder] = useState<LibraryOrderState>({ folders: {}, assets: {} })
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [editingId, setEditingId] = useState('')
  const [editingFolder, setEditingFolder] = useState('')
  const [draftName, setDraftName] = useState('')
  /** First click on trash arms delete; second click (check) confirms. */
  const [pendingDeleteId, setPendingDeleteId] = useState('')
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState('')
  /** Explicit overrides only; missing keys use defaults: depth-1 open, nested collapsed. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  /** Entire library panel body collapsed (header stays visible). */
  const [panelCollapsed, setPanelCollapsed] = useState(!defaultExpanded)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [dropHover, setDropHover] = useState<DropHover | null>(null)
  const [pointerDragging, setPointerDragging] = useState(false)
  const pointerDragRef = useRef<PointerDragSession | null>(null)
  /** Skip blur-commit when the pencil/check button is handling commit. */
  const renameCommitFromButtonRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const treeRootRef = useRef<HTMLDivElement>(null)
  const orderRef = useRef(order)
  const busyIdRef = useRef(busyId)
  const onNotifyRef = useRef(onNotify)
  orderRef.current = order
  busyIdRef.current = busyId
  onNotifyRef.current = onNotify

  const reload = useCallback(async (opts?: { quiet?: boolean }) => {
    // quiet: keep current list visible (no loading flash) — used after moves; never after pure reorder.
    if (!opts?.quiet) setLoading(true)
    try {
      const [nextAssets, nextOrder] = await Promise.all([
        listLibraryAssets(kind),
        loadLibraryOrder(kind),
      ])
      setAssets(nextAssets)
      setOrder(nextOrder)
    } catch (error) {
      onNotifyRef.current(errorMessage(error, '加载资料库失败'), 'error')
    } finally {
      if (!opts?.quiet) setLoading(false)
    }
  }, [kind])

  useEffect(() => {
    void reload()
  }, [reload, refreshKey])

  useEffect(() => {
    if (!menuOpen) {
      setMenuPos(null)
      return
    }
    const placeMenu = () => {
      const trigger = menuTriggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const menuWidth = 132
      const menuHeight = 72
      const gap = 4
      // Prefer open below; flip above if the left rail / window bottom would clip it.
      const spaceBelow = window.innerHeight - rect.bottom - gap
      const openUp = spaceBelow < menuHeight && rect.top > menuHeight + gap
      const top = openUp
        ? Math.max(8, rect.top - menuHeight - gap)
        : Math.min(window.innerHeight - menuHeight - 8, rect.bottom + gap)
      const left = Math.min(
        Math.max(8, rect.right - menuWidth),
        window.innerWidth - menuWidth - 8,
      )
      setMenuPos({ top, left })
    }
    placeMenu()
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('resize', placeMenu)
    // Capture scroll from nested left-console overflow so the floating menu tracks the button.
    window.addEventListener('scroll', placeMenu, true)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', placeMenu)
      window.removeEventListener('scroll', placeMenu, true)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const tree = useMemo(() => buildFolderTree(assets, order), [assets, order])
  const treeRef = useRef(tree)
  treeRef.current = tree
  const label = kind === 'xmp' ? 'XMP' : 'CUBE'
  const importing = busyId.startsWith('import')

  // Drop collapse overrides for deleted/renamed-away folders so defaults re-apply cleanly.
  useEffect(() => {
    setCollapsed((current) => pruneCollapsedKeys(current, tree.nodes.keys()))
  }, [tree])

  const persistOrder = async (next: LibraryOrderState) => {
    setOrder(next)
    orderRef.current = next
    await saveLibraryOrder(kind, next)
  }

  const importFiles = async () => {
    setMenuOpen(false)
    setBusyId('import-files')
    try {
      if (isTauri()) {
        const imported = await pickAndImportLibraryAssets(kind, true)
        if (!imported.length) return
        await reload()
        onNotify(`已加入资料库 ${imported.length} 个${label}`)
        return
      }
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = kind === 'xmp' ? '.xmp,application/xml,text/xml' : '.cube,text/plain'
      input.multiple = true
      input.onchange = () => {
        void (async () => {
          try {
            const files = [...(input.files || [])]
            for (const file of files) {
              const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
              await importLibraryAssetBytes(kind, relative, await file.text())
            }
            if (files.length) {
              await reload()
              onNotify(`已加入资料库 ${files.length} 个${label}`)
            }
          } catch (error) {
            onNotify(errorMessage(error, '导入资料库失败'), 'error')
          } finally {
            setBusyId('')
          }
        })()
      }
      input.click()
      return
    } catch (error) {
      onNotify(errorMessage(error, '导入资料库失败'), 'error')
    } finally {
      if (isTauri()) setBusyId('')
    }
  }

  const importFolder = async () => {
    setMenuOpen(false)
    setBusyId('import-folder')
    try {
      if (isTauri()) {
        const imported = await pickAndImportLibraryFolder(kind)
        await reload()
        if (!imported.length) {
          return
        }
        onNotify(`已按文件夹导入 ${imported.length} 个${label}`)
        return
      }
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = kind === 'xmp' ? '.xmp,application/xml,text/xml' : '.cube,text/plain'
      input.multiple = true
      input.setAttribute('webkitdirectory', '')
      input.setAttribute('directory', '')
      input.onchange = () => {
        void (async () => {
          try {
            const files = [...(input.files || [])].filter((file) =>
              file.name.toLowerCase().endsWith(`.${kind}`),
            )
            for (const file of files) {
              const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
              await importLibraryAssetBytes(kind, relative, await file.text())
            }
            if (files.length) {
              await reload()
              onNotify(`已按文件夹导入 ${files.length} 个${label}`)
            } else {
              onNotify(`文件夹中没有 .${kind} 文件`, 'error')
            }
          } catch (error) {
            onNotify(errorMessage(error, '文件夹导入失败'), 'error')
          } finally {
            setBusyId('')
          }
        })()
      }
      input.click()
      return
    } catch (error) {
      onNotify(errorMessage(error, '文件夹导入失败'), 'error')
    } finally {
      if (isTauri()) setBusyId('')
    }
  }

  const applyAsset = async (asset: LibraryAsset) => {
    if (!onApply) return
    setBusyId(`apply:${asset.id}`)
    try {
      await onApply(asset)
    } catch (error) {
      onNotify(errorMessage(error, '应用失败'), 'error')
    } finally {
      setBusyId('')
    }
  }

  const clearPendingDelete = () => {
    setPendingDeleteId('')
    setPendingDeleteFolder('')
  }

  const removeAsset = async (asset: LibraryAsset) => {
    setBusyId(`delete:${asset.id}`)
    try {
      await deleteLibraryAsset(kind, asset.relativePath)
      if (editingId === asset.id) setEditingId('')
      setPendingDeleteId('')
      const nextOrder: LibraryOrderState = {
        folders: { ...order.folders },
        assets: { ...order.assets },
      }
      const list = (nextOrder.assets[asset.folder] || []).filter((path) => path !== asset.relativePath)
      nextOrder.assets[asset.folder] = list
      await persistOrder(nextOrder)
      await reload()
      onNotify(`已删除“${asset.name}”`)
    } catch (error) {
      onNotify(errorMessage(error, '删除失败'), 'error')
    } finally {
      setBusyId('')
    }
  }

  /** Trash → check (arm); check again → delete. */
  const toggleDeleteAsset = (asset: LibraryAsset) => {
    if (pendingDeleteId === asset.id) {
      void removeAsset(asset)
      return
    }
    setEditingId('')
    setEditingFolder('')
    setPendingDeleteFolder('')
    setPendingDeleteId(asset.id)
  }

  const commitRename = async (asset: LibraryAsset) => {
    const next = draftName.trim()
    if (!next || next === asset.name) {
      setEditingId('')
      return
    }
    setBusyId(`rename:${asset.id}`)
    try {
      const renamed = await renameLibraryAsset(kind, asset.relativePath, next)
      setEditingId('')
      onAssetPathChange?.(asset.relativePath, renamed.relativePath)
      await reload()
      onNotify(`已重命名为“${next}”`)
    } catch (error) {
      onNotify(errorMessage(error, '重命名失败'), 'error')
    } finally {
      setBusyId('')
    }
  }

  const commitRenameFolder = async (folderPath: string) => {
    const next = draftName.trim()
    const currentName = folderPath.includes('/') ? folderPath.slice(folderPath.lastIndexOf('/') + 1) : folderPath
    if (!next || next === currentName) {
      setEditingFolder('')
      return
    }
    setBusyId(`rename-folder:${folderPath}`)
    try {
      await renameLibraryFolder(kind, folderPath, next)
      setEditingFolder('')
      const parent = parentOf(folderPath)
      const nextFolder = parent ? `${parent}/${next}` : next
      if (activeRelativePath && isUnderPath(activeRelativePath, folderPath)) {
        const nextActive = activeRelativePath === folderPath
          ? nextFolder
          : `${nextFolder}${activeRelativePath.slice(folderPath.length)}`
        onAssetPathChange?.(activeRelativePath, nextActive)
      }
      setCollapsed((current) => rewriteCollapsedKeys(current, folderPath, nextFolder))
      await reload()
      onNotify(`已重命名文件夹为“${next}”`)
    } catch (error) {
      onNotify(errorMessage(error, '重命名文件夹失败'), 'error')
    } finally {
      setBusyId('')
    }
  }

  /** Pencil: enter edit; click again while editing → commit. */
  const toggleRenameAsset = (asset: LibraryAsset) => {
    if (editingId === asset.id) {
      void commitRename(asset).finally(() => {
        renameCommitFromButtonRef.current = false
      })
      return
    }
    renameCommitFromButtonRef.current = false
    clearPendingDelete()
    setEditingFolder('')
    setEditingId(asset.id)
    setDraftName(asset.name)
  }

  const toggleRenameFolder = (folderPath: string, name: string) => {
    if (editingFolder === folderPath) {
      void commitRenameFolder(folderPath).finally(() => {
        renameCommitFromButtonRef.current = false
      })
      return
    }
    renameCommitFromButtonRef.current = false
    clearPendingDelete()
    setEditingId('')
    setEditingFolder(folderPath)
    setDraftName(name)
  }

  const onRenameInputBlur = (commit: () => void | Promise<void>) => {
    // Defer so button mousedown can set renameCommitFromButtonRef first.
    window.setTimeout(() => {
      if (renameCommitFromButtonRef.current) return
      void commit()
    }, 0)
  }

  const removeFolder = async (folderPath: string, name: string) => {
    const count = countSubtreeAssets(tree.nodes, folderPath)
    setBusyId(`delete-folder:${folderPath}`)
    try {
      const deleted = await deleteLibraryFolder(kind, folderPath)
      if (editingFolder === folderPath) setEditingFolder('')
      setPendingDeleteFolder('')
      if (activeRelativePath && isUnderPath(activeRelativePath, folderPath)) {
        onAssetPathChange?.(activeRelativePath, '')
      }
      await reload()
      onNotify(`已删除文件夹“${name}”（${deleted} 个文件）`)
    } catch (error) {
      onNotify(errorMessage(error, '删除文件夹失败'), 'error')
    } finally {
      setBusyId('')
    }
  }

  const toggleDeleteFolder = (folderPath: string, name: string) => {
    if (pendingDeleteFolder === folderPath) {
      void removeFolder(folderPath, name)
      return
    }
    setEditingId('')
    setEditingFolder('')
    setPendingDeleteId('')
    setPendingDeleteFolder(folderPath)
  }

  // Auto-cancel armed delete if user clicks elsewhere or waits too long.
  useEffect(() => {
    if (!pendingDeleteId && !pendingDeleteFolder) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      // Keep armed state when clicking the confirm button itself.
      if (target instanceof Element && target.closest('[data-delete-confirm]')) return
      clearPendingDelete()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearPendingDelete()
    }
    const timer = window.setTimeout(() => clearPendingDelete(), 4000)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [pendingDeleteId, pendingDeleteFolder])

  const isFolderCollapsed = (folderPath: string, depth: number) => {
    if (Object.prototype.hasOwnProperty.call(collapsed, folderPath)) {
      return collapsed[folderPath]
    }
    return defaultFolderCollapsed(folderPath, depth)
  }

  const toggleFolder = (path: string) => {
    const node = tree.nodes.get(path)
    const depth = node?.depth ?? folderDepth(path)
    setCollapsed((current) => {
      const currentlyCollapsed = Object.prototype.hasOwnProperty.call(current, path)
        ? current[path]
        : defaultFolderCollapsed(path, depth)
      return { ...current, [path]: !currentlyCollapsed }
    })
  }

  const migrateCollapsedAfterFolderMove = (fromPath: string, toPath: string) => {
    setCollapsed((current) => rewriteCollapsedKeys(current, fromPath, toPath))
  }

  const clearPointerDrag = () => {
    pointerDragRef.current = null
    setPointerDragging(false)
    setDropHover(null)
    document.body.classList.remove('is-library-dragging')
  }

  const reorderWithinParent = async (
    parentPath: string,
    kindKey: 'folders' | 'assets',
    sourceId: string,
    targetId: string,
    placeAfter: boolean,
  ) => {
    const node = treeRef.current.nodes.get(parentPath)
    if (!node) return
    const currentOrder = orderRef.current
    const current = kindKey === 'folders'
      ? [...node.childPaths]
      : node.assets.map((asset) => asset.relativePath)
    if (!current.includes(sourceId) || !current.includes(targetId)) return
    const nextList = reorderSiblingList(current, sourceId, targetId, placeAfter)
    if (nextList.join('\0') === current.join('\0')) return
    const nextOrder: LibraryOrderState = {
      folders: { ...currentOrder.folders },
      assets: { ...currentOrder.assets },
    }
    if (kindKey === 'folders') nextOrder.folders[parentPath] = nextList
    else nextOrder.assets[parentPath] = nextList
    await persistOrder(nextOrder)
    // Silent — parent notify would recreate callbacks and flash a full library reload.
  }

  const applyPointerDrop = async (payload: DragPayload, hover: DropHover) => {
    if (busyIdRef.current) return
    const nodes = treeRef.current.nodes

    try {
      if (hover.kind === 'asset') {
        if (payload.type === 'asset') {
          if (payload.relativePath === hover.relativePath) return
          if (payload.folder === hover.folder) {
            await reorderWithinParent(hover.folder, 'assets', payload.relativePath, hover.relativePath, hover.placeAfter)
            return
          }
          setBusyId(`move:${payload.relativePath}`)
          const moved = await moveLibraryAsset(kind, payload.relativePath, hover.folder)
          onAssetPathChange?.(payload.relativePath, moved.relativePath)
          const nextOrder: LibraryOrderState = {
            folders: { ...orderRef.current.folders },
            assets: { ...orderRef.current.assets },
          }
          nextOrder.assets[payload.folder] = (nextOrder.assets[payload.folder] || []).filter((path) => path !== payload.relativePath)
          const targetList = (nodes.get(hover.folder)?.assets.map((asset) => asset.relativePath) || [])
            .filter((path) => path !== payload.relativePath)
          const insertAt = targetList.indexOf(hover.relativePath)
          const index = insertAt < 0 ? targetList.length : insertAt + (hover.placeAfter ? 1 : 0)
          targetList.splice(index, 0, moved.relativePath)
          nextOrder.assets[hover.folder] = targetList
          await persistOrder(nextOrder)
          await reload({ quiet: true })
          onNotifyRef.current(`已移动到“${hover.folder || '根目录'}”`)
          return
        }

        if (payload.path === hover.folder || isUnderPath(hover.folder, payload.path)) {
          onNotifyRef.current('不能将文件夹移动到自身内部', 'error')
          return
        }
        if (parentOf(payload.path) === hover.folder) return
        setBusyId(`move-folder:${payload.path}`)
        await moveLibraryFolder(kind, payload.path, hover.folder)
        const name = payload.path.includes('/') ? payload.path.slice(payload.path.lastIndexOf('/') + 1) : payload.path
        const nextFolder = hover.folder ? `${hover.folder}/${name}` : name
        migrateCollapsedAfterFolderMove(payload.path, nextFolder)
        if (activeRelativePath && isUnderPath(activeRelativePath, payload.path)) {
          onAssetPathChange?.(activeRelativePath, `${nextFolder}${activeRelativePath.slice(payload.path.length)}`)
        }
        const fresh = await loadLibraryOrder(kind)
        const oldParent = parentOf(payload.path)
        const nextOrder: LibraryOrderState = { folders: { ...fresh.folders }, assets: { ...fresh.assets } }
        nextOrder.folders[oldParent] = (nextOrder.folders[oldParent] || nodes.get(oldParent)?.childPaths || [])
          .filter((path) => path !== payload.path && path !== nextFolder)
        const destChildren = [...(nextOrder.folders[hover.folder] || nodes.get(hover.folder)?.childPaths || [])]
          .filter((path) => path !== payload.path && path !== nextFolder)
        destChildren.push(nextFolder)
        nextOrder.folders[hover.folder] = destChildren
        await persistOrder(nextOrder)
        await reload({ quiet: true })
        onNotifyRef.current(`已移动文件夹到“${hover.folder || '根目录'}”`)
        return
      }

      if (hover.kind === 'folder') {
        if (payload.type === 'asset') {
          if (payload.folder === hover.path) {
            // Drop on own folder header → no-op reorder context.
            return
          }
          setBusyId(`move:${payload.relativePath}`)
          const moved = await moveLibraryAsset(kind, payload.relativePath, hover.path)
          onAssetPathChange?.(payload.relativePath, moved.relativePath)
          const nextOrder: LibraryOrderState = {
            folders: { ...orderRef.current.folders },
            assets: { ...orderRef.current.assets },
          }
          nextOrder.assets[payload.folder] = (nextOrder.assets[payload.folder] || []).filter((path) => path !== payload.relativePath)
          const list = [...(nodes.get(hover.path)?.assets.map((asset) => asset.relativePath) || [])]
          if (!list.includes(moved.relativePath)) list.push(moved.relativePath)
          nextOrder.assets[hover.path] = list
          await persistOrder(nextOrder)
          await reload({ quiet: true })
          onNotifyRef.current(`已移动到“${hover.path || '根目录'}”`)
          return
        }

        if (payload.path === hover.path) return
        if (isUnderPath(hover.path, payload.path)) {
          onNotifyRef.current('不能将文件夹移动到自身或其子文件夹中', 'error')
          return
        }
        if (parentOf(payload.path) === parentOf(hover.path)) {
          await reorderWithinParent(parentOf(payload.path), 'folders', payload.path, hover.path, hover.placeAfter)
          return
        }
        setBusyId(`move-folder:${payload.path}`)
        await moveLibraryFolder(kind, payload.path, hover.path)
        const name = payload.path.includes('/') ? payload.path.slice(payload.path.lastIndexOf('/') + 1) : payload.path
        const nextFolder = hover.path ? `${hover.path}/${name}` : name
        migrateCollapsedAfterFolderMove(payload.path, nextFolder)
        if (activeRelativePath && isUnderPath(activeRelativePath, payload.path)) {
          onAssetPathChange?.(activeRelativePath, `${nextFolder}${activeRelativePath.slice(payload.path.length)}`)
        }
        const fresh = await loadLibraryOrder(kind)
        const oldParent = parentOf(payload.path)
        const nextOrder: LibraryOrderState = { folders: { ...fresh.folders }, assets: { ...fresh.assets } }
        nextOrder.folders[oldParent] = (nextOrder.folders[oldParent] || nodes.get(oldParent)?.childPaths || [])
          .filter((path) => path !== payload.path && path !== nextFolder)
        const destChildren = [...(nextOrder.folders[hover.path] || nodes.get(hover.path)?.childPaths || [])]
          .filter((path) => path !== payload.path && path !== nextFolder)
        destChildren.push(nextFolder)
        nextOrder.folders[hover.path] = destChildren
        await persistOrder(nextOrder)
        await reload({ quiet: true })
        onNotifyRef.current(`已移动文件夹到“${hover.path || '根目录'}”`)
        return
      }

      // root
      if (payload.type === 'asset') {
        if (!payload.folder) return
        setBusyId(`move:${payload.relativePath}`)
        const moved = await moveLibraryAsset(kind, payload.relativePath, '')
        onAssetPathChange?.(payload.relativePath, moved.relativePath)
        const nextOrder: LibraryOrderState = {
          folders: { ...orderRef.current.folders },
          assets: { ...orderRef.current.assets },
        }
        nextOrder.assets[payload.folder] = (nextOrder.assets[payload.folder] || []).filter((path) => path !== payload.relativePath)
        const rootAssets = [...(nodes.get('')?.assets.map((asset) => asset.relativePath) || [])]
          .filter((path) => path !== payload.relativePath)
        if (!rootAssets.includes(moved.relativePath)) rootAssets.push(moved.relativePath)
        nextOrder.assets[''] = rootAssets
        await persistOrder(nextOrder)
        await reload({ quiet: true })
        onNotifyRef.current('已移动到根目录')
        return
      }
      if (!parentOf(payload.path)) return
      setBusyId(`move-folder:${payload.path}`)
      await moveLibraryFolder(kind, payload.path, '')
      const name = payload.path.includes('/') ? payload.path.slice(payload.path.lastIndexOf('/') + 1) : payload.path
      migrateCollapsedAfterFolderMove(payload.path, name)
      if (activeRelativePath && isUnderPath(activeRelativePath, payload.path)) {
        onAssetPathChange?.(activeRelativePath, `${name}${activeRelativePath.slice(payload.path.length)}`)
      }
      const fresh = await loadLibraryOrder(kind)
      const oldParent = parentOf(payload.path)
      const nextOrder: LibraryOrderState = { folders: { ...fresh.folders }, assets: { ...fresh.assets } }
      nextOrder.folders[oldParent] = (nextOrder.folders[oldParent] || nodes.get(oldParent)?.childPaths || [])
        .filter((path) => path !== payload.path && path !== name)
      const rootFolders = [...(nextOrder.folders[''] || nodes.get('')?.childPaths || [])]
        .filter((path) => path !== payload.path && path !== name)
      rootFolders.push(name)
      nextOrder.folders[''] = rootFolders
      await persistOrder(nextOrder)
      await reload({ quiet: true })
      onNotifyRef.current('已移动文件夹到根目录')
    } catch (error) {
      onNotifyRef.current(errorMessage(error, '移动失败'), 'error')
    } finally {
      setBusyId('')
    }
  }

  const resolveDropHover = (clientX: number, clientY: number, payload: DragPayload): DropHover | null => {
    const el = document.elementFromPoint(clientX, clientY)
    if (!el || !(el instanceof Element)) return null
    const target = el.closest('[data-library-drop]') as HTMLElement | null
    if (!target) {
      // Empty area inside tree → root
      if (treeRootRef.current?.contains(el)) return { kind: 'root', placeAfter: true }
      return null
    }
    const raw = target.getAttribute('data-library-drop') || ''
    const rect = target.getBoundingClientRect()
    const placeAfter = clientY > rect.top + rect.height / 2
    if (raw === 'root') return { kind: 'root', placeAfter }
    if (raw.startsWith('asset:')) {
      const relativePath = raw.slice('asset:'.length)
      const folder = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
      // Don't highlight self as target for assets
      if (payload.type === 'asset' && payload.relativePath === relativePath) return null
      return { kind: 'asset', relativePath, folder, placeAfter }
    }
    if (raw.startsWith('folder:')) {
      const path = raw.slice('folder:'.length)
      if (payload.type === 'folder' && payload.path === path) return null
      return { kind: 'folder', path, placeAfter }
    }
    return null
  }

  const onGripPointerDown = (event: ReactPointerEvent, payload: DragPayload) => {
    if (!enableDragReorder || busyId) return
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()

    const pointerId = event.pointerId
    pointerDragRef.current = {
      payload,
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      activated: false,
    }

    // Document-level listeners survive React re-renders (setPointerCapture on a grip does not).
    const onMove = (ev: PointerEvent) => {
      const session = pointerDragRef.current
      if (!session || session.pointerId !== ev.pointerId) return
      const dx = ev.clientX - session.startX
      const dy = ev.clientY - session.startY
      if (!session.activated) {
        if (Math.hypot(dx, dy) < 5) return
        session.activated = true
        setPointerDragging(true)
        document.body.classList.add('is-library-dragging')
      }
      const hover = resolveDropHover(ev.clientX, ev.clientY, session.payload)
      setDropHover(hover)
    }

    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      const session = pointerDragRef.current
      if (!session || session.pointerId !== pointerId) {
        clearPointerDrag()
        return
      }
      const hover = session.activated
        ? resolveDropHover(ev.clientX, ev.clientY, session.payload)
        : null
      const dragPayload = session.payload
      clearPointerDrag()
      if (hover) void applyPointerDrop(dragPayload, hover)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
  }

  useEffect(() => () => {
    document.body.classList.remove('is-library-dragging')
  }, [])

  const importMenu = (
    <div className={`asset-import ${menuOpen ? 'is-open' : ''}`} ref={menuRef}>
      <button
        ref={menuTriggerRef}
        type="button"
        className={`icon-button asset-import__trigger ${menuOpen ? 'is-open' : ''}`}
        title="导入到资料库"
        aria-label="导入到资料库"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={importing}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {importing ? <LoaderCircle className="spin" size={14} /> : <Import size={15} strokeWidth={2.2} />}
      </button>
      {menuOpen && menuPos ? (
        <div
          className="asset-import__menu"
          role="menu"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <button type="button" role="menuitem" onClick={() => void importFiles()}>
            <FilePlus2 size={14} />
            <span>导入文件</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void importFolder()}>
            <FolderInput size={14} />
            <span>导入文件夹</span>
          </button>
        </div>
      ) : null}
    </div>
  )

  const renderFolder = (folderPath: string): ReactNode => {
    const node = tree.nodes.get(folderPath)
    if (!node) return null
    const isRoot = folderPath === ''
    const isCollapsed = isFolderCollapsed(folderPath, node.depth)
    const folderBusy = busyId.includes(folderPath)
    const isFolderDragOver = enableDragReorder
      && dropHover?.kind === 'folder'
      && dropHover.path === folderPath
    const canDragFolder = enableDragReorder && !busyId && editingFolder !== folderPath
    const folderPlaceAfter = isFolderDragOver && dropHover?.kind === 'folder' ? dropHover.placeAfter : false
    const isDraggingSelf = pointerDragging
      && pointerDragRef.current?.payload.type === 'folder'
      && pointerDragRef.current.payload.path === folderPath

    return (
      <div
        key={folderPath || '__root'}
        className={`asset-folder ${isRoot && dropHover?.kind === 'root' ? 'is-drop-target' : ''}`}
        style={{ '--folder-depth': node.depth } as CSSProperties}
        data-library-drop={isRoot ? 'root' : undefined}
      >
        {!isRoot ? (
          <div
            className={[
              'asset-folder__row',
              enableDragReorder ? 'has-grip' : '',
              isFolderDragOver ? 'is-drop-target' : '',
              isFolderDragOver && folderPlaceAfter ? 'is-drop-after' : '',
              isFolderDragOver && !folderPlaceAfter ? 'is-drop-before' : '',
              isDraggingSelf ? 'is-dragging' : '',
            ].filter(Boolean).join(' ')}
            data-library-drop={`folder:${folderPath}`}
          >
            {enableDragReorder ? (
              <span
                className="asset-library__grip"
                title="按住拖动排序 / 移动"
                onPointerDown={(event) => {
                  if (!canDragFolder) return
                  onGripPointerDown(event, { type: 'folder', path: folderPath, parent: parentOf(folderPath) })
                }}
              >
                <GripVertical size={11} />
              </span>
            ) : null}
            <button
              type="button"
              className="asset-folder__head"
              onClick={() => toggleFolder(folderPath)}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              <Folder size={13} />
              {editingFolder === folderPath ? (
                <input
                  className="asset-library__rename"
                  value={draftName}
                  autoFocus
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setDraftName(event.target.value)}
                  onBlur={() => onRenameInputBlur(() => commitRenameFolder(folderPath))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void commitRenameFolder(folderPath)
                    }
                    if (event.key === 'Escape') setEditingFolder('')
                  }}
                />
              ) : (
                <span>{node.name}</span>
              )}
              <em>{countSubtreeAssets(tree.nodes, folderPath)}</em>
            </button>
            <div className="asset-library__actions asset-folder__actions">
              <button
                type="button"
                className={`icon-button ${editingFolder === folderPath ? 'is-active' : ''}`}
                title={editingFolder === folderPath ? '完成重命名' : '重命名文件夹'}
                disabled={Boolean(busyId)}
                onMouseDown={(event) => {
                  event.stopPropagation()
                  if (editingFolder === folderPath) renameCommitFromButtonRef.current = true
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleRenameFolder(folderPath, node.name)
                }}
              >
                {editingFolder === folderPath ? <Check size={12} /> : <Pencil size={12} />}
              </button>
              <button
                type="button"
                data-delete-confirm={pendingDeleteFolder === folderPath ? '1' : undefined}
                className={`icon-button icon-button--danger ${pendingDeleteFolder === folderPath ? 'is-confirm' : ''}`}
                title={pendingDeleteFolder === folderPath ? '再次点击确认删除' : '删除文件夹'}
                disabled={Boolean(busyId)}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleDeleteFolder(folderPath, node.name)
                }}
              >
                {folderBusy && busyId.startsWith('delete-folder:')
                  ? <LoaderCircle className="spin" size={12} />
                  : pendingDeleteFolder === folderPath
                    ? <Check size={12} />
                    : <Trash2 size={12} />}
              </button>
            </div>
          </div>
        ) : null}

        {!isCollapsed ? (
          <div className={`asset-folder__body ${isRoot ? 'is-root' : ''}`}>
            {node.assets.map((asset) => {
              const active = activeRelativePath === asset.relativePath
              const rowBusy = busyId.includes(asset.id) || busyId.includes(asset.relativePath)
              const isAssetDragOver = enableDragReorder
                && dropHover?.kind === 'asset'
                && dropHover.relativePath === asset.relativePath
              const canDragAsset = enableDragReorder && !busyId && editingId !== asset.id
              const assetPlaceAfter = isAssetDragOver && dropHover?.kind === 'asset' ? dropHover.placeAfter : false
              const isDraggingSelf = pointerDragging
                && pointerDragRef.current?.payload.type === 'asset'
                && pointerDragRef.current.payload.relativePath === asset.relativePath
              return (
                <div
                  key={asset.id}
                  className={[
                    'asset-library__item',
                    enableDragReorder ? 'has-grip' : '',
                    active ? 'is-active' : '',
                    isAssetDragOver ? 'is-drop-target' : '',
                    isAssetDragOver && assetPlaceAfter ? 'is-drop-after' : '',
                    isAssetDragOver && !assetPlaceAfter ? 'is-drop-before' : '',
                    isDraggingSelf ? 'is-dragging' : '',
                  ].filter(Boolean).join(' ')}
                  data-library-drop={`asset:${asset.relativePath}`}
                >
                  {enableDragReorder ? (
                    <span
                      className="asset-library__grip"
                      title="按住拖动排序 / 移动"
                      onPointerDown={(event) => {
                        if (!canDragAsset) return
                        onGripPointerDown(event, {
                          type: 'asset',
                          relativePath: asset.relativePath,
                          folder: asset.folder,
                        })
                      }}
                    >
                      <GripVertical size={11} />
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="asset-library__apply"
                    disabled={Boolean(busyId) || !onApply}
                    onClick={() => void applyAsset(asset)}
                    title={asset.relativePath}
                  >
                    <span className="asset-library__icon">
                      {rowBusy && busyId.startsWith('apply:')
                        ? <LoaderCircle className="spin" size={12} />
                        : active ? <Check size={12} /> : <FileUp size={12} />}
                    </span>
                    {editingId === asset.id ? (
                      <input
                        className="asset-library__rename"
                        value={draftName}
                        autoFocus
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setDraftName(event.target.value)}
                        onBlur={() => onRenameInputBlur(() => commitRename(asset))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void commitRename(asset)
                          }
                          if (event.key === 'Escape') setEditingId('')
                        }}
                      />
                    ) : (
                      <strong className="asset-library__name">{asset.name}</strong>
                    )}
                    <span className="asset-library__meta">
                      {kind === 'cube' && asset.lutSize ? (
                        <small className="asset-library__lut-size">{asset.lutSize} 点</small>
                      ) : null}
                      <small className="asset-library__size">{formatBytes(asset.sizeBytes)}</small>
                    </span>
                  </button>
                  <div className="asset-library__actions">
                    <button
                      type="button"
                      className={`icon-button ${editingId === asset.id ? 'is-active' : ''}`}
                      title={editingId === asset.id ? '完成重命名' : '重命名'}
                      disabled={Boolean(busyId)}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        if (editingId === asset.id) renameCommitFromButtonRef.current = true
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleRenameAsset(asset)
                      }}
                    >
                      {editingId === asset.id ? <Check size={12} /> : <Pencil size={12} />}
                    </button>
                    <button
                      type="button"
                      data-delete-confirm={pendingDeleteId === asset.id ? '1' : undefined}
                      className={`icon-button icon-button--danger ${pendingDeleteId === asset.id ? 'is-confirm' : ''}`}
                      title={pendingDeleteId === asset.id ? '再次点击确认删除' : '从资料库删除'}
                      disabled={Boolean(busyId)}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleDeleteAsset(asset)
                      }}
                    >
                      {rowBusy && busyId.startsWith('delete:')
                        ? <LoaderCircle className="spin" size={12} />
                        : pendingDeleteId === asset.id
                          ? <Check size={12} />
                          : <Trash2 size={12} />}
                    </button>
                  </div>
                </div>
              )
            })}
            {node.childPaths.map((child) => renderFolder(child))}
          </div>
        ) : null}
      </div>
    )
  }

  const togglePanelCollapsed = () => {
    setPanelCollapsed((current) => !current)
    setMenuOpen(false)
  }

  return (
    <section
      className={[
        'asset-library',
        enableDragReorder ? 'asset-library--manage' : '',
        assets.length === 0 && !loading ? 'is-empty' : '',
        menuOpen ? 'is-menu-open' : '',
        panelCollapsed ? 'is-panel-collapsed' : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      <div className="asset-library__head">
        <button
          type="button"
          className="asset-library__fold"
          title={panelCollapsed ? '展开资料库' : '折叠资料库'}
          aria-label={panelCollapsed ? '展开资料库' : '折叠资料库'}
          aria-expanded={!panelCollapsed}
          onClick={togglePanelCollapsed}
        >
          {panelCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <strong
          className="asset-library__title"
          title="双击折叠 / 展开"
          onDoubleClick={(event) => {
            event.preventDefault()
            togglePanelCollapsed()
          }}
        >
          {title}
        </strong>
        <em className="asset-library__count">{assets.length ? `${assets.length}` : '0'}</em>
        {importMenu}
      </div>

      {!panelCollapsed ? (
        loading ? (
          <div className="asset-library__empty asset-library__empty--quiet">
            <LoaderCircle className="spin" size={14} /> 加载中…
          </div>
        ) : assets.length === 0 ? (
          <div className="asset-library__empty">
            <span>{emptyHint}</span>
          </div>
        ) : (
          <div
            ref={treeRootRef}
            className={`asset-library__tree ${pointerDragging ? 'is-dragging' : ''}`}
            data-library-drop="root"
          >
            {renderFolder('')}
          </div>
        )
      ) : null}
    </section>
  )
}
