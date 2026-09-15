import { describe, expect, it } from 'vitest'
import type { LibraryAsset } from '../lib/desktop'
import { filterLibraryAssets } from './AssetLibraryPanel'

const assets: LibraryAsset[] = [
  {
    id: 'warm',
    kind: 'xmp',
    name: 'Warm Portrait',
    fileName: 'warm-portrait.xmp',
    relativePath: 'People/Portrait/warm-portrait.xmp',
    folder: 'People/Portrait',
    sizeBytes: 1200,
    modifiedMs: 1,
    lutSize: null,
  },
  {
    id: 'cinema',
    kind: 'xmp',
    name: 'Cinema Blue',
    fileName: 'cinema-blue.xmp',
    relativePath: 'Film/Cinema Blue.xmp',
    folder: 'Film',
    sizeBytes: 1300,
    modifiedMs: 2,
    lutSize: null,
  },
]

describe('filterLibraryAssets', () => {
  it('matches display names and file names without case sensitivity', () => {
    expect(filterLibraryAssets(assets, 'WARM')).toEqual([assets[0]])
    expect(filterLibraryAssets(assets, 'cinema-blue.xmp')).toEqual([assets[1]])
  })

  it('matches folder names and relative paths', () => {
    expect(filterLibraryAssets(assets, 'portrait')).toEqual([assets[0]])
    expect(filterLibraryAssets(assets, 'people/portrait')).toEqual([assets[0]])
  })

  it('returns every asset for a blank query', () => {
    expect(filterLibraryAssets(assets, '  ')).toBe(assets)
  })
})
