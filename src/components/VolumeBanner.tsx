import { HardDriveDownload, Link2Off, MoveRight, X } from 'lucide-react'
import type { WorkspaceVolumeAbsence } from '../lib/types'

export interface VolumeBannerProps {
  volumes: WorkspaceVolumeAbsence[]
  busy?: boolean
  onConvertToCopy: (volumeId: string) => void
  onRelocate: (volumeId: string) => void
  onDismiss: (volumeId: string) => void
}

/**
 * 卷缺席汇总条。
 *
 * 两条刻意的设计约束：
 * 1. **按卷聚合，一个卷一条** —— 37 张图片不生成 37 个弹窗，否则会退化成用户直接无视的噪音；
 * 2. 文案必须区分「请连接设备」（卷未挂载）与「文件已被删除」—— 把“盘没插”说成“文件没了”
 *    会直接摧毁用户对应用的信任。
 */
export function VolumeBanner({ volumes, busy = false, onConvertToCopy, onRelocate, onDismiss }: VolumeBannerProps) {
  if (volumes.length === 0) return null

  return (
    <div className="volume-banner" role="status" aria-live="polite">
      {volumes.map((volume) => (
        <div key={volume.volumeId} className="volume-banner__row">
          <span className="volume-banner__icon" aria-hidden="true"><Link2Off size={14} /></span>
          <span className="volume-banner__text">
            设备 <strong>{volume.label}</strong>（{volume.rootPath}）未连接
            <b>· {volume.photoCount} 张图片暂不可用</b>
            <em>请连接该设备；若文件已移动，可重新定位</em>
          </span>
          <span className="volume-banner__actions">
            <button
              type="button"
              className="button button--dark button--compact"
              disabled={busy}
              title="连接设备后把这些图片复制进资料库"
              onClick={() => onConvertToCopy(volume.volumeId)}
            >
              <HardDriveDownload size={13} /> 改为复制
            </button>
            <button
              type="button"
              className="button button--dark button--compact"
              disabled={busy}
              onClick={() => onRelocate(volume.volumeId)}
            >
              <MoveRight size={13} /> 重新定位
            </button>
            <button
              type="button"
              className="icon-button"
              title="本次不再提示该设备"
              onClick={() => onDismiss(volume.volumeId)}
            >
              <X size={14} />
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}
