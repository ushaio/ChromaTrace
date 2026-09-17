import { describe, expect, it } from 'vitest'
import { sha1Hex } from './hash'

describe('sha1Hex', () => {
  it('matches the standard SHA-1 test vectors', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })

  it('handles multi-byte UTF-8 and multi-block messages', () => {
    expect(sha1Hex('色迹 ChromaTrace')).toBe('7f15cc1b974edcf5400a4f4f0b6d58a45d601b8d')
    expect(sha1Hex('a'.repeat(200))).toBe('e61cfffe0d9195a525fc6cf06ca2d77119c24a40')
  })

  it('stays in lockstep with the Rust workspace identity scheme', () => {
    // workspace.rs::thumb_key 使用同一组合；两端的摘要必须一致，否则缓存与身份会对不上。
    expect(sha1Hex('VOL1|2024/a.cr3|100|200|256')).toBe('b7eb3773a291d59c2e019ea1bdb55866ad24f406')
    expect(sha1Hex('VOL1|2024/Wedding/IMG_0001.CR3')).toBe('5764df9bf6cf64ade29946af0d7fb10d9f940082')
  })
})
