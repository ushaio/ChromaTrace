import { invoke } from '@tauri-apps/api/core'
import { configDir, dirname, join, pictureDir } from '@tauri-apps/api/path'
import { open, save } from '@tauri-apps/plugin-dialog'
import { load } from '@tauri-apps/plugin-store'
import type {
  ColorWorkflowSuggestion, GeneratedImageResult, ImageGenerationRequestOptions, ImageGenerationRuntimeConfig, ModelColorParameters,
  ModelProvider, ModelSettings, VisionRuntimeConfig,
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

