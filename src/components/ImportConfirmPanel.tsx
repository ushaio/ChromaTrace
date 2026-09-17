import { AlertTriangle, Check, FolderOpen, HardDrive, HardDriveDownload, LoaderCircle, Link2, X } from 'lucide-react'
import type { ImportPlan } from '../lib/workspace'
import type { VolumePolicy, WorkspaceImportProgress } from '../lib/types'

export interface ImportConfirmPanelProps {
  plan: ImportPlan
  progress: WorkspaceImportProgress | null
  busy: boolean
  failures: string[]
  onPolicyChange: (volumeId: string, policy: VolumePolicy) => void
  onConfirm: () => void
  onCancel: () => void
  onDismiss: () => void
  onOpenFolder: () => void
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

const DRIVE_LABELS: Record<string, string> = {
  removable: '可移动设备',
  fixed: '内部硬盘',
  remote: '网络磁盘',
  cdrom: '光盘',
  ramdisk: '内存盘',
  unknown: '来源不确定',
}

/**
 * 导入确认面板（内联，与 left-console 风格一致）。
 *
 * 三件必须让用户看见的事：副本会落到哪里（真实路径 + 打开文件夹）、要占多少额外空间
 * （按实际字节预检）、以及哪些图片已在工作区会被跳过。
 */
export function ImportConfirmPanel({
  plan, progress, busy, failures, onPolicyChange, onConfirm, onCancel, onDismiss, onOpenFolder,
}: ImportConfirmPanelProps) {
  const sourceCount = plan.volumes.length
  const available = plan.availableBytes
  const enough = !plan.blocked

  return (
    <section className="import-panel" aria-label="导入确认">
      <header className="import-panel__head">
        <div>
          <strong>检测到 {sourceCount} 个来源</strong>
          <span>{plan.newCount} 张待导入{plan.duplicateCount > 0 ? ` · ${plan.duplicateCount} 张已在工作区` : ''}</span>
        </div>
        <button type="button" className="icon-button" title="关闭" disabled={busy} onClick={onDismiss}>
          <X size={15} />
        </button>
      </header>

      <ul className="import-panel__volumes">
        {plan.volumes.map((volume) => {
          const importing = volume.policy === 'copy'
          return (
            <li key={volume.volumeId} className={importing ? 'is-copy' : 'is-reference'}>
              <span className="import-panel__volume-mark" aria-hidden="true">
                {importing ? <HardDriveDownload size={14} /> : <Link2 size={14} />}
              </span>
              <div className="import-panel__volume-copy">
                <strong>{volume.rootPath || volume.label}</strong>
                <span>
                  {volume.remembered ? '按上次选择' : DRIVE_LABELS[volume.driveType] ?? volume.driveType}
                  {' · '}{volume.items.length} 张
                  {volume.totalBytes > 0 ? ` · ${formatBytes(volume.totalBytes)}` : ''}
                </span>
              </div>
              <em className={importing ? 'is-copy' : 'is-reference'}>
                {importing ? '复制到资料库' : '直接引用'}
              </em>
              <button
                type="button"
                className="button button--dark button--compact"
                disabled={busy}
                onClick={() => onPolicyChange(volume.volumeId, importing ? 'reference' : 'copy')}
              >
                {importing ? '改为直接引用' : '改为复制'}
              </button>
            </li>
          )
        })}
      </ul>

      <div className="import-panel__space">
        <div className="import-panel__target">
          <HardDrive size={13} />
          <span>
            将复制 <b>{formatBytes(plan.copyBytes)}</b> 到：
            <em title={plan.targetPath}>{plan.targetPath || '（未知位置）'}</em>
          </span>
          <button type="button" className="button button--dark button--compact" disabled={busy} onClick={onOpenFolder}>
            <FolderOpen size={13} /> 打开文件夹
          </button>
        </div>
        <div className={`import-panel__check ${enough ? 'is-ok' : 'is-bad'}`}>
          {enough
            ? <><Check size={13} /> 该位置所在盘剩余 {formatBytes(available)}，合计需额外占用 {formatBytes(plan.copyBytes)}</>
            : <><AlertTriangle size={13} /> 剩余空间不足（可用 {formatBytes(available)} &lt; 需要 {formatBytes(plan.copyBytes)}）：请改为直接引用，或先在「设置 → 资料库」更换到容量更大的位置</>}
        </div>
        {plan.referenceCount > 0 ? (
          <p className="import-panel__note">
            直接引用的 {plan.referenceCount} 张不占额外空间；但该设备不在位时将不可编辑与导出。
          </p>
        ) : null}
      </div>

      {progress ? (
        <div className="import-panel__progress" aria-live="polite">
          <div className="import-panel__progress-meta">
            <span>{progress.currentFile ? `正在复制：${progress.currentFile}` : '正在准备…'}</span>
            <strong>{Math.round(progress.percent)}%</strong>
          </div>
          <div className="import-panel__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)}>
            <i style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="import-panel__progress-detail">
            <span>{progress.copiedFiles} / {progress.totalFiles} 张</span>
            <span>{formatBytes(progress.copiedBytes)} / {formatBytes(progress.totalBytes)}</span>
          </div>
        </div>
      ) : null}

      {failures.length > 0 ? (
        <ul className="import-panel__failures">
          {failures.slice(0, 5).map((failure) => <li key={failure}>{failure}</li>)}
        </ul>
      ) : null}

      <footer className="import-panel__foot">
        <span className="import-panel__hint">导入在后台进行，可立即开始修图</span>
        {busy ? (
          <button type="button" className="button button--dark" onClick={onCancel}>
            <LoaderCircle className="spin" size={14} /> 停止导入
          </button>
        ) : (
          <button type="button" className="button button--accent" disabled={!enough || plan.newCount === 0} onClick={onConfirm}>
            确认导入 {plan.newCount} 张
          </button>
        )}
      </footer>
    </section>
  )
}
