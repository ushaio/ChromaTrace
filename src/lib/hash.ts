/**
 * 纯 JS SHA-1（同步）。
 *
 * 为什么不用 `crypto.subtle`：
 * 1. 图片身份（`WorkspacePhoto.id`）与缩略图缓存键由 Rust 侧的 `workspace.rs::sha1_hex`
 *    生成，前端必须在同一约定下产出同样的摘要，否则重启或换环境后缓存与身份会对不上；
 * 2. `crypto.subtle` 只存在于安全上下文，且 vitest 默认跑在 node 环境（无 jsdom DOM），
 *    而导入前组装 manifest 需要同步拿到 id；
 * 3. 该函数是纯函数，可以脱离环境单测。
 */

function utf8Bytes(value: string): number[] {
  const bytes: number[] = []
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return bytes
}

/** Lowercase hex SHA-1 digest of the UTF-8 encoding of `value`. */
export function sha1Hex(value: string): string {
  const message = utf8Bytes(value)
  const bitLength = message.length * 8

  message.push(0x80)
  while (message.length % 64 !== 56) message.push(0)
  const high = Math.floor(bitLength / 0x100000000)
  const low = bitLength >>> 0
  message.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff)
  message.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const words = new Array<number>(80)

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4
      words[index] = (
        (message[base] << 24)
        | (message[base + 1] << 16)
        | (message[base + 2] << 8)
        | message[base + 3]
      ) >>> 0
    }
    for (let index = 16; index < 80; index += 1) {
      const value = words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16]
      words[index] = ((value << 1) | (value >>> 31)) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let index = 0; index < 80; index += 1) {
      let f: number
      let k: number
      if (index < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (index < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + words[index]) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = temp
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  return [h0, h1, h2, h3, h4].map((value) => value.toString(16).padStart(8, '0')).join('')
}
