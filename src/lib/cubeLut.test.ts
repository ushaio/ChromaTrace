import { describe, expect, it } from 'vitest'
import { applyCubeLutRgb, detectCubeLutSize, parseCubeLut } from './cubeLut'

function identityCube(size = 17) {
  const lines = [
    'TITLE "Identity"',
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ]
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(`${(r / (size - 1)).toFixed(6)} ${(g / (size - 1)).toFixed(6)} ${(b / (size - 1)).toFixed(6)}`)
      }
    }
  }
  return lines.join('\n')
}

describe('parseCubeLut', () => {
  it('parses a 17-point identity 3D cube', () => {
    const lut = parseCubeLut(identityCube(17), 'identity.cube')
    expect(lut.size).toBe(17)
    expect(lut.title).toBe('Identity')
    expect(lut.data.length).toBe(17 * 17 * 17 * 3)
  })

  it('supports 64-point 3D cubes', () => {
    const lut = parseCubeLut(identityCube(64), 'identity-64.cube')
    expect(lut.size).toBe(64)
    expect(lut.data.length).toBe(64 * 64 * 64 * 3)
  })

  it('detects the declared size without parsing the full table', () => {
    expect(detectCubeLutSize('# exported LUT\nTITLE "Demo"\nLUT_3D_SIZE 65\n0 0 0')).toBe(65)
    expect(detectCubeLutSize('LUT_1D_SIZE 64\n0 0 0')).toBeNull()
  })

  it('rejects 1D-only or unsupported sizes', () => {
    expect(() => parseCubeLut('LUT_1D_SIZE 16\n0 0 0\n1 1 1', 'a.cube')).toThrow(/3D|LUT_3D/)
    expect(() => parseCubeLut('LUT_3D_SIZE 9\n0 0 0', 'b.cube')).toThrow(/17\/33\/64\/65/)
  })
})

describe('applyCubeLutRgb', () => {
  it('leaves colors unchanged through an identity LUT at full strength', () => {
    const lut = parseCubeLut(identityCube(17), 'identity.cube')
    const samples: Array<[number, number, number]> = [
      [0, 0, 0],
      [1, 1, 1],
      [0.25, 0.5, 0.75],
      [0.12, 0.33, 0.91],
    ]
    for (const sample of samples) {
      const mapped = applyCubeLutRgb(sample, lut, 100)
      expect(mapped[0]).toBeCloseTo(sample[0], 4)
      expect(mapped[1]).toBeCloseTo(sample[1], 4)
      expect(mapped[2]).toBeCloseTo(sample[2], 4)
    }
  })

  it('mixes with the source at partial strength', () => {
    const size = 17
    const lines = [
      'TITLE "Lift"',
      `LUT_3D_SIZE ${size}`,
      'DOMAIN_MIN 0 0 0',
      'DOMAIN_MAX 1 1 1',
    ]
    for (let b = 0; b < size; b += 1) {
      for (let g = 0; g < size; g += 1) {
        for (let r = 0; r < size; r += 1) {
          // Map everything toward pure red.
          lines.push('1 0 0')
        }
      }
    }
    const lut = parseCubeLut(lines.join('\n'), 'lift.cube')
    const half = applyCubeLutRgb([0, 1, 0], lut, 50)
    expect(half[0]).toBeCloseTo(0.5, 4)
    expect(half[1]).toBeCloseTo(0.5, 4)
    expect(half[2]).toBeCloseTo(0, 4)
  })
})
