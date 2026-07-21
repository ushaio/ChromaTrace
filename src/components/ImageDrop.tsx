import { ImagePlus, Replace, X } from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import type { LoadedImage } from '../lib/files'

interface ImageDropProps {
  title: string
  eyebrow: string
  image: LoadedImage | null
  accent: 'source' | 'reference'
  onFile: (file: File) => void
  onPick?: () => void
  onClear: () => void
}

export function ImageDrop({ title, eyebrow, image, accent, onFile, onPick, onClear }: ImageDropProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const accept = (files: FileList | null) => {
    const file = files?.[0]
    if (file) onFile(file)
  }
  const pick = () => onPick ? onPick() : inputRef.current?.click()
  const drop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    accept(event.dataTransfer.files)
  }

  return (
    <div
      className={`image-drop image-drop--${accent} ${dragging ? 'is-dragging' : ''} ${image ? 'has-image' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => accept(event.target.files)} />
      {image ? (
        <>
          <img src={image.url} alt={title} />
          <div className="image-drop__shade" />
          <div className="image-drop__meta">
            <span>{eyebrow}</span>
            <strong>{image.name}</strong>
            <small>{image.width} × {image.height}</small>
          </div>
          <div className="image-drop__actions">
            <button type="button" title="更换图片" onClick={pick}><Replace size={15} /></button>
            <button type="button" title="移除图片" onClick={onClear}><X size={15} /></button>
          </div>
        </>
      ) : (
        <button className="image-drop__empty" type="button" onClick={pick}>
          <span className="image-drop__icon"><ImagePlus size={22} strokeWidth={1.6} /></span>
          <span className="image-drop__eyebrow">{eyebrow}</span>
          <strong>{title}</strong>
          <small>点击选择或拖入图片</small>
        </button>
      )}
    </div>
  )
}
