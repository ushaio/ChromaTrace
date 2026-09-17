import { ImagePlus, Replace, X } from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import type { LoadedImage } from '../lib/files'

interface ImageDropProps {
  title: string
  image: LoadedImage | null
  accent: 'source' | 'reference'
  /**
   * 只读回显模式：不接受拖入、不显示更换/移除按钮，点击整体交给 onPick。
   * 用于「原片」——它已由工作区素材决定，不该在这里再开一个单文件入口。
   */
  readOnly?: boolean
  /** 只读模式下作为「跳回素材网格」的落点；可编辑模式下省略则落到隐藏 input。 */
  onPick?: () => void
  onFile?: (file: File) => void
  onClear?: () => void
}

export function ImageDrop({ title, image, accent, readOnly = false, onPick, onFile, onClear }: ImageDropProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const accept = (files: FileList | null) => {
    const file = files?.[0]
    if (file) onFile?.(file)
  }
  const pick = () => onPick ? onPick() : inputRef.current?.click()
  const drop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    accept(event.dataTransfer.files)
  }

  return (
    <div
      className={`image-drop image-drop--${accent} ${dragging ? 'is-dragging' : ''} ${image ? 'has-image' : ''} ${readOnly ? 'is-readonly' : ''}`}
      onDragOver={readOnly ? undefined : (event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={readOnly ? undefined : () => setDragging(false)}
      onDrop={readOnly ? undefined : drop}
    >
      {readOnly ? null : (
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,.cr2,.cr3,.nef,.nrw,.arw,.srf,.sr2,.raf,.orf,.rw2,.pef,.dng,.raw,.rwl,.3fr,.fff,.iiq,.mrw,.mos,.kdc,.dcr,.erf,.mef,.srw"
          hidden
          onChange={(event) => accept(event.target.files)}
        />
      )}
      {image ? (
        <>
          <img src={image.url} alt={title} />
          <div className="image-drop__shade" />
          <div className="image-drop__meta">
            <strong>{image.name}</strong>
            <small>{image.width} × {image.height}</small>
          </div>
          {readOnly ? (
            <button type="button" className="image-drop__open" title={title} aria-label={title} onClick={pick} />
          ) : (
            <div className="image-drop__actions">
              <button
                type="button"
                title={accent === 'reference' ? '更换参考图' : '更换图片'}
                onClick={pick}
              ><Replace size={15} /></button>
              {/* source 的清除只是「取消当前选中」，图片仍在工作区里；
                  所以文案必须与 reference 的真删除区分开，否则用户会以为图被删了。 */}
              <button
                type="button"
                title={accent === 'reference' ? '移除参考图' : '取消选中'}
                onClick={onClear}
              ><X size={15} /></button>
            </div>
          )}
        </>
      ) : (
        <button className="image-drop__empty" type="button" onClick={pick}>
          <span className="image-drop__icon"><ImagePlus size={22} strokeWidth={1.6} /></span>
          <strong>{title}</strong>
        </button>
      )}
    </div>
  )
}
