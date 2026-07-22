import { FolderKanban, Import } from 'lucide-react'
import { AssetLibraryPanel } from './AssetLibraryPanel'

type Notify = (message: string, kind?: 'ok' | 'error') => void

interface LibrarySettingsPanelProps {
  notify: Notify
  /** Bump to force both libraries to reload (e.g. after external import). */
  refreshKey?: number
}

/**
 * Settings → 资料库: full manage surface for XMP presets and CUBE LUTs
 * (import, rename, delete, folder ops, drag reorder / move).
 */
export function LibrarySettingsPanel({ notify, refreshKey = 0 }: LibrarySettingsPanelProps) {
  return (
    <section className="settings-panel library-settings-panel">
      <header className="settings-panel__head">
        <div>
          <span className="settings-panel__crumb">设置 / 资料库</span>
          <h2>资料库</h2>
          <p>
            维护 XMP 预设与 CUBE LUT。可在此导入、重命名、删除，以及拖动排序与移动文件夹。
            调色工作区侧栏仅用于快速选用。
          </p>
        </div>
        <div className="settings-panel__pulse is-on">
          <FolderKanban size={16} />
          <span>
            <strong>本地资源</strong>
            <small>XMP · CUBE · 拖动排序</small>
          </span>
        </div>
      </header>

      <div className="settings-panel__body">
        <section className="settings-card library-settings-card">
          <div className="settings-card__head">
            <div>
              <span className="kicker">ASSET LIBRARY</span>
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
              title="XMP 预设库"
              emptyHint="点击导入图标添加 Lightroom 预设"
              onNotify={notify}
              refreshKey={refreshKey}
              enableDragReorder
              defaultExpanded
              className="library-settings-panel__lib"
            />
            <AssetLibraryPanel
              kind="cube"
              title="CUBE LUT 库"
              emptyHint="点击导入图标添加 LUT"
              onNotify={notify}
              refreshKey={refreshKey}
              enableDragReorder
              defaultExpanded
              className="library-settings-panel__lib"
            />
          </div>

          <p className="settings-card__note">
            排序与移动结果会保存在本机。工作区「AI 调色」侧栏中的同名资料库会同步显示，但侧栏不提供拖动整理。
          </p>
        </section>
      </div>
    </section>
  )
}
