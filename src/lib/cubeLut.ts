/**
 * L2-grade Adobe .cube 3D LUT support.
 *
 * Application contract (documented for Resolve-aligned sRGB workflow):
 * - Input/output assumed sRGB-encoded display RGB in [0, 1] after DOMAIN mapping.
 * - Applied AFTER local grading parameters (exposure, curves, HSL, etc.).
 * - Trilinear interpolation in float32; preview and export share this module.
 * - Strength is a linear mix: out = lerp(src, lut(src), amount/100).
 */

export interface CubeLut3D {
  title: string
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  /** Interleaved RGB floats, length size³ × 3, index ((b * size + g) * size + r) * 3 */
  data: Float32Array
  fileName: string
}

export interface CubeLutApplication {
  lut: CubeLut3D
  /** 0–100 mix amount */
  amount: number
}

const CUBE_MAX_BYTES = 48 * 1024 * 1024
const SUPPORTED_SIZES = new Set([17, 33, 64, 65])

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function parseVector3(parts: string[], start: number): [number, number, number] | null {
  if (parts.length < start + 3) return null
  const values = [parts[start], parts[start + 1], parts[start + 2]].map((part) => Number.parseFloat(part))
  if (values.some((value) => !Number.isFinite(value))) return null
  return [values[0], values[1], values[2]]
}

/** Read only the declared lattice size for lightweight library metadata. */
export function detectCubeLutSize(text: string): number | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const parts = line.split(/\s+/)
    if (parts[0]?.toUpperCase() !== 'LUT_3D_SIZE') continue
    const size = Number.parseInt(parts[1], 10)
    return Number.isFinite(size) && size >= 2 ? size : null
  }
  return null
}

export function validateCubeFile(file: Pick<File, 'name' | 'size'>) {
  if (!file.name.toLowerCase().endsWith('.cube')) throw new Error('请选择 Adobe .cube 三维 LUT 文件。')
  if (file.size > CUBE_MAX_BYTES) throw new Error('CUBE 文件不能超过 48 MB。')
  if (file.size < 32) throw new Error('CUBE 文件内容过短。')
}

export function parseCubeLut(text: string, fileName = 'lut.cube'): CubeLut3D {
  if (!text.trim()) throw new Error('CUBE 文件内容为空。')

  let title = fileName.replace(/\.cube$/i, '') || 'LUT'
  let size = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  const samples: number[] = []
  let saw1d = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue

    const parts = line.split(/\s+/)
    const keyword = parts[0].toUpperCase()

    if (keyword === 'TITLE') {
      const match = line.match(/TITLE\s+"([^"]*)"/i) || line.match(/TITLE\s+(.+)$/i)
      if (match?.[1]) title = match[1].trim()
      continue
    }
    if (keyword === 'LUT_1D_SIZE') {
      saw1d = true
      continue
    }
    if (keyword === 'LUT_3D_SIZE') {
      const parsed = Number.parseInt(parts[1], 10)
      if (!Number.isFinite(parsed) || parsed < 2) throw new Error('无效的 LUT_3D_SIZE。')
      size = parsed
      continue
    }
    if (keyword === 'DOMAIN_MIN') {
      const vector = parseVector3(parts, 1)
      if (vector) domainMin = vector
      continue
    }
    if (keyword === 'DOMAIN_MAX') {
      const vector = parseVector3(parts, 1)
      if (vector) domainMax = vector
      continue
    }
    if (keyword.startsWith('LUT_') || keyword === 'SIZE') continue

    const rgb = parseVector3(parts, 0)
    if (!rgb) continue
    samples.push(rgb[0], rgb[1], rgb[2])
  }

  if (!size) {
    if (saw1d) throw new Error('当前仅支持 3D CUBE LUT（检测到 1D 表）。')
    throw new Error('未找到 LUT_3D_SIZE。')
  }
  if (!SUPPORTED_SIZES.has(size)) {
    throw new Error(`L2 支持 17/33/64/65 点 3D LUT，当前为 ${size} 点。`)
  }

  const expected = size * size * size * 3
  if (samples.length < expected) {
    throw new Error(`CUBE 数据不足：期望 ${expected / 3} 个 RGB 样本，实际 ${samples.length / 3}。`)
  }
  if (samples.length > expected) {
    // Some exporters append padding; keep the first full table.
    samples.length = expected
  }

  for (let index = 0; index < 3; index += 1) {
    if (!(domainMax[index] > domainMin[index])) {
      throw new Error('DOMAIN_MIN / DOMAIN_MAX 无效。')
    }
  }

  return {
    title,
    size,
    domainMin,
    domainMax,
    data: new Float32Array(samples),
    fileName,
  }
}

function sampleLattice(lut: CubeLut3D, r: number, g: number, b: number): [number, number, number] {
  const size = lut.size
  const maxIndex = size - 1
  const ri = Math.max(0, Math.min(maxIndex, r))
  const gi = Math.max(0, Math.min(maxIndex, g))
  const bi = Math.max(0, Math.min(maxIndex, b))
  const index = ((bi * size + gi) * size + ri) * 3
  return [lut.data[index], lut.data[index + 1], lut.data[index + 2]]
}

/** Map sRGB-encoded RGB through the 3D lattice with trilinear interpolation. */
export function applyCubeLutRgb(
  rgb: [number, number, number],
  lut: CubeLut3D,
  amount = 100,
): [number, number, number] {
  const mix = clamp01(amount / 100)
  if (mix <= 0) return rgb

  const [rIn, gIn, bIn] = rgb
  // Normalize display RGB into the LUT domain, then to lattice coordinates.
  const nr = (rIn - lut.domainMin[0]) / (lut.domainMax[0] - lut.domainMin[0])
  const ng = (gIn - lut.domainMin[1]) / (lut.domainMax[1] - lut.domainMin[1])
  const nb = (bIn - lut.domainMin[2]) / (lut.domainMax[2] - lut.domainMin[2])

  const maxIndex = lut.size - 1
  const rf = clamp01(nr) * maxIndex
  const gf = clamp01(ng) * maxIndex
  const bf = clamp01(nb) * maxIndex

  const r0 = Math.floor(rf)
  const g0 = Math.floor(gf)
  const b0 = Math.floor(bf)
  const r1 = Math.min(maxIndex, r0 + 1)
  const g1 = Math.min(maxIndex, g0 + 1)
  const b1 = Math.min(maxIndex, b0 + 1)
  const tr = rf - r0
  const tg = gf - g0
  const tb = bf - b0

  const c000 = sampleLattice(lut, r0, g0, b0)
  const c100 = sampleLattice(lut, r1, g0, b0)
  const c010 = sampleLattice(lut, r0, g1, b0)
  const c110 = sampleLattice(lut, r1, g1, b0)
  const c001 = sampleLattice(lut, r0, g0, b1)
  const c101 = sampleLattice(lut, r1, g0, b1)
  const c011 = sampleLattice(lut, r0, g1, b1)
  const c111 = sampleLattice(lut, r1, g1, b1)

  const mapped: [number, number, number] = [0, 0, 0]
  for (let channel = 0; channel < 3; channel += 1) {
    const c00 = c000[channel] * (1 - tr) + c100[channel] * tr
    const c10 = c010[channel] * (1 - tr) + c110[channel] * tr
    const c01 = c001[channel] * (1 - tr) + c101[channel] * tr
    const c11 = c011[channel] * (1 - tr) + c111[channel] * tr
    const c0 = c00 * (1 - tg) + c10 * tg
    const c1 = c01 * (1 - tg) + c11 * tg
    mapped[channel] = c0 * (1 - tb) + c1 * tb
  }

  return [
    clamp01(rIn * (1 - mix) + mapped[0] * mix),
    clamp01(gIn * (1 - mix) + mapped[1] * mix),
    clamp01(bIn * (1 - mix) + mapped[2] * mix),
  ]
}

export function applyCubeLutToImageData(
  source: ImageData,
  lut: CubeLut3D,
  amount: number,
): ImageData {
  if (amount <= 0) return source
  const output = new Uint8ClampedArray(source.data.length)
  const data = source.data
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = applyCubeLutRgb(
      [data[index] / 255, data[index + 1] / 255, data[index + 2] / 255],
      lut,
      amount,
    )
    output[index] = Math.round(r * 255)
    output[index + 1] = Math.round(g * 255)
    output[index + 2] = Math.round(b * 255)
    output[index + 3] = data[index + 3]
  }
  if (typeof ImageData === 'function') {
    try {
      return new ImageData(new Uint8ClampedArray(output), source.width, source.height)
    } catch {
      // fall through
    }
  }
  return { width: source.width, height: source.height, data: output, colorSpace: 'srgb' } as ImageData
}

/** Pack lattice as RGB float texture data for WebGL (size³ × 3). */
export function packCubeLutTextureData(lut: CubeLut3D): Float32Array {
  return lut.data
}
