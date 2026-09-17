import { Aperture, LoaderCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { readPhotoProperties } from '../lib/desktop'
import { formatBytes } from '../lib/format'
import {
  describeExifSource, describeFileType, describePixelSize, fileNameOf, propertiesGroups,
} from '../lib/photoProperties'
import type { WorkspacePhoto, WorkspacePhotoProperties } from '../lib/types'

interface PhotoPropertiesDialogProps {
  photo: WorkspacePhoto
  workspaceId: string
  /** 缩略图 objectURL；没有时不显示预览方块。 */
  previewUrl?: string
  onClose: () => void
}

/**
 * 图片属性弹窗：文件信息 + EXIF。
 *
 * 信息分两段到达：文件信息 manifest 立刻就能给，EXIF 要读盘（RAW 常见 30–60MB）。
 * 所以先把已知信息铺出来，再补 EXIF —— 让用户先看到文件名与大小，比整块白屏等 IO 好。
 * 拿不到 EXIF 时（浏览器预览、卷未挂载、文件无 EXIF）只显示一行说明，文件信息照旧。
 */
export function PhotoPropertiesDialog({
  photo, workspaceId, previewUrl, onClose,
}: PhotoPropertiesDialogProps) {
  const [properties, setProperties] = useState<WorkspacePhotoProperties | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // 清掉上一张的属性：否则切换图片失败时会把上一张的文件名/EXIF 挂在新图下面。
    setProperties(null)
    void (async () => {
      try {
        const loaded = await readPhotoProperties(photo.id, workspaceId)
        if (!cancelled) setProperties(loaded)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '读取图片属性失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [photo.id, workspaceId])

  // Esc 关闭：弹窗是模态的，键盘用户不该被逼着去点那个 X。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const groups = propertiesGroups(photo, properties)
  const exifHint = describeExifSource(properties?.exifSource ?? null)
  const summary = [
    describeFileType(photo, properties),
    describePixelSize({ width: properties?.width ?? photo.width, height: properties?.height ?? photo.height }),
    formatBytes(properties?.sizeBytes ?? photo.sizeBytes),
  ].filter(Boolean).join(' · ')

  return (
    <div
      className="properties-dialog__backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        className="properties-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="photo-properties-title"
      >
        <header className="properties-dialog__head">
          <div className="properties-dialog__identity">
            {previewUrl
              ? <img src={previewUrl} alt="" />
              : <span className="properties-dialog__thumb-fallback"><Aperture size={18} /></span>}
            <div className="properties-dialog__titles">
              <h2 id="photo-properties-title">{properties?.fileName ?? fileNameOf(photo)}</h2>
              <span>{summary}</span>
            </div>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </header>

        <div className="properties-dialog__body">
          {error ? <p className="properties-dialog__error">{error}</p> : null}

          {groups.map((group) => (
            <section className="properties-dialog__group" key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.fields.map((field) => (
                  <div className="properties-dialog__row" key={`${group.title}-${field.label}`}>
                    <dt>{field.label}</dt>
                    <dd title={field.value}>{field.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}

          {loading ? (
            <p className="properties-dialog__note is-loading">
              <LoaderCircle className="spin" size={14} /> 正在读取 EXIF…
            </p>
          ) : null}
          {!loading && properties?.exifNote && !error ? (
            <p className="properties-dialog__note">{properties.exifNote}</p>
          ) : null}
          {!loading && exifHint ? <p className="properties-dialog__hint">{exifHint}</p> : null}
        </div>

        <footer className="properties-dialog__actions">
          <button type="button" className="button" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  )
}
