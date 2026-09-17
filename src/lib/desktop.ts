import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { configDir, dirname, join, pictureDir } from '@tauri-apps/api/path'
import { open, save } from '@tauri-apps/plugin-dialog'
import { load } from '@tauri-apps/plugin-store'
import type {
  ColorWorkflowSuggestion, DeleteWorkspacePhotosReport, GeneratedImageResult, ImageGenerationRequestOptions, ImageGenerationRuntimeConfig, ModelColorParameters,
  ModelProvider, ModelSettings, ResolvedWorkspacePhoto, SourceVolume, VisionRuntimeConfig, VolumePolicy, WorkspaceCacheReport,
  WorkspaceDiskSpace, WorkspaceImportEntry, WorkspaceImportProgress, WorkspaceImportReport, WorkspaceInfo, WorkspaceManifest,
  WorkspaceReferenceEntry, WorkspacePhotoProperties, WorkspaceVolumeAbsence, VolumePolicyRecord,
} from './types'
import { DEFAULT_MODEL_SETTINGS } from './defaults'
import { normalizeModelSettings } from './modelSettings'
import { detectCubeLutSize } from './cubeLut'

const STORE_PATH = 'settings.json'
const MODEL_SETTINGS_KEY = 'modelSettingsV2'
const LEGACY_MODEL_KEY = 'modelConfig'
const LAST_IMAGE_DIRECTORY_KEY = 'lastImageDirectory'
const LAST_LIGHTROOM_XMP_PATH_KEY = 'lastLightroomXmpPath'
const LAST_CUBE_LUT_PATH_KEY = 'lastCubeLutPath'
const browserApiKeys = new Map<string, string>()

/** Camera RAW extensions decoded natively via rawler (Tauri only). */
export const RAW_EXTENSIONS = [
  '3fr', 'ari', 'arw', 'bay', 'cr2', 'cr3', 'crw', 'cs1', 'dcr', 'dng', 'erf', 'fff', 'iiq',
  'k25', 'kdc', 'mdc', 'mef', 'mos', 'mrw', 'nef', 'nrw', 'obm', 'orf', 'pef', 'ptx', 'pxn',
  'r3d', 'raf', 'raw', 'rw2', 'rwl', 'sr2', 'srf', 'srw', 'x3f',
] as const

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', ...RAW_EXTENSIONS] as const

export const isTauri = () => '__TAURI_INTERNALS__' in window

export function isRawPath(pathOrName: string) {
  const extension = pathOrName.split('.').pop()?.toLowerCase() || ''
  return (RAW_EXTENSIONS as readonly string[]).includes(extension)
}

async function imageDefaultPath() {
  try {
    const store = await load(STORE_PATH)
    const lastDirectory = await store.get<unknown>(LAST_IMAGE_DIRECTORY_KEY)
    if (typeof lastDirectory === 'string' && lastDirectory) return lastDirectory
  } catch {
    // Store access should never block the native file dialog.
  }

  try {
    return await pictureDir()
  } catch {
    return undefined
  }
}

export async function pickImagePath() {
  if (!isTauri()) return null
  const defaultPath = await imageDefaultPath()
  const options = {
    multiple: false as const,
    directory: false as const,
    title: '选择图片 / RAW',
    filters: [
      { name: '图片与相机 RAW', extensions: [...IMAGE_EXTENSIONS] },
      { name: '相机 RAW', extensions: [...RAW_EXTENSIONS] },
      { name: 'JPEG / PNG / WebP', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
    ],
  }
  let selected: string | string[] | null

  try {
    selected = await open({ ...options, defaultPath })
  } catch (error) {
    if (!defaultPath) throw error
    selected = await open(options)
  }

  if (typeof selected !== 'string') return null
  try {
    const store = await load(STORE_PATH)
    await store.set(LAST_IMAGE_DIRECTORY_KEY, await dirname(selected))
    await store.save()
  } catch {
    // The selected image can still be opened if remembering its directory fails.
  }
  return selected
}

async function lightroomXmpDefaultPath() {
  try {
    const store = await load(STORE_PATH)
    const lastSelectedPath = await store.get<unknown>(LAST_LIGHTROOM_XMP_PATH_KEY)
    if (typeof lastSelectedPath === 'string' && lastSelectedPath) return lastSelectedPath
  } catch {
    // Store access should never block the native file dialog.
  }

  try {
    return await join(await configDir(), 'Adobe', 'CameraRaw', 'Settings')
  } catch {
    return undefined
  }
}

export async function pickLightroomXmpPath() {
  if (!isTauri()) return null

  const options = {
    multiple: false as const,
    directory: false as const,
    title: '选择 Lightroom XMP 预设',
    filters: [{ name: 'Lightroom XMP 预设', extensions: ['xmp'] }],
  }
  const defaultPath = await lightroomXmpDefaultPath()
  let selected: string | string[] | null

  try {
    selected = await open({ ...options, defaultPath })
  } catch (error) {
    if (!defaultPath) throw error
    selected = await open(options)
  }

  if (typeof selected !== 'string') return null
  try {
    const store = await load(STORE_PATH)
    await store.set(LAST_LIGHTROOM_XMP_PATH_KEY, await dirname(selected))
    await store.save()
  } catch {
    // The selected preset can still be imported if remembering the path fails.
  }
  return selected
}

export async function readNativeFile(path: string) {
  return new Uint8Array(await invoke<number[]>('read_binary_file', { path }))
}

/** Decode camera RAW to sRGB JPEG bytes (Tauri / rawler). */
export async function decodeRawNative(path: string, maxSide = 4000) {
  return new Uint8Array(await invoke<number[]>('decode_raw_file', { path, maxSide }))
}

async function cubeLutDefaultPath() {
  try {
    const store = await load(STORE_PATH)
    const lastSelectedPath = await store.get<unknown>(LAST_CUBE_LUT_PATH_KEY)
    if (typeof lastSelectedPath === 'string' && lastSelectedPath) return lastSelectedPath
  } catch {
    // ignore
  }
  return undefined
}

export async function pickCubeLutPath() {
  if (!isTauri()) return null
  const options = {
    multiple: false as const,
    directory: false as const,
    title: '选择 CUBE LUT',
    filters: [{ name: 'Adobe CUBE LUT', extensions: ['cube'] }],
  }
  const defaultPath = await cubeLutDefaultPath()
  let selected: string | string[] | null
  try {
    selected = await open({ ...options, defaultPath })
  } catch (error) {
    if (!defaultPath) throw error
    selected = await open(options)
  }
  if (typeof selected !== 'string') return null
  try {
    const store = await load(STORE_PATH)
    await store.set(LAST_CUBE_LUT_PATH_KEY, await dirname(selected))
    await store.save()
  } catch {
    // ignore
  }
  return selected
}

export interface LibraryLocation {
  path: string
  isCustom: boolean
}

export interface LibraryMigrationProgress {
  migrationId: string
  phase: 'scanning' | 'copying' | 'finalizing' | 'completed'
  copiedBytes: number
  totalBytes: number
  copiedFiles: number
  totalFiles: number
  percent: number
  currentFile: string | null
}

export interface LibraryMigrationResult {
  path: string
  copiedBytes: number
  copiedFiles: number
  cleanupWarning: string | null
}

export async function getLibraryLocation(): Promise<LibraryLocation | null> {
  if (!isTauri()) return null
  return invoke<LibraryLocation>('get_library_location')
}

export async function openLibraryFolder() {
  if (!isTauri()) throw new Error('仅桌面客户端支持打开资料库文件夹')
  await invoke('open_library_folder')
}

export async function pickLibraryLocation(defaultPath?: string) {
  if (!isTauri()) return null
  const options = {
    multiple: false as const,
    directory: true as const,
    recursive: true as const,
    title: '选择新的资料库位置（须为空文件夹）',
  }
  let selected: string | string[] | null
  try {
    selected = await open(defaultPath ? { ...options, defaultPath } : options)
  } catch (error) {
    if (!defaultPath) throw error
    selected = await open(options)
  }
  return typeof selected === 'string'
    ? selected
    : Array.isArray(selected) && typeof selected[0] === 'string'
      ? selected[0]
      : null
}

export async function migrateLibraryLocation(
  destinationPath: string,
  migrationId: string,
  onProgress: (progress: LibraryMigrationProgress) => void,
): Promise<LibraryMigrationResult> {
  if (!isTauri()) throw new Error('仅桌面客户端支持迁移资料库')
  let unlisten: UnlistenFn | undefined
  try {
    unlisten = await listen<LibraryMigrationProgress>('library-migration-progress', ({ payload }) => {
      if (payload.migrationId === migrationId) onProgress(payload)
    })
    return await invoke<LibraryMigrationResult>('migrate_library_location', {
      destinationPath,
      migrationId,
    })
  } finally {
    unlisten?.()
  }
}

export type LibraryAssetKind = 'xmp' | 'cube'

export interface LibraryAsset {
  id: string
  kind: LibraryAssetKind
  name: string
  fileName: string
  /** Relative path under kind root, e.g. `Portrait/warm.xmp`. */
  relativePath: string
  /** Parent folder path; empty for root. */
  folder: string
  sizeBytes: number
  modifiedMs: number
  /** Declared 3D lattice size for CUBE assets; null for XMP or unreadable headers. */
  lutSize: number | null
}

const browserLibrary = {
  xmp: new Map<string, { asset: LibraryAsset; text: string }>(),
  cube: new Map<string, { asset: LibraryAsset; text: string }>(),
}

function normalizeRelativeKey(path: string, kind: LibraryAssetKind) {
  const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '')
  const withExt = cleaned.toLowerCase().endsWith(`.${kind}`) ? cleaned : `${cleaned}.${kind}`
  return withExt.split('/').map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim() || 'item').join('/')
}

function assetFromRelative(
  kind: LibraryAssetKind,
  relativePath: string,
  sizeBytes: number,
  lutSize: number | null = null,
): LibraryAsset {
  const fileName = relativePath.split('/').pop() || relativePath
  const folder = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
  return {
    id: `${kind}:${relativePath}`,
    kind,
    name: fileName.replace(new RegExp(`\\.${kind}$`, 'i'), ''),
    fileName,
    relativePath,
    folder,
    sizeBytes,
    modifiedMs: Date.now(),
    lutSize,
  }
}

function browserList(kind: LibraryAssetKind): LibraryAsset[] {
  return [...browserLibrary[kind].values()]
    .map((entry) => entry.asset)
    .sort((left, right) =>
      left.folder.localeCompare(right.folder, 'zh')
      || left.name.localeCompare(right.name, 'zh')
      || right.modifiedMs - left.modifiedMs,
    )
}

export async function listLibraryAssets(kind: LibraryAssetKind): Promise<LibraryAsset[]> {
  if (!isTauri()) return browserList(kind)
  return invoke<LibraryAsset[]>('list_library_assets', { kind })
}

export async function importLibraryAssetFromPath(
  kind: LibraryAssetKind,
  sourcePath: string,
  relativePath?: string,
) {
  if (!isTauri()) throw new Error('浏览器环境请使用文件选择导入')
  return invoke<LibraryAsset>('import_library_asset', {
    kind,
    sourcePath,
    relativePath: relativePath || null,
  })
}

export async function importLibraryFolder(kind: LibraryAssetKind, folderPath: string) {
  if (!isTauri()) throw new Error('浏览器环境暂不支持整夹导入')
  return invoke<LibraryAsset[]>('import_library_folder', { kind, folderPath })
}

export async function importLibraryAssetBytes(
  kind: LibraryAssetKind,
  relativePath: string,
  data: Uint8Array | string,
) {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
  const key = normalizeRelativeKey(relativePath, kind)
  if (!isTauri()) {
    const asset = assetFromRelative(
      kind,
      key,
      new TextEncoder().encode(text).length,
      kind === 'cube' ? detectCubeLutSize(text) : null,
    )
    browserLibrary[kind].set(key, { asset, text })
    return asset
  }
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return invoke<LibraryAsset>('import_library_asset_bytes', {
    kind,
    relativePath: key,
    data: Array.from(bytes),
  })
}

export async function readLibraryAssetText(kind: LibraryAssetKind, relativePath: string) {
  if (!isTauri()) {
    const entry = browserLibrary[kind].get(relativePath) || browserLibrary[kind].get(normalizeRelativeKey(relativePath, kind))
    if (!entry) throw new Error('资料库中找不到该文件')
    return entry.text
  }
  return invoke<string>('read_library_asset_text', { kind, relativePath })
}

export async function deleteLibraryAsset(kind: LibraryAssetKind, relativePath: string) {
  if (!isTauri()) {
    browserLibrary[kind].delete(relativePath)
    browserLibrary[kind].delete(normalizeRelativeKey(relativePath, kind))
    return
  }
  await invoke('delete_library_asset', { kind, relativePath })
}

export async function renameLibraryAsset(kind: LibraryAssetKind, relativePath: string, newName: string) {
  if (!isTauri()) {
    const key = normalizeRelativeKey(relativePath, kind)
    const entry = browserLibrary[kind].get(key) || browserLibrary[kind].get(relativePath)
    if (!entry) throw new Error('资料库中找不到该文件')
    const folder = entry.asset.folder
    const nextFile = newName.toLowerCase().endsWith(`.${kind}`) ? newName : `${newName}.${kind}`
    const nextRel = folder ? `${folder}/${nextFile}` : nextFile
    browserLibrary[kind].delete(entry.asset.relativePath)
    const asset = assetFromRelative(kind, nextRel, entry.asset.sizeBytes, entry.asset.lutSize)
    browserLibrary[kind].set(nextRel, { asset, text: entry.text })
    await rewriteLibraryOrderKeys(kind, relativePath, nextRel)
    return asset
  }
  const asset = await invoke<LibraryAsset>('rename_library_asset', { kind, relativePath, newName })
  await rewriteLibraryOrderKeys(kind, relativePath, asset.relativePath)
  return asset
}

function normalizeFolderKey(path: string) {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim() || 'folder')
    .filter(Boolean)
    .join('/')
}

function isUnderFolderPath(path: string, folder: string) {
  if (!folder) return true
  return path === folder || path.startsWith(`${folder}/`)
}

function rewritePrefix(path: string, from: string, to: string) {
  if (path === from) return to
  if (path.startsWith(`${from}/`)) {
    const rest = path.slice(from.length + 1)
    return to ? `${to}/${rest}` : rest
  }
  return path
}

const LIBRARY_ORDER_KEY = (kind: LibraryAssetKind) => `libraryOrderV1:${kind}`

export interface LibraryOrderState {
  /** Sibling folder order keyed by parent folder path ('' = root). */
  folders: Record<string, string[]>
  /** Sibling asset order keyed by folder path ('' = root). */
  assets: Record<string, string[]>
}

function emptyLibraryOrder(): LibraryOrderState {
  return { folders: {}, assets: {} }
}

function normalizeOrderState(value: unknown): LibraryOrderState {
  if (!value || typeof value !== 'object') return emptyLibraryOrder()
  const raw = value as Partial<LibraryOrderState>
  return {
    folders: raw.folders && typeof raw.folders === 'object' ? { ...raw.folders } : {},
    assets: raw.assets && typeof raw.assets === 'object' ? { ...raw.assets } : {},
  }
}

export async function loadLibraryOrder(kind: LibraryAssetKind): Promise<LibraryOrderState> {
  if (!isTauri()) {
    try {
      const raw = localStorage.getItem(LIBRARY_ORDER_KEY(kind))
      return normalizeOrderState(raw ? JSON.parse(raw) : null)
    } catch {
      return emptyLibraryOrder()
    }
  }
  try {
    const store = await load(STORE_PATH)
    return normalizeOrderState(await store.get<unknown>(LIBRARY_ORDER_KEY(kind)))
  } catch {
    return emptyLibraryOrder()
  }
}

export async function saveLibraryOrder(kind: LibraryAssetKind, order: LibraryOrderState) {
  const next = normalizeOrderState(order)
  if (!isTauri()) {
    localStorage.setItem(LIBRARY_ORDER_KEY(kind), JSON.stringify(next))
    return
  }
  const store = await load(STORE_PATH)
  await store.set(LIBRARY_ORDER_KEY(kind), next)
  await store.save()
}

async function rewriteLibraryOrderKeys(kind: LibraryAssetKind, from: string, to: string) {
  if (!from || from === to) return
  const order = await loadLibraryOrder(kind)
  let changed = false
  const rewriteList = (list: string[] | undefined) =>
    (list || []).map((item) => {
      const next = rewritePrefix(item, from, to)
      if (next !== item) changed = true
      return next
    })
  const nextFolders: Record<string, string[]> = {}
  for (const [parent, children] of Object.entries(order.folders)) {
    const nextParent = rewritePrefix(parent, from, to)
    if (nextParent !== parent) changed = true
    nextFolders[nextParent] = rewriteList(children)
  }
  const nextAssets: Record<string, string[]> = {}
  for (const [folder, children] of Object.entries(order.assets)) {
    const nextFolder = rewritePrefix(folder, from, to)
    if (nextFolder !== folder) changed = true
    nextAssets[nextFolder] = rewriteList(children)
  }
  if (changed) await saveLibraryOrder(kind, { folders: nextFolders, assets: nextAssets })
}

async function removeLibraryOrderKeys(kind: LibraryAssetKind, prefix: string) {
  if (!prefix) return
  const order = await loadLibraryOrder(kind)
  let changed = false
  const keep = (path: string) => {
    if (isUnderFolderPath(path, prefix)) {
      changed = true
      return false
    }
    return true
  }
  const nextFolders: Record<string, string[]> = {}
  for (const [parent, children] of Object.entries(order.folders)) {
    if (!keep(parent) && parent !== '') continue
    const filtered = children.filter(keep)
    if (filtered.length !== children.length) changed = true
    nextFolders[parent] = filtered
  }
  const nextAssets: Record<string, string[]> = {}
  for (const [folder, children] of Object.entries(order.assets)) {
    if (!keep(folder) && folder !== '') continue
    const filtered = children.filter(keep)
    if (filtered.length !== children.length) changed = true
    nextAssets[folder] = filtered
  }
  if (changed) await saveLibraryOrder(kind, { folders: nextFolders, assets: nextAssets })
}

export async function renameLibraryFolder(kind: LibraryAssetKind, folderPath: string, newName: string) {
  const folder = normalizeFolderKey(folderPath)
  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : ''
  const nextName = newName.trim().replace(/[<>:"|?*\\/]/g, '_').replace(/^\.+|\.+$/g, '') || 'folder'
  const nextFolder = parent ? `${parent}/${nextName}` : nextName
  if (!isTauri()) {
    if (nextFolder === folder) return browserList(kind).filter((asset) => isUnderFolderPath(asset.folder, folder) || asset.folder === folder)
    const entries = [...browserLibrary[kind].entries()]
    for (const [key, entry] of entries) {
      if (!isUnderFolderPath(entry.asset.relativePath, folder) && !isUnderFolderPath(entry.asset.folder, folder)) continue
      const nextRel = rewritePrefix(entry.asset.relativePath, folder, nextFolder)
      browserLibrary[kind].delete(key)
      const asset = assetFromRelative(kind, nextRel, entry.asset.sizeBytes, entry.asset.lutSize)
      browserLibrary[kind].set(nextRel, { asset, text: entry.text })
    }
    await rewriteLibraryOrderKeys(kind, folder, nextFolder)
    return browserList(kind).filter((asset) => isUnderFolderPath(asset.folder, nextFolder) || asset.folder === nextFolder)
  }
  const assets = await invoke<LibraryAsset[]>('rename_library_folder', { kind, folderPath: folder, newName: nextName })
  await rewriteLibraryOrderKeys(kind, folder, nextFolder)
  return assets
}

export async function deleteLibraryFolder(kind: LibraryAssetKind, folderPath: string) {
  const folder = normalizeFolderKey(folderPath)
  if (!isTauri()) {
    let deleted = 0
    for (const [key, entry] of [...browserLibrary[kind].entries()]) {
      if (isUnderFolderPath(entry.asset.folder, folder) || isUnderFolderPath(entry.asset.relativePath, folder)) {
        browserLibrary[kind].delete(key)
        deleted += 1
      }
    }
    await removeLibraryOrderKeys(kind, folder)
    return deleted
  }
  const deleted = await invoke<number>('delete_library_folder', { kind, folderPath: folder })
  await removeLibraryOrderKeys(kind, folder)
  return deleted
}

export async function moveLibraryAsset(kind: LibraryAssetKind, relativePath: string, targetFolder: string) {
  const target = targetFolder.trim() ? normalizeFolderKey(targetFolder) : ''
  if (!isTauri()) {
    const key = normalizeRelativeKey(relativePath, kind)
    const entry = browserLibrary[kind].get(key) || browserLibrary[kind].get(relativePath)
    if (!entry) throw new Error('资料库中找不到该文件')
    const fileName = entry.asset.fileName
    const nextRel = target ? `${target}/${fileName}` : fileName
    if (nextRel === entry.asset.relativePath) return entry.asset
    browserLibrary[kind].delete(entry.asset.relativePath)
    const asset = assetFromRelative(kind, nextRel, entry.asset.sizeBytes, entry.asset.lutSize)
    browserLibrary[kind].set(nextRel, { asset, text: entry.text })
    // Order lists are updated by the panel (folder membership changes).
    return asset
  }
  return invoke<LibraryAsset>('move_library_asset', {
    kind,
    relativePath,
    targetFolder: target,
  })
}

export async function moveLibraryFolder(kind: LibraryAssetKind, folderPath: string, targetParent: string) {
  const folder = normalizeFolderKey(folderPath)
  const parent = targetParent.trim() ? normalizeFolderKey(targetParent) : ''
  const name = folder.includes('/') ? folder.slice(folder.lastIndexOf('/') + 1) : folder
  const nextFolder = parent ? `${parent}/${name}` : name
  if (nextFolder === folder || isUnderFolderPath(nextFolder, folder)) {
    throw new Error('不能将文件夹移动到自身或其子文件夹中')
  }
  if (!isTauri()) {
    const entries = [...browserLibrary[kind].entries()]
    for (const [key, entry] of entries) {
      if (!isUnderFolderPath(entry.asset.relativePath, folder) && !isUnderFolderPath(entry.asset.folder, folder)) continue
      const nextRel = rewritePrefix(entry.asset.relativePath, folder, nextFolder)
      browserLibrary[kind].delete(key)
      const asset = assetFromRelative(kind, nextRel, entry.asset.sizeBytes, entry.asset.lutSize)
      browserLibrary[kind].set(nextRel, { asset, text: entry.text })
    }
    await rewriteLibraryOrderKeys(kind, folder, nextFolder)
    return browserList(kind).filter((asset) => isUnderFolderPath(asset.folder, nextFolder) || asset.folder === nextFolder)
  }
  const assets = await invoke<LibraryAsset[]>('move_library_folder', {
    kind,
    folderPath: folder,
    targetParent: parent,
  })
  await rewriteLibraryOrderKeys(kind, folder, nextFolder)
  return assets
}

/** Pick external file(s) and copy into the app library root. */
export async function pickAndImportLibraryAssets(kind: LibraryAssetKind, multiple = true) {
  if (!isTauri()) return [] as LibraryAsset[]
  const filters = kind === 'xmp'
    ? [{ name: 'Lightroom XMP', extensions: ['xmp'] }]
    : [{ name: 'Adobe CUBE LUT', extensions: ['cube'] }]
  const defaultPath = kind === 'xmp' ? await lightroomXmpDefaultPath() : await cubeLutDefaultPath()
  const options = {
    multiple,
    directory: false as const,
    title: kind === 'xmp' ? '导入 XMP 到资料库' : '导入 CUBE 到资料库',
    filters,
  }
  let selected: string | string[] | null
  try {
    selected = await open({ ...options, defaultPath })
  } catch (error) {
    if (!defaultPath) throw error
    selected = await open(options)
  }
  const paths = typeof selected === 'string' ? [selected] : Array.isArray(selected) ? selected : []
  const imported: LibraryAsset[] = []
  for (const path of paths) {
    imported.push(await importLibraryAssetFromPath(kind, path))
  }
  if (paths[0]) {
    try {
      const store = await load(STORE_PATH)
      const key = kind === 'xmp' ? LAST_LIGHTROOM_XMP_PATH_KEY : LAST_CUBE_LUT_PATH_KEY
      await store.set(key, await dirname(paths[0]))
      await store.save()
    } catch {
      // ignore
    }
  }
  return imported
}

/** Pick a folder and import matching assets with folder hierarchy preserved. */
export async function pickAndImportLibraryFolder(kind: LibraryAssetKind) {
  if (!isTauri()) return [] as LibraryAsset[]
  const defaultPath = kind === 'xmp' ? await lightroomXmpDefaultPath() : await cubeLutDefaultPath()
  const options = {
    multiple: false as const,
    directory: true as const,
    recursive: true as const,
    title: kind === 'xmp' ? '选择 XMP 文件夹导入' : '选择 CUBE 文件夹导入',
  }
  let selected: string | string[] | null
  try {
    selected = await open(defaultPath ? { ...options, defaultPath } : options)
  } catch (error) {
    // Retry without defaultPath if the remembered path is invalid.
    selected = await open(options)
    if (!selected && error) {
      // fall through
    }
  }
  // Tauri may return a string path, or rarely an array when multi-select quirks apply.
  const folderPath = typeof selected === 'string'
    ? selected
    : Array.isArray(selected) && typeof selected[0] === 'string'
      ? selected[0]
      : null
  if (!folderPath) return [] as LibraryAsset[]
  try {
    const store = await load(STORE_PATH)
    const key = kind === 'xmp' ? LAST_LIGHTROOM_XMP_PATH_KEY : LAST_CUBE_LUT_PATH_KEY
    await store.set(key, folderPath)
    await store.save()
  } catch {
    // ignore
  }
  return importLibraryFolder(kind, folderPath)
}

export async function saveJpegNative(bytes: Uint8Array, defaultName: string, title = '导出调色效果图') {
  if (!isTauri()) {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'image/jpeg' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = defaultName
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return defaultName
  }
  const path = await save({
    title,
    defaultPath: defaultName,
    filters: [{ name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }],
  })
  if (!path) return null
  await invoke('write_binary_file', { path, data: Array.from(bytes) })
  return path
}

export async function loadModelSettings(): Promise<ModelSettings> {
  if (!isTauri()) {
    const current = localStorage.getItem(MODEL_SETTINGS_KEY)
    if (current) return normalizeModelSettings(JSON.parse(current))
    const legacy = localStorage.getItem(LEGACY_MODEL_KEY)
    const migrated = normalizeModelSettings(legacy ? JSON.parse(legacy) : DEFAULT_MODEL_SETTINGS)
    localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify(migrated))
    return migrated
  }
  const store = await load(STORE_PATH)
  const current = await store.get<unknown>(MODEL_SETTINGS_KEY)
  if (current) return normalizeModelSettings(current)
  const legacy = await store.get<unknown>(LEGACY_MODEL_KEY)
  const migrated = normalizeModelSettings(legacy || DEFAULT_MODEL_SETTINGS)
  await store.set(MODEL_SETTINGS_KEY, migrated)
  await store.save()
  return migrated
}

export async function persistModelSettings(settings: ModelSettings) {
  if (!isTauri()) {
    localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify(settings))
    return
  }
  const store = await load(STORE_PATH)
  await store.set(MODEL_SETTINGS_KEY, settings)
  await store.save()
}

export async function saveProviderApiKey(providerId: string, apiKey: string) {
  if (!isTauri()) {
    browserApiKeys.set(providerId, apiKey)
    return
  }
  await invoke('save_api_key', { providerId, apiKey })
}

export async function removeProviderApiKey(providerId: string) {
  if (!isTauri()) {
    browserApiKeys.delete(providerId)
    return
  }
  await invoke('delete_api_key', { providerId })
}

export async function hasProviderApiKey(providerId: string) {
  if (!isTauri()) return Boolean(browserApiKeys.get(providerId))
  return invoke<boolean>('has_api_key', { providerId })
}

export async function testModelConnection(provider: ModelProvider) {
  if (!isTauri()) throw new Error('模型请求需要在桌面客户端中运行。')
  return invoke<string>('test_model_connection', { config: providerRuntimeConfig(provider) })
}

export async function analyzeWithModel(
  config: VisionRuntimeConfig,
  sourceDataUrl: string,
  referenceDataUrl: string,
  analysisContext: string,
) {
  if (!isTauri()) throw new Error('模型请求需要在桌面客户端中运行。')
  return invoke<ModelColorParameters>('analyze_with_model', {
    request: { config: visionRuntimeConfig(config), sourceDataUrl, referenceDataUrl, analysisContext },
  })
}

export async function refineMatchWithModel(
  config: VisionRuntimeConfig,
  sourceDataUrl: string,
  referenceDataUrl: string,
  resultDataUrl: string,
  analysisContext: string,
) {
  if (!isTauri()) throw new Error('模型请求需要在桌面客户端中运行。')
  return invoke<ModelColorParameters>('refine_match_with_model', {
    request: { config: visionRuntimeConfig(config), sourceDataUrl, referenceDataUrl, resultDataUrl, analysisContext },
  })
}

export async function suggestColorWorkflows(
  config: VisionRuntimeConfig,
  sourceDataUrl: string,
  stylePrompt = '',
) {
  if (!isTauri()) throw new Error('AI 调色分析需要在桌面客户端中运行。')
  return invoke<ColorWorkflowSuggestion[]>('suggest_color_workflows', {
    request: { config: visionRuntimeConfig(config), sourceDataUrl, stylePrompt },
  })
}

export async function optimizeColorPrompt(
  config: VisionRuntimeConfig,
  stylePrompt: string,
  sourceDataUrl?: string,
) {
  if (!isTauri()) throw new Error('提示词优化需要在桌面客户端中运行。')
  return invoke<string>('optimize_color_prompt', {
    request: { config: visionRuntimeConfig(config), stylePrompt, sourceDataUrl },
  })
}

export async function generateColoredImage(
  config: ImageGenerationRuntimeConfig,
  sourceDataUrl: string,
  workflow: ColorWorkflowSuggestion,
  customInstruction = '',
  imageOptions: ImageGenerationRequestOptions = {},
) {
  if (!isTauri()) throw new Error('图生图调色需要在桌面客户端中运行。')
  return invoke<GeneratedImageResult>('generate_colored_image', {
    request: {
      config: imageRuntimeConfig(config),
      sourceDataUrl,
      workflow,
      customInstruction,
      imageOptions,
    },
  })
}

function providerRuntimeConfig(provider: ModelProvider) {
  return {
    providerId: provider.id,
    baseUrl: provider.baseUrl.trim(),
    model: '',
    apiType: provider.apiType,
    timeoutSeconds: 30,
    imageModel: '',
    imageTimeoutSeconds: 30,
  }
}

function visionRuntimeConfig(config: VisionRuntimeConfig) {
  return {
    providerId: config.providerId,
    baseUrl: config.baseUrl.trim(),
    model: config.model.trim(),
    apiType: config.apiType,
    timeoutSeconds: config.timeoutSeconds,
    imageModel: '',
    imageTimeoutSeconds: config.timeoutSeconds,
  }
}

function imageRuntimeConfig(config: ImageGenerationRuntimeConfig) {
  return {
    providerId: config.providerId,
    baseUrl: config.baseUrl.trim(),
    model: '',
    apiType: config.apiType,
    timeoutSeconds: config.timeoutSeconds,
    imageModel: config.model.trim(),
    imageTimeoutSeconds: config.timeoutSeconds,
  }
}

// ---------------------------------------------------------------------------
// 工作区（多图导入 + 缩略图缓存）
// ---------------------------------------------------------------------------

/** V1 只有一个当前工作区；磁盘结构已按 `workspaces/<id>/` 预留多工作区。 */
export const DEFAULT_WORKSPACE_ID = 'default'

/** 浏览器预览用的工作区注册表：桌面端由 Rust 侧 `workspaces.json` 承载。 */
const browserWorkspaceRegistry: WorkspaceInfo[] = [
  { id: DEFAULT_WORKSPACE_ID, name: '默认工作区', createdAt: Date.now(), updatedAt: Date.now() },
]

/**
 * 列出全部工作区。
 *
 * 注册表只存名称等元数据；张数与封面由调用方按需读各工作区的 manifest 惰性补全。
 * 首次运行时 Rust 侧会以现有 `default` 目录播种，前端无需特殊处理。
 */
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  if (!isTauri()) return [...browserWorkspaceRegistry]
  return invoke<WorkspaceInfo[]>('list_workspaces')
}

export async function createWorkspace(name: string): Promise<WorkspaceInfo> {
  if (!isTauri()) {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('工作区名称不能为空')
    const base = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
    let id = base
    let index = 2
    while (browserWorkspaceRegistry.some((entry) => entry.id === id)) {
      id = `${base}-${index}`
      index += 1
    }
    const now = Date.now()
    const info: WorkspaceInfo = { id, name: trimmed, createdAt: now, updatedAt: now }
    browserWorkspaceRegistry.push(info)
    browserManifest(id)
    return info
  }
  return invoke<WorkspaceInfo>('create_workspace', { name })
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceInfo> {
  if (!isTauri()) {
    const entry = browserWorkspaceRegistry.find((item) => item.id === workspaceId)
    if (!entry) throw new Error('工作区不存在')
    entry.name = name.trim()
    entry.updatedAt = Date.now()
    return { ...entry }
  }
  return invoke<WorkspaceInfo>('rename_workspace', { workspaceId, name })
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  if (!isTauri()) {
    if (browserWorkspaceRegistry.length <= 1) throw new Error('至少需要保留一个工作区')
    const index = browserWorkspaceRegistry.findIndex((entry) => entry.id === workspaceId)
    if (index < 0) throw new Error('工作区不存在')
    browserWorkspaceRegistry.splice(index, 1)
    browserWorkspaces.delete(workspaceId)
    const prefix = `${workspaceId}|`
    for (const key of [...browserThumbnails.keys()]) {
      if (key.startsWith(prefix)) browserThumbnails.delete(key)
    }
    return
  }
  await invoke('delete_workspace', { workspaceId })
}

/** 多选文件选择器：工作区导入用。 */
export async function pickImagePaths(): Promise<string[]> {
  if (!isTauri()) return []
  const defaultPath = await imageDefaultPath()
  const options = {
    multiple: true as const,
    directory: false as const,
    title: '选择要导入工作区的图片 / RAW',
    filters: [
      { name: '图片与相机 RAW', extensions: [...IMAGE_EXTENSIONS] },
      { name: '相机 RAW', extensions: [...RAW_EXTENSIONS] },
      { name: 'JPEG / PNG / WebP', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
    ],
  }
  let selected: string | string[] | null
  try {
    selected = await open({ ...options, defaultPath })
  } catch (error) {
    if (!defaultPath) throw error
    selected = await open(options)
  }
  const paths = typeof selected === 'string' ? [selected] : Array.isArray(selected) ? selected : []
  if (paths[0]) {
    try {
      const store = await load(STORE_PATH)
      await store.set(LAST_IMAGE_DIRECTORY_KEY, await dirname(paths[0]))
      await store.save()
    } catch {
      // 记住目录失败不影响导入本身
    }
  }
  return paths
}

/**
 * 浏览器预览用的内存工作区：按 `workspaceId` 隔离，不伪造桌面复制语义，只保证组件不崩。
 *
 * 这里**必须**是 Map 而不是单个变量——多工作区下若共用一份 manifest，切换工作区在浏览器里
 * 会表现为「毫无变化」，从而掩盖真实的切换缺陷。
 */
const browserWorkspaces = new Map<string, WorkspaceManifest>()
/** 缩略图缓存：key 带上 workspaceId 前缀，避免不同工作区的同名图互相覆盖。 */
const browserThumbnails = new Map<string, Uint8Array>()

function browserThumbnailKey(workspaceId: string, key: string) {
  return `${workspaceId}|${key}`
}

function emptyBrowserManifest(workspaceId = DEFAULT_WORKSPACE_ID): WorkspaceManifest {
  const now = Date.now()
  return {
    version: 1,
    id: workspaceId,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    reference: null,
    photos: [],
  }
}

function browserManifest(workspaceId: string): WorkspaceManifest {
  const existing = browserWorkspaces.get(workspaceId)
  if (existing) return existing
  const created = emptyBrowserManifest(workspaceId)
  browserWorkspaces.set(workspaceId, created)
  return created
}

function setBrowserManifest(manifest: WorkspaceManifest) {
  browserWorkspaces.set(manifest.id, manifest)
}

export async function readWorkspaceManifest(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<WorkspaceManifest> {
  if (!isTauri()) return browserManifest(workspaceId)
  return invoke<WorkspaceManifest>('read_workspace_manifest', { workspaceId })
}

/** `expectedRevision` 用于乐观并发：磁盘 revision 不一致时后端拒绝覆盖。 */
export async function writeWorkspaceManifest(
  manifest: WorkspaceManifest,
  expectedRevision: number | null,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<WorkspaceManifest> {
  if (!isTauri()) {
    const next = { ...manifest, revision: manifest.revision + 1, updatedAt: Date.now() }
    setBrowserManifest(next)
    return next
  }
  return invoke<WorkspaceManifest>('write_workspace_manifest', {
    workspaceId,
    manifest,
    expectedRevision,
  })
}

/** 按挂载卷做三态判定。判定必须在 Rust 侧完成，前端只消费结论。 */
export async function classifySourceVolumes(paths: string[]): Promise<SourceVolume[]> {
  if (!isTauri()) {
    return [{
      rootPath: '浏览器预览',
      volumeId: 'browser-preview',
      label: '浏览器预览',
      driveType: 'fixed',
      recommendation: 'reference',
      rememberedPolicy: null,
      fileCount: paths.length,
      totalBytes: 0,
    }]
  }
  return invoke<SourceVolume[]>('classify_source_volumes', { paths })
}

/** 卷标识 → 当前挂载点。reference 模式靠它解析真实读取路径。 */
export async function resolveVolumeMount(volumeId: string): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('resolve_volume_mount', { volumeId })
}

export async function getVolumePolicies(): Promise<Record<string, VolumePolicyRecord>> {
  if (!isTauri()) return {}
  return invoke<Record<string, VolumePolicyRecord>>('get_volume_policies')
}

export async function setVolumePolicy(
  volumeId: string,
  policy: VolumePolicy,
  label = '',
): Promise<void> {
  if (!isTauri()) return
  await invoke('set_volume_policy', { volumeId, policy, label })
}

export async function clearVolumePolicies(): Promise<void> {
  if (!isTauri()) return
  await invoke('clear_volume_policies')
}

/** 单独清除某个卷的记忆。 */
export async function clearVolumePolicy(volumeId: string): Promise<void> {
  if (!isTauri()) return
  await invoke('clear_volume_policy', { volumeId })
}

/** 通用目录选择：卷重新定位等场景用。 */
export async function pickDirectory(title: string): Promise<string | null> {
  if (!isTauri()) return null
  const options = {
    multiple: false as const,
    directory: true as const,
    recursive: true as const,
    title,
  }
  const selected = await open(options)
  return typeof selected === 'string'
    ? selected
    : Array.isArray(selected) && typeof selected[0] === 'string'
      ? selected[0]
      : null
}

export async function importWorkspaceFiles(
  entries: WorkspaceImportEntry[],
  jobId: string,
  onProgress: (progress: WorkspaceImportProgress) => void,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<WorkspaceImportReport> {
  if (!isTauri()) {
    const now = Date.now()
    const imported = entries.map((entry) => ({
      id: `${entry.volumeId}|${entry.relativeSourcePath}`,
      volumeId: entry.volumeId,
      relativeSourcePath: entry.relativeSourcePath,
      sourcePath: entry.sourcePath,
      origin: entry.origin,
      workspacePath: null,
      status: 'ready' as const,
      sizeBytes: 0,
      mtimeMs: now,
      isRaw: isRawPath(entry.sourcePath),
      width: null,
      height: null,
      thumbKey: null,
      stats: null,
      referenceOverride: null,
      develop: null,
      editedAt: null,
    }))
    const current = browserManifest(workspaceId)
    const next: WorkspaceManifest = {
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      photos: [...current.photos, ...imported],
    }
    setBrowserManifest(next)
    return {
      manifest: next,
      imported,
      skipped: [],
      failed: [],
      copiedBytes: 0,
      copiedFiles: 0,
      cancelled: false,
    }
  }

  let unlisten: UnlistenFn | undefined
  try {
    unlisten = await listen<WorkspaceImportProgress>('workspace-import-progress', ({ payload }) => {
      if (payload.jobId === jobId) onProgress(payload)
    })
    return await invoke<WorkspaceImportReport>('import_workspace_files', {
      workspaceId,
      entries,
      jobId,
    })
  } finally {
    unlisten?.()
  }
}

export async function cancelWorkspaceImport(jobId: string): Promise<void> {
  if (!isTauri()) return
  await invoke('cancel_workspace_import', { jobId })
}

/** 登记参考图：`photoId` 为空表示工作区级共享参考，非空表示单图专属覆盖。 */
export async function importWorkspaceReference(
  entry: WorkspaceImportEntry,
  photoId: string | null,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<WorkspaceManifest> {
  if (!isTauri()) return browserManifest(workspaceId)
  return invoke<WorkspaceManifest>('import_workspace_reference', { workspaceId, entry, photoId })
}

export async function resolveWorkspacePhotoPaths(
  photoIds: string[],
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<ResolvedWorkspacePhoto[]> {
  if (!isTauri()) {
    return photoIds.map((photoId) => ({
      photoId,
      path: null,
      status: 'missing' as const,
      reason: '浏览器预览不提供本机路径',
      volumeMounted: false,
    }))
  }
  return invoke<ResolvedWorkspacePhoto[]>('resolve_workspace_photo_paths', { workspaceId, photoIds })
}

/** 解析参考图真实读取路径：copy 读 references/ 副本，reference 读当前挂载点。 */
export async function resolveWorkspaceReferencePath(
  reference: WorkspaceReferenceEntry,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<string | null> {
  if (!isTauri()) return null
  return invoke<string | null>('resolve_workspace_reference_path', { workspaceId, reference })
}

/** 按卷聚合的卷缺席清单：一个卷一条，不逐张弹窗。 */
export async function listAbsentWorkspaceVolumes(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<WorkspaceVolumeAbsence[]> {
  if (!isTauri()) return []
  return invoke<WorkspaceVolumeAbsence[]>('list_absent_workspace_volumes', { workspaceId })
}

export async function readWorkspaceThumbnail(
  workspaceId: string,
  key: string,
): Promise<Uint8Array | null> {
  if (!isTauri()) return browserThumbnails.get(browserThumbnailKey(workspaceId, key)) ?? null
  const bytes = await invoke<number[] | null>('read_workspace_thumbnail', { workspaceId, key })
  return bytes ? new Uint8Array(bytes) : null
}

export async function writeWorkspaceThumbnail(
  workspaceId: string,
  key: string,
  data: Uint8Array,
): Promise<void> {
  if (!isTauri()) {
    browserThumbnails.set(browserThumbnailKey(workspaceId, key), data)
    return
  }
  await invoke('write_workspace_thumbnail', { workspaceId, key, data: Array.from(data) })
}

export async function purgeWorkspaceThumbnails(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<WorkspaceCacheReport> {
  if (!isTauri()) {
    const prefix = `${workspaceId}|`
    for (const key of [...browserThumbnails.keys()]) {
      if (key.startsWith(prefix)) browserThumbnails.delete(key)
    }
    return { removedFiles: 0, freedBytes: 0 }
  }
  return invoke<WorkspaceCacheReport>('purge_workspace_thumbnails', { workspaceId })
}

/** 清空工作区：删除 manifest 条目与 originals/、references/、thumbs/ 下的全部副本。 */
export async function clearWorkspace(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<WorkspaceCacheReport> {
  if (!isTauri()) {
    setBrowserManifest(emptyBrowserManifest(workspaceId))
    const prefix = `${workspaceId}|`
    for (const key of [...browserThumbnails.keys()]) {
      if (key.startsWith(prefix)) browserThumbnails.delete(key)
    }
    return { removedFiles: 0, freedBytes: 0 }
  }
  return invoke<WorkspaceCacheReport>('clear_workspace', { workspaceId })
}

/** 空间预检：按实际字节数返回复制目标盘的可用容量。 */
export async function getWorkspaceDiskSpace(
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<WorkspaceDiskSpace> {
  if (!isTauri()) return { path: '', availableBytes: 0, totalBytes: 0 }
  return invoke<WorkspaceDiskSpace>('workspace_disk_space', { workspaceId })
}

export async function openWorkspaceFolder(workspaceId = DEFAULT_WORKSPACE_ID): Promise<void> {
  if (!isTauri()) throw new Error('仅桌面客户端支持打开工作区文件夹')
  await invoke('open_workspace_folder', { workspaceId })
}

/** RAW 缩略图：优先走相机内嵌预览快路径，失败时后端回落完整解码。 */
export async function decodeRawThumbnailNative(path: string, maxSide = 256) {
  return new Uint8Array(await invoke<number[]>('decode_raw_thumbnail', { path, maxSide }))
}


// ---------------------------------------------------------------------------
// 图片属性 / 定位 / 删除（内容页右键菜单）
// ---------------------------------------------------------------------------

/** 读取一张图片的属性（文件信息 + EXIF）。EXIF 只在桌面端可得。 */
export async function readPhotoProperties(
  photoId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<WorkspacePhotoProperties> {
  if (!isTauri()) throw new Error('仅桌面客户端支持读取 EXIF 属性')
  return invoke<WorkspacePhotoProperties>('read_workspace_photo_properties', { workspaceId, photoId })
}

/** 在系统文件管理器中定位图片，返回被定位的路径。 */
export async function revealPhotoLocation(
  photoId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<string> {
  if (!isTauri()) throw new Error('仅桌面客户端支持打开文件所在位置')
  return invoke<string>('reveal_photo_location', { workspaceId, photoId })
}

/**
 * 从工作区移除若干图片（多选批量共用这一条）。
 *
 * 只删工作区自己的副本与记录，绝不删源文件；返回删除后的 manifest，前端直接接管。
 */
export async function deleteWorkspacePhotos(
  photoIds: string[],
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<DeleteWorkspacePhotosReport> {
  if (!isTauri()) {
    // 浏览器预览没有副本可回收，只改内存 manifest，保证交互不被挡住。
    const current = browserManifest(workspaceId)
    const remove = new Set(photoIds)
    const next: WorkspaceManifest = {
      ...current,
      revision: current.revision + 1,
      updatedAt: Date.now(),
      photos: current.photos.filter((photo) => !remove.has(photo.id)),
    }
    setBrowserManifest(next)
    return { manifest: next, removedPhotoIds: [...remove], removedFiles: 0, freedBytes: 0 }
  }
  return invoke<DeleteWorkspacePhotosReport>('delete_workspace_photos', { workspaceId, photoIds })
}
