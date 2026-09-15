import { FolderCog, FolderKanban, FolderOpen, HardDrive, Import, LoaderCircle, MoveRight } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  getLibraryLocation,
  isTauri,
  migrateLibraryLocation,
  openLibraryFolder,
  pickLibraryLocation,
  type LibraryLocation,
  type LibraryMigrationProgress,
} from '../lib/desktop'
import { AssetLibraryPanel } from './AssetLibraryPanel'

type Notify = (message: string, kind?: 'ok' | 'error') => void

interface LibrarySettingsPanelProps {
  notify: Notify
  /** 用于在外部导入后强制刷新两个资料库。 */
  refreshKey?: number
}

const INITIAL_PROGRESS: LibraryMigrationProgress = {
  migrationId: '',
  phase: 'scanning',
  copiedBytes: 0,
  totalBytes: 0,
  copiedFiles: 0,
  totalFiles: 0,
  percent: 0,
  currentFile: null,
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function progressLabel(progress: LibraryMigrationProgress) {
  if (progress.phase === 'scanning') return '正在扫描现有资料库…'
  if (progress.phase === 'finalizing') return '正在切换到新的资料库位置…'
  if (progress.phase === 'completed') return '迁移完成'
  return progress.currentFile ? `正在迁移：${progress.currentFile}` : '正在复制资料库文件…'
}

export function LibrarySettingsPanel({ notify, refreshKey = 0 }: LibrarySettingsPanelProps) {
  const desktop = isTauri()
  const [location, setLocation] = useState<LibraryLocation | null>(null)
  const [locationLoading, setLocationLoading] = useState(desktop)
  const [opening, setOpening] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [progressVisible, setProgressVisible] = useState(false)
  const [progress, setProgress] = useState<LibraryMigrationProgress>(INITIAL_PROGRESS)
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(refreshKey)

  useEffect(() => setLibraryRefreshKey(refreshKey), [refreshKey])

  const loadLocation = useCallback(async () => {
    if (!desktop) return
    setLocationLoading(true)
    try {
      setLocation(await getLibraryLocation())
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setLocationLoading(false)
    }
  }, [desktop, notify])

  useEffect(() => {
    void loadLocation()
  }, [loadLocation])

  const handleOpenFolder = async () => {
    setOpening(true)
    try {
      await openLibraryFolder()
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setOpening(false)
    }
  }

  const handleChangeLocation = async () => {
    if (!location || migrating) return
    try {
      const destination = await pickLibraryLocation(location.path)
      if (!destination || destination === location.path) return
      const confirmed = window.confirm(
        `将把当前资料库中的全部预设与调色查找表迁移到：\n\n${destination}\n\n迁移完成后应用会改用新位置，并删除旧位置中的已迁移文件。迁移期间请勿关闭应用。是否继续？`,
      )
      if (!confirmed) return

      const migrationId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
      setProgress({ ...INITIAL_PROGRESS, migrationId })
      setProgressVisible(false)
      setMigrating(true)
      const result = await migrateLibraryLocation(destination, migrationId, (nextProgress) => {
        setProgress(nextProgress)
        setProgressVisible(true)
      })
      setLocation({ path: result.path, isCustom: true })
      setLibraryRefreshKey((value) => value + 1)
      if (result.cleanupWarning) {
        notify(result.cleanupWarning, 'error')
      } else {
        notify(`资料库迁移完成，共迁移 ${result.copiedFiles} 个文件（${formatBytes(result.copiedBytes)}）`, 'ok')
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setMigrating(false)
    }
  }

  return (
    <section className="settings-panel library-settings-panel">
      <header className="settings-panel__head">
        <div>
          <span className="settings-panel__crumb">设置 / 资料库</span>
          <h2>资料库</h2>
          <p>
            维护预设与调色查找表。可打开存储文件夹或迁移整个资料库，也可在下方导入、重命名和整理资源。
          </p>
        </div>
        <div className="settings-panel__pulse is-on">
          <FolderKanban size={16} />
          <span>
            <strong>本地资源</strong>
            <small>预设与调色查找表 · 自定义位置</small>
          </span>
        </div>
      </header>

      <div className="settings-panel__body">
        <div className="library-settings-stack">
          <section className="settings-card library-location-card">
            <div className="settings-card__head">
              <div>
                <h3>资料库存储位置</h3>
              </div>
              {location ? (
                <span className={`library-location-card__badge${location.isCustom ? ' is-custom' : ''}`}>
                  <HardDrive size={12} /> {location.isCustom ? '自定义位置' : '默认位置'}
                </span>
              ) : null}
            </div>

            <div className="library-location-row">
              <div className="library-location-path" title={location?.path}>
                <FolderCog size={18} />
                <span>
                  <small>当前路径</small>
                  <strong>{locationLoading ? '正在读取…' : location?.path ?? '浏览器预览不提供本机资料库路径'}</strong>
                </span>
              </div>
              <div className="library-location-actions">
                <button type="button" className="button button--dark" disabled={!desktop || !location || opening || migrating} onClick={handleOpenFolder}>
                  {opening ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}
                  打开文件夹
                </button>
                <button type="button" className="button button--accent" disabled={!desktop || !location || migrating} onClick={handleChangeLocation}>
                  {migrating ? <LoaderCircle className="spin" size={15} /> : <MoveRight size={15} />}
                  {migrating ? '正在迁移' : '修改路径'}
                </button>
              </div>
            </div>

            <div className="library-location-status">
            {progressVisible ? (
              <div className="library-migration" aria-live="polite">
                <div className="library-migration__meta">
                  <span>{progressLabel(progress)}</span>
                  <strong>{Math.round(progress.percent)}%</strong>
                </div>
                <div className="library-migration__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)}>
                  <i style={{ width: `${progress.percent}%` }} />
                </div>
                <div className="library-migration__detail">
                  <span>{progress.totalFiles > 0 ? `${progress.copiedFiles} / ${progress.totalFiles} 个文件` : '正在统计文件'}</span>
                  <span>{progress.totalBytes > 0 ? `${formatBytes(progress.copiedBytes)} / ${formatBytes(progress.totalBytes)}` : '请勿关闭应用'}</span>
                </div>
              </div>
            ) : (
              <p className="library-location-card__note">修改路径时会迁移全部相关文件并保留目录结构。为避免覆盖已有内容，目标文件夹必须为空。</p>
            )}
            </div>
          </section>

          <section className="settings-card library-settings-card">
            <div className="settings-card__head">
              <div>
                <h3>资源维护</h3>
              </div>
              <span className="library-settings-hint">
                <Import size={13} />
                拖动手柄排序 · 拖到文件夹可移动
              </span>
            </div>

            <div className="library-settings-grid">
              <AssetLibraryPanel
                kind="xmp"
                title="预设库"
                emptyHint="点击导入图标添加预设"
                onNotify={notify}
                refreshKey={libraryRefreshKey}
                enableDragReorder
                defaultExpanded
                className="library-settings-panel__lib"
              />
              <AssetLibraryPanel
                kind="cube"
                title="调色查找表库"
                emptyHint="点击导入图标添加调色查找表"
                onNotify={notify}
                refreshKey={libraryRefreshKey}
                enableDragReorder
                defaultExpanded
                className="library-settings-panel__lib"
              />
            </div>

            <p className="settings-card__note">
              排序与移动结果会保存在本机。调色工作区侧栏中的同名资料库会同步显示，但侧栏不提供拖动整理。
            </p>
          </section>
        </div>
      </div>
    </section>
  )
}