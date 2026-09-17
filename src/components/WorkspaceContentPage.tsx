import { ArrowLeft, FolderOpen, Info, LayoutGrid, LoaderCircle, Trash2, Upload } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { WorkspacePhoto } from '../lib/types'
import { photoDisplayName } from '../lib/workspace'
import { PhotoPropertiesDialog } from './PhotoPropertiesDialog'

/** 从内容页进入修图时的目标菜单，取值与顶部导航的修图菜单一致。 */
export type ContentOpenTarget = 'match' | 'grade'

interface WorkspaceContentPageProps {
  name: string
  workspaceId: string
  photos: WorkspacePhoto[]
  /** 当前高亮的素材（可能来自上一次编辑，也可能是本次单击的结果）。 */
  highlightId: string | null
  thumbUrls: Record<string, string>
  busy: boolean
  onBack: () => void
  onImport: () => void
  /** 单击只改高亮，不载入图片；真正载入走 onOpen。 */
  onHighlight: (photoId: string) => void
  onOpen: (photoId: string, target: ContentOpenTarget) => void
  onClearWorkspace: () => void
  /** 在系统文件管理器中定位该图片；成败提示由 App 负责。 */
  onReveal: (photoId: string) => void
  /** 批量删除，返回是否真的删除了（用于决定要不要退出多选模式）。 */
  onRemovePhotos: (photoIds: string[]) => Promise<boolean>
  onNotify: (message: string, kind?: 'ok' | 'error') => void
}

/**
 * 工作区内容页：展示该工作区的全部素材。
 *
 * 它是「工作区」与「修图菜单」之间的一层——点工作区卡片先落到这里看素材，
 * 而不是直接跳进 AI 追色（那会让用户失去「我进了哪个工作区、里面有什么」的上下文）。
 * 素材网格只在这里出现；追色页靠底部缩略图栏切图，不再重复放一套网格。
 *
 * 右键菜单除了修图入口，还提供「打开所在位置 / 属性 / 删除」：
 * 前两项是资料管理动作，删除则进入多选模式（复选框 + 顶部条），批量移除工作区里的图片。
 */
export function WorkspaceContentPage({
  name, workspaceId, photos, highlightId, thumbUrls, busy,
  onBack, onImport, onHighlight, onOpen, onClearWorkspace, onReveal, onRemovePhotos, onNotify,
}: WorkspaceContentPageProps) {
  const [menu, setMenu] = useState<{ photoId: string; x: number; y: number } | null>(null)
  const [propertiesPhoto, setPropertiesPhoto] = useState<WorkspacePhoto | null>(null)
  /*
   * 勾选集是页面的瞬时 UI 状态，刻意**不复用** `workspace.selection`：
   * 那个 selection 的语义是「配方套用目标」，并且恒定包含当前图（见 useWorkspace 的
   * selectPhoto / refresh），拿它当删除清单会让「进入删除模式」顺手改掉批量套用范围。
   */
  const [selecting, setSelecting] = useState(false)
  const [checked, setChecked] = useState<string[]>([])
  const [removing, setRemoving] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const checkedSet = useMemo(() => new Set(checked), [checked])
  const allChecked = photos.length > 0 && checked.length === photos.length

  /*
   * 关闭规则：点菜单外部 / Esc / 滚动。
   * 必须用 contains 判断而不是无条件关闭——否则点菜单项时 pointerdown 会先把菜单卸掉，
   * 后面的 click 就永远不触发，表现为「右键菜单点了没反应」。
   */
  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    const onScroll = () => setMenu(null)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [menu])

  /*
   * 多选模式下的 Esc 退出。
   *
   * 必须让位于上层浮层：菜单或属性弹窗开着时，Esc 的语义是「关掉这一层」，
   * 若两个监听都响应，用户只想关掉弹窗，却会连带丢掉整份勾选。
   */
  useEffect(() => {
    if (!selecting || menu || propertiesPhoto) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setSelecting(false)
      setChecked([])
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selecting, menu, propertiesPhoto])

  // 菜单项变多了，高度不再是常数：挂载后量一次实际尺寸，再贴边收回到视口内。
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const maxX = Math.max(8, window.innerWidth - rect.width - 8)
    const maxY = Math.max(8, window.innerHeight - rect.height - 8)
    if (menu.x > maxX || menu.y > maxY) {
      setMenu({ ...menu, x: Math.min(menu.x, maxX), y: Math.min(menu.y, maxY) })
    }
  }, [menu])

  /*
   * 删除后（或外部刷新后）被删的 id 不能留在勾选集合里，否则计数与按钮状态会说谎。
   * 工作区被清空时连多选模式一起退出，否则空态页上会挂着一条「已选 0 / 0 张」的工具条。
   */
  useEffect(() => {
    if (photos.length === 0) {
      setSelecting(false)
      setChecked((current) => (current.length === 0 ? current : []))
      return
    }
    setChecked((current) => {
      const alive = current.filter((id) => photos.some((photo) => photo.id === id))
      return alive.length === current.length ? current : alive
    })
  }, [photos])

  const openMenu = (photoId: string, clientX: number, clientY: number) => {
    onHighlight(photoId)
    // 贴右边/下边时向内收，避免菜单被窗口裁掉。
    const x = Math.max(8, Math.min(clientX, window.innerWidth - 208))
    const y = Math.max(8, Math.min(clientY, window.innerHeight - 240))
    setMenu({ photoId, x, y })
  }

  const openWith = (target: ContentOpenTarget) => {
    if (!menu) return
    onOpen(menu.photoId, target)
    setMenu(null)
  }

  const toggleChecked = (photoId: string) => {
    setChecked((current) => (
      current.includes(photoId) ? current.filter((id) => id !== photoId) : [...current, photoId]
    ))
  }

  /** 从右键菜单进入删除：把右键那张先勾上，其余靠复选框补。 */
  const beginSelecting = (photoId: string) => {
    setSelecting(true)
    setChecked((current) => (current.includes(photoId) ? current : [...current, photoId]))
    setMenu(null)
  }

  const exitSelecting = () => {
    setSelecting(false)
    setChecked([])
  }

  const removeChecked = async () => {
    if (checked.length === 0 || removing) return
    setRemoving(true)
    try {
      const removed = await onRemovePhotos(checked)
      if (removed) exitSelecting()
    } finally {
      setRemoving(false)
    }
  }

  const showProperties = (photoId: string) => {
    const photo = photos.find((candidate) => candidate.id === photoId) ?? null
    setMenu(null)
    if (photo) setPropertiesPhoto(photo)
    else onNotify('图片已不在工作区', 'error')
  }

  return (
    <main className="content-page">
      <header className="content-page__head">
        <div className="content-page__title">
          <button type="button" className="button button--ghost" onClick={onBack}>
            <ArrowLeft size={15} /> 全部工作区
          </button>
          <div>
            <h1>{name}</h1>
            <em>{photos.length} 张素材</em>
          </div>
        </div>
        <div className="content-page__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={busy || photos.length === 0}
            onClick={onClearWorkspace}
          ><Trash2 size={15} /> 清空工作区</button>
          <button
            type="button"
            className="button button--accent"
            disabled={busy}
            onClick={onImport}
          ><Upload size={15} /> 导入图片</button>
        </div>
      </header>

      {selecting ? (
        <div className="content-select-bar" role="toolbar" aria-label="批量删除">
          <span className="content-select-bar__count">已选 <b>{checked.length}</b> / {photos.length} 张</span>
          <button
            type="button"
            className="button button--ghost"
            disabled={photos.length === 0}
            onClick={() => setChecked(allChecked ? [] : photos.map((photo) => photo.id))}
          >{allChecked ? '取消全选' : '全选'}</button>
          <div className="content-select-bar__actions">
            <button type="button" className="button" onClick={exitSelecting}>取消</button>
            <button
              type="button"
              className="button button--danger"
              disabled={checked.length === 0 || removing || busy}
              onClick={() => void removeChecked()}
            >
              {removing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
              删除所选{checked.length > 0 ? `（${checked.length}）` : ''}
            </button>
          </div>
        </div>
      ) : null}

      {photos.length === 0 ? (
        <div className="content-page__empty">
          <LayoutGrid size={22} />
          <span>工作区还没有素材</span>
          <button className="button button--light" type="button" onClick={onImport}>
            <Upload size={16} /> 导入图片
          </button>
        </div>
      ) : (
        <div className="content-grid" role="list" aria-label="工作区素材">
          {photos.map((photo) => {
            const url = thumbUrls[photo.id]
            const isHighlighted = photo.id === highlightId
            const isChecked = checkedSet.has(photo.id)
            return (
              /*
               * 复选框不能塞进格子按钮里（button 内嵌 input 是非法结构），
               * 所以格子的边框/背景落在外层 div 上，按钮只负责图片与文件名。
               */
              <div
                key={photo.id}
                role="listitem"
                className={`content-grid__cell ${isHighlighted ? 'is-current' : ''} ${isChecked ? 'is-selected' : ''}`}
              >
                <button
                  type="button"
                  className="content-grid__button"
                  title={selecting
                    ? `${photoDisplayName(photo)}｜勾选后可批量删除`
                    : `${photoDisplayName(photo)}｜双击进入修图，右键选择菜单`}
                  aria-pressed={selecting ? isChecked : undefined}
                  onClick={() => (selecting ? toggleChecked(photo.id) : onHighlight(photo.id))}
                  onDoubleClick={() => { if (!selecting) onOpen(photo.id, 'match') }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    openMenu(photo.id, event.clientX, event.clientY)
                  }}
                >
                  {url
                    ? <img src={url} alt={photoDisplayName(photo)} loading="lazy" />
                    : <span className="content-grid__placeholder"><LayoutGrid size={16} /></span>}
                  <em>{photoDisplayName(photo)}</em>
                </button>
                {selecting ? (
                  <input
                    type="checkbox"
                    className="content-grid__check"
                    checked={isChecked}
                    aria-label={`选择 ${photoDisplayName(photo)}`}
                    onChange={() => toggleChecked(photo.id)}
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {menu ? (
        <div
          ref={menuRef}
          className="content-menu"
          role="menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
        >
          <p className="content-menu__label">用下列菜单修图</p>
          <button type="button" role="menuitem" onClick={() => openWith('match')}>AI 追色</button>
          <button type="button" role="menuitem" onClick={() => openWith('grade')}>AI 调色</button>
          <div className="content-menu__divider" role="separator" />
          <button type="button" role="menuitem" onClick={() => { onReveal(menu.photoId); setMenu(null) }}>
            <FolderOpen size={14} /> 打开所在位置
          </button>
          <button type="button" role="menuitem" onClick={() => showProperties(menu.photoId)}>
            <Info size={14} /> 属性
          </button>
          <div className="content-menu__divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="content-menu__danger"
            onClick={() => beginSelecting(menu.photoId)}
          >
            <Trash2 size={14} /> 删除…
          </button>
        </div>
      ) : null}

      {propertiesPhoto ? (
        <PhotoPropertiesDialog
          photo={propertiesPhoto}
          workspaceId={workspaceId}
          previewUrl={thumbUrls[propertiesPhoto.id]}
          onClose={() => setPropertiesPhoto(null)}
        />
      ) : null}
    </main>
  )
}
