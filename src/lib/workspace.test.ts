import { describe, expect, it } from 'vitest'
import { createDefaultAdjustments } from './defaults'
import {
  applyDevelop, applyRecipeToPhotos, buildImportPlan, createEmptyDevelop, createEmptyManifest, effectiveReference,
  findPhoto, isRevisionConflict, needsImportDecision, nextCurrentIdAfterRemoval, normalizeManifest, photoIdentity,
  reclaimableBytesForRemoval, relativeWithinVolume,
} from './workspace'
import type { Adjustments, SourceVolume, WorkspaceManifest, WorkspacePhoto } from './types'

function photo(overrides: Partial<WorkspacePhoto> = {}): WorkspacePhoto {
  const volumeId = overrides.volumeId ?? 'VOL1'
  const relativeSourcePath = overrides.relativeSourcePath ?? '2024/a.cr3'
  return {
    id: photoIdentity(volumeId, relativeSourcePath),
    volumeId,
    relativeSourcePath,
    sourcePath: `E:/${relativeSourcePath}`,
    origin: 'reference',
    workspacePath: null,
    status: 'ready',
    sizeBytes: 10,
    mtimeMs: 1,
    isRaw: true,
    width: null,
    height: null,
    thumbKey: null,
    stats: null,
    referenceOverride: null,
    develop: null,
    editedAt: null,
    ...overrides,
  }
}

const reference = {
  id: 'ref_1',
  origin: 'copy' as const,
  volumeId: 'VOL9',
  relativeSourcePath: 'refs/look.jpg',
  sourcePath: 'E:/refs/look.jpg',
  workspacePath: 'references/look.jpg',
  status: 'ready' as const,
  stats: null,
}

function manifestWith(photos: WorkspacePhoto[], referenceEntry: WorkspaceManifest['reference'] = null): WorkspaceManifest {
  return { ...createEmptyManifest(), reference: referenceEntry, photos }
}

const volume = (overrides: Partial<SourceVolume> = {}): SourceVolume => ({
  rootPath: 'E:',
  volumeId: 'VOL1',
  label: 'MyPassport',
  driveType: 'removable',
  recommendation: 'copy',
  rememberedPolicy: null,
  fileCount: 2,
  totalBytes: 200,
  ...overrides,
})

describe('photoIdentity', () => {
  it('uses volumeId + volume-relative path, never the drive letter', () => {
    // 与 Rust `sha1_hex(volume_id|relative_source_path)` 同一约定
    expect(photoIdentity('VOL1', '2024/Wedding/IMG_0001.CR3'))
      .toBe('5764df9bf6cf64ade29946af0d7fb10d9f940082')
  })

  it('is stable when only the mount point moves', () => {
    // 同一块盘从 E: 改挂到 F: 后身份不变，否则会重复导入、缓存全失效
    const before = photoIdentity('VOL1', '2024/a.cr3')
    const after = photoIdentity('VOL1', '2024/a.cr3')
    expect(after).toBe(before)
  })
})

describe('effectiveReference', () => {
  it('prefers the per-photo override', () => {
    const override = { ...reference, id: 'ref_override', relativeSourcePath: 'refs/local.jpg' }
    const photoItem = photo({ referenceOverride: override })
    expect(effectiveReference(photoItem, manifestWith([photoItem], reference))?.id).toBe('ref_override')
  })

  it('falls back to the workspace-level reference', () => {
    const photoItem = photo()
    expect(effectiveReference(photoItem, manifestWith([photoItem], reference))?.id).toBe('ref_1')
  })

  it('returns null when there is no reference at all', () => {
    const photoItem = photo()
    expect(effectiveReference(photoItem, manifestWith([photoItem]))).toBeNull()
    expect(effectiveReference(null, manifestWith([photoItem], reference))).toBeNull()
  })
})

describe('normalizeManifest', () => {
  it('degrades instead of throwing on truncated input', () => {
    const normalized = normalizeManifest({ version: 1 })
    expect(normalized.photos).toEqual([])
    expect(normalized.reference).toBeNull()
    expect(normalized.revision).toBe(0)
    expect(normalizeManifest(null).photos).toEqual([])
    expect(normalizeManifest('not an object').photos).toEqual([])
  })

  it('drops only the unreadable photo rows', () => {
    const normalized = normalizeManifest({
      photos: [
        { volumeId: 'VOL1', relativeSourcePath: 'a.cr3' },
        { volumeId: '', relativeSourcePath: '' },
        null,
      ],
    })
    expect(normalized.photos).toHaveLength(1)
    expect(normalized.photos[0].id).toBe(photoIdentity('VOL1', 'a.cr3'))
    expect(normalized.photos[0].status).toBe('ready')
  })

  it('keeps partial develop data by filling defaults', () => {
    const normalized = normalizeManifest({
      photos: [{ volumeId: 'VOL1', relativeSourcePath: 'a.cr3', develop: { modelStyle: '青橙' } }],
    })
    const develop = normalized.photos[0].develop
    expect(develop?.modelStyle).toBe('青橙')
    expect(develop?.adjustments.exposure).toBe(createDefaultAdjustments().exposure)
    expect(develop?.matchRenderMode).toBe('none')
  })

  it('rebuilds a missing thumb key from the stored file state', () => {
    const normalized = normalizeManifest({
      photos: [{ volumeId: 'VOL1', relativeSourcePath: '2024/a.cr3', sizeBytes: 100, mtimeMs: 200 }],
    })
    expect(normalized.photos[0].thumbKey).toBe('b7eb3773a291d59c2e019ea1bdb55866ad24f406')
  })
})

describe('isRevisionConflict', () => {
  it('recognizes the optimistic-concurrency rejection', () => {
    expect(isRevisionConflict(new Error('工作区已在别处修改（期望 revision 3，实际 4），已重新载入'))).toBe(true)
    expect(isRevisionConflict('读取失败')).toBe(false)
  })
})

describe('relativeWithinVolume', () => {
  it('strips the mount point and normalizes separators', () => {
    expect(relativeWithinVolume('E:/2024/Wedding/a.CR3', 'E:\\')).toBe('2024/Wedding/a.CR3')
    expect(relativeWithinVolume('e:/2024/a.cr3', 'E:\\')).toBe('2024/a.cr3')
  })

  it('returns null when the file is outside the volume', () => {
    expect(relativeWithinVolume('D:/2024/a.cr3', 'E:\\')).toBeNull()
  })
})

describe('applyDevelop', () => {
  it('writes parameters onto the current photo only', () => {
    const first = photo({ relativeSourcePath: 'a.cr3' })
    const second = photo({ relativeSourcePath: 'b.cr3' })
    const develop = { ...createEmptyDevelop(), modelStyle: 'film' }
    const next = applyDevelop(manifestWith([first, second]), first.id, develop)

    expect(findPhoto(next, first.id)?.develop?.modelStyle).toBe('film')
    expect(findPhoto(next, second.id)?.develop).toBeNull()
  })
})

describe('applyRecipeToPhotos', () => {
  it('copies the current recipe to the selected photos and skips none silently', () => {
    const source = photo({ relativeSourcePath: 'a.cr3', develop: { ...createEmptyDevelop(), modelStyle: '青橙电影感' } })
    const target = photo({ relativeSourcePath: 'b.cr3' })
    const result = applyRecipeToPhotos(manifestWith([source, target]), source.id, [target.id])

    expect(result.applied).toEqual([target.id])
    expect(result.skipped).toEqual([])
    expect(findPhoto(result.manifest, target.id)?.develop?.modelStyle).toBe('青橙电影感')
    // 目标图拿到的是副本，之后各自可独立修改
    expect(findPhoto(result.manifest, target.id)?.develop).not.toBe(source.develop)
  })

  it('reports the current photo as skipped rather than rewriting it', () => {
    const source = photo({ relativeSourcePath: 'a.cr3', develop: createEmptyDevelop() })
    const target = photo({ relativeSourcePath: 'b.cr3' })
    const result = applyRecipeToPhotos(manifestWith([source, target]), source.id, [source.id, target.id])
    expect(result.applied).toEqual([target.id])
    expect(result.skipped).toEqual([source.id])
  })

  it('does nothing when the current photo has no recipe yet', () => {
    const source = photo({ relativeSourcePath: 'a.cr3' })
    const target = photo({ relativeSourcePath: 'b.cr3' })
    const result = applyRecipeToPhotos(manifestWith([source, target]), source.id, [target.id])
    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([target.id])
  })
})

describe('buildImportPlan', () => {
  const paths = ['E:/2024/a.cr3', 'E:/2024/b.cr3']

  it('marks already-imported photos as duplicates and keeps them out of the copy total', () => {
    const existing = photo({ relativeSourcePath: '2024/a.cr3' })
    const plan = buildImportPlan({
      paths,
      volumes: [volume()],
      manifest: manifestWith([existing]),
      availableBytes: 1000,
      targetPath: 'C:/lib/workspaces/default/originals',
    })
    expect(plan.duplicateCount).toBe(1)
    expect(plan.copyCount).toBe(1)
    expect(plan.blocked).toBe(false)
  })

  it('blocks the import when the target disk cannot hold the copies', () => {
    const plan = buildImportPlan({
      paths,
      volumes: [volume()],
      manifest: manifestWith([]),
      availableBytes: 50,
      targetPath: 'C:/lib/workspaces/default/originals',
    })
    // 每张 100 字节（卷均值），共 200 > 50 可用
    expect(plan.copyBytes).toBe(200)
    expect(plan.blocked).toBe(true)
    expect(plan.targetPath).toBe('C:/lib/workspaces/default/originals')
  })

  it('honours a per-volume override and remembers that it came from memory', () => {
    const remembered = volume({ rememberedPolicy: 'reference', recommendation: 'reference' })
    const plan = buildImportPlan({
      paths,
      volumes: [remembered],
      overrides: { VOL1: 'copy' },
      manifest: manifestWith([]),
      availableBytes: 1000,
      targetPath: 'C:/lib',
    })
    expect(plan.volumes[0].policy).toBe('copy')
    expect(plan.volumes[0].remembered).toBe(true)
    expect(plan.copyCount).toBe(2)
  })

  it('charges nothing to disk when the volume is referenced directly', () => {
    const fixed = volume({ volumeId: 'VOL2', rootPath: 'D:', driveType: 'fixed', recommendation: 'reference' })
    const plan = buildImportPlan({
      paths: ['D:/photos/a.jpg'],
      volumes: [fixed],
      manifest: manifestWith([]),
      availableBytes: 0,
      targetPath: 'C:/lib',
    })
    expect(plan.copyBytes).toBe(0)
    expect(plan.blocked).toBe(false)
    expect(plan.referenceCount).toBe(1)
  })

  it('produces entries whose origin follows the chosen policy', () => {
    const plan = buildImportPlan({
      paths,
      volumes: [volume()],
      manifest: manifestWith([]),
      availableBytes: 1000,
      targetPath: 'C:/lib',
    })
    const entries = plan.volumes.flatMap((group) => group.items.map((item) => ({
      sourcePath: item.path,
      volumeId: group.volumeId,
      relativeSourcePath: item.relativeSourcePath,
      targetRelative: item.relativeSourcePath,
      origin: group.policy,
    })))
    expect(entries).toHaveLength(2)
    expect(entries.every((entry) => entry.origin === 'copy')).toBe(true)
  })
})

describe('needsImportDecision', () => {
  const fixedVolume = () => volume({ driveType: 'fixed', recommendation: 'reference' })
  const planFor = (options: { volumes: SourceVolume[]; manifest?: WorkspaceManifest; availableBytes?: number; paths?: string[] }) =>
    buildImportPlan({
      paths: options.paths ?? ['E:/2024/a.cr3', 'E:/2024/b.cr3'],
      volumes: options.volumes,
      manifest: options.manifest ?? manifestWith([]),
      availableBytes: options.availableBytes ?? 1000,
      targetPath: 'C:/lib',
    })

  it('lets an internal-drive import with room and no duplicates run without asking', () => {
    // 这是绝大多数情况：直接导入，不该弹面板。
    expect(needsImportDecision(planFor({ volumes: [fixedVolume()] }))).toBe(false)
  })

  it('asks when the source is not an internal drive', () => {
    // 可移动盘默认要整卷复制，代价大，值得先确认。
    const removable = volume({ driveType: 'removable', recommendation: 'copy' })
    expect(needsImportDecision(planFor({ volumes: [removable] }))).toBe(true)
  })

  it('asks when the target disk is too small, since the policy must change', () => {
    expect(needsImportDecision(planFor({ volumes: [volume()], availableBytes: 50 }))).toBe(true)
  })

  it('asks when duplicates will be skipped, so the user is not left thinking import dropped files', () => {
    const existing = photo({ relativeSourcePath: '2024/a.cr3' })
    const plan = planFor({ volumes: [fixedVolume()], manifest: manifestWith([existing]) })
    expect(plan.duplicateCount).toBe(1)
    expect(needsImportDecision(plan)).toBe(true)
  })

  it('treats a remembered non-internal volume the same as an unremembered one', () => {
    // 记忆只决定推荐策略，不改变「这卷不是内部盘」这个事实。
    const remembered = volume({ driveType: 'removable', rememberedPolicy: 'reference', recommendation: 'reference' })
    expect(needsImportDecision(planFor({ volumes: [remembered], availableBytes: 1000 }))).toBe(true)
  })
})

describe('adjustments typing sanity', () => {
  it('exposes a full default adjustment set for new photos', () => {
    const adjustments: Adjustments = createEmptyDevelop().adjustments
    expect(Object.keys(adjustments)).toContain('exposure')
    expect(Object.keys(adjustments)).toContain('curves')
  })
})

describe('nextCurrentIdAfterRemoval', () => {
  it('keeps the current photo when it was not removed', () => {
    const keep = photo({ relativeSourcePath: 'a.cr3' })
    const gone = photo({ relativeSourcePath: 'b.cr3' })
    expect(nextCurrentIdAfterRemoval([keep], new Set([gone.id]), keep.id)).toBe(keep.id)
  })

  it('falls back to the next ready photo when the current one was removed', () => {
    const pending = photo({ relativeSourcePath: 'p.cr3', status: 'pending' })
    const ready = photo({ relativeSourcePath: 'r.cr3' })
    expect(nextCurrentIdAfterRemoval([pending, ready], new Set([pending.id]), pending.id)).toBe(ready.id)
  })

  it('returns null when nothing usable is left', () => {
    expect(nextCurrentIdAfterRemoval([], new Set(['gone']), 'gone')).toBeNull()
    // 没有当前图就保持没有：删除别人不该顺手替用户选一张。
    expect(nextCurrentIdAfterRemoval([photo({ relativeSourcePath: 'x.cr3' })], new Set(), null)).toBeNull()
    // 只剩不可用的图时也不回落：选中它会立刻弹「副本缺失，需要重新复制」。
    const pending = photo({ relativeSourcePath: 'p.cr3', status: 'pending' })
    expect(nextCurrentIdAfterRemoval([pending], new Set([pending.id]), pending.id)).toBeNull()
  })
})

describe('reclaimableBytesForRemoval', () => {
  it('counts copies only, because references occupy no workspace space', () => {
    const copy = photo({ relativeSourcePath: 'c.cr3', origin: 'copy', sizeBytes: 100 })
    const referenceItem = photo({ relativeSourcePath: 'r.cr3', origin: 'reference', sizeBytes: 500 })
    expect(reclaimableBytesForRemoval([copy, referenceItem], [copy.id])).toBe(100)
    expect(reclaimableBytesForRemoval([copy, referenceItem], [copy.id, referenceItem.id])).toBe(100)
  })
})
