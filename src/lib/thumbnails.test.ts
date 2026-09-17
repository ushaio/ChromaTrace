import { describe, expect, it } from 'vitest'
import { asciiLower, createTaskGate, THUMBNAIL_MAX_SIDE, thumbnailCacheKey, type ThumbnailIdentity } from './thumbnails'

const identity: ThumbnailIdentity = {
  volumeId: 'VOL1',
  relativeSourcePath: '2024/a.cr3',
  sizeBytes: 100,
  mtimeMs: 200,
}

describe('thumbnailCacheKey', () => {
  it('is stable for the same identity', () => {
    expect(thumbnailCacheKey(identity)).toBe(thumbnailCacheKey({ ...identity }))
  })

  it('changes when the source file state changes', () => {
    const base = thumbnailCacheKey(identity)
    expect(thumbnailCacheKey({ ...identity, sizeBytes: 101 })).not.toBe(base)
    expect(thumbnailCacheKey({ ...identity, mtimeMs: 201 })).not.toBe(base)
    expect(thumbnailCacheKey({ ...identity, volumeId: 'VOL2' })).not.toBe(base)
    expect(thumbnailCacheKey({ ...identity, relativeSourcePath: '2024/b.cr3' })).not.toBe(base)
  })

  it('is sensitive to maxSide, so a different size never reuses the wrong file', () => {
    expect(thumbnailCacheKey(identity, 512)).not.toBe(thumbnailCacheKey(identity, THUMBNAIL_MAX_SIDE))
  })

  it('normalizes path case so one photo cannot produce two caches', () => {
    expect(thumbnailCacheKey({ ...identity, relativeSourcePath: '2024/A.CR3' })).toBe(
      thumbnailCacheKey(identity),
    )
  })

  it('stays in lockstep with the Rust workspace cache key', () => {
    // 与 `workspace.rs::tests::thumb_key_tracks_identity_and_file_state` 钉同一个摘要。
    expect(thumbnailCacheKey(identity)).toBe('b7eb3773a291d59c2e019ea1bdb55866ad24f406')
  })
})

describe('asciiLower', () => {
  it('lowercases ASCII only, leaving non-ASCII untouched', () => {
    expect(asciiLower('2024/IMG_0001.CR3')).toBe('2024/img_0001.cr3')
    // Rust 侧用的是 to_ascii_lowercase，两端必须一致
    expect(asciiLower('照片/婚礼.CR3')).toBe('照片/婚礼.cr3')
  })
})

describe('createTaskGate', () => {
  it('never runs more tasks than the limit at once', async () => {
    const run = createTaskGate(2)
    let active = 0
    let peak = 0
    const task = async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
    }
    await Promise.all(Array.from({ length: 6 }, () => run(task)))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('releases the slot when a task rejects', async () => {
    const run = createTaskGate(1)
    await expect(run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(run(async () => 'ok')).resolves.toBe('ok')
  })
})
