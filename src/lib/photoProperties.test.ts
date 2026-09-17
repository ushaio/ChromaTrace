import { describe, expect, it } from 'vitest'
import { formatBytes, groupDigits } from './format'
import { describeFileType, describePixelSize, fileInfoGroup, propertiesGroups } from './photoProperties'
import type { PropertiesGroup, WorkspacePhoto, WorkspacePhotoProperties } from './types'

/** 固定时间渲染：断言不该依赖运行测试的机器的时区。 */
const fixedTime = (ms: number) => `T${ms}`

function photo(overrides: Partial<WorkspacePhoto> = {}): WorkspacePhoto {
  return {
    id: 'photo-1',
    volumeId: 'VOL1',
    relativeSourcePath: '2024/a.cr3',
    sourcePath: 'E:/2024/a.cr3',
    origin: 'reference',
    workspacePath: null,
    status: 'ready',
    sizeBytes: 1024,
    mtimeMs: 1_600_000_000_000,
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

function properties(overrides: Partial<WorkspacePhotoProperties> = {}): WorkspacePhotoProperties {
  return {
    photoId: 'photo-1',
    fileName: 'IMG_0001.CR3',
    relativeSourcePath: '2024/IMG_0001.CR3',
    sourcePath: 'E:/2024/IMG_0001.CR3',
    workspacePath: 'originals/2024/IMG_0001.CR3',
    resolvedPath: 'C:/Library/workspaces/default/originals/2024/IMG_0001.CR3',
    origin: 'copy',
    status: 'ready',
    statusReason: null,
    volumeId: 'VOL1',
    isRaw: true,
    extension: 'cr3',
    sizeBytes: 12_345_678,
    modifiedMs: 1_700_000_000_000,
    editedAt: null,
    width: 6000,
    height: 4000,
    exifSource: 'file',
    exifNote: null,
    exifGroups: [],
    ...overrides,
  }
}

const valueOf = (group: PropertiesGroup, label: string) =>
  group.fields.find((field) => field.label === label)?.value

describe('fileInfoGroup', () => {
  it('renders the native facts with shared units and an exact byte count', () => {
    const group = fileInfoGroup(photo(), properties(), { formatTime: fixedTime })

    expect(valueOf(group, '文件名')).toBe('IMG_0001.CR3')
    expect(valueOf(group, '文件类型')).toBe('CR3（相机 RAW）')
    expect(valueOf(group, '像素尺寸')).toBe('6000 × 4000 像素（24.0 MP）')
    expect(valueOf(group, '文件大小')).toBe('11.8 MB（12,345,678 字节）')
    // 「文件修改时间」恒取 manifest 记录的源文件时间，磁盘上那个文件的时间单独一行 ——
    // 否则 copy 类图会在 EXIF 加载完成的那一刻把时间显示换成复制时刻。
    expect(valueOf(group, '文件修改时间')).toBe('T1600000000000')
    expect(valueOf(group, '磁盘文件时间')).toBe('T1700000000000')
    expect(valueOf(group, '来源')).toBe('已复制到工作区')
    expect(valueOf(group, '状态')).toBe('就绪')
    expect(valueOf(group, '读取路径')).toBe('C:/Library/workspaces/default/originals/2024/IMG_0001.CR3')
  })

  it('falls back to manifest fields when native properties are unavailable', () => {
    const manifestPhoto = photo({ sizeBytes: 2048, origin: 'reference' })
    const group = fileInfoGroup(manifestPhoto, null, { formatTime: fixedTime })

    expect(valueOf(group, '文件大小')).toBe('2.0 KB（2,048 字节）')
    expect(valueOf(group, '来源')).toBe('直接引用原文件')
    expect(valueOf(group, '工作区副本')).toBe('未复制（直接引用）')
    expect(valueOf(group, '文件修改时间')).toBe('T1600000000000')
    expect(valueOf(group, '磁盘文件时间')).toBeUndefined()
    // 只有本机才知道读取路径：拿不到时整行不显示，而不是留一个空标签。
    expect(valueOf(group, '读取路径')).toBeUndefined()
  })

  it('renders the backend-provided reason verbatim, without second-guessing it', () => {
    // 「只有异常状态才给 reason」这条门控在 Rust 侧（photo_info::collect_properties）。
    // 前端只负责照搬：再判一次会让「后端想解释一句」永远显示不出来。
    const ready = fileInfoGroup(photo(), properties(), { formatTime: fixedTime })
    expect(valueOf(ready, '状态')).toBe('就绪')

    const missing = fileInfoGroup(
      photo(),
      properties({ status: 'missing', statusReason: '请连接该设备' }),
      { formatTime: fixedTime },
    )
    expect(valueOf(missing, '状态')).toBe('不可用：请连接该设备')
  })
})

describe('propertiesGroups', () => {
  it('puts file info first and appends the backend exif groups', () => {
    const groups = propertiesGroups(photo(), properties({
      exifGroups: [{ title: '曝光', fields: [{ label: '快门', value: '1/250 秒' }] }],
    }), { formatTime: fixedTime })

    expect(groups.map((group) => group.title)).toEqual(['文件', '曝光'])
  })

  it('still renders file info when there is no exif at all', () => {
    const groups = propertiesGroups(photo(), null, { formatTime: fixedTime })
    expect(groups).toHaveLength(1)
    expect(groups[0].fields.length).toBeGreaterThan(0)
  })
})

describe('formatters', () => {
  it('keeps byte units and digit grouping deterministic', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12_345_678)).toBe('11.8 MB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00 GB')
    expect(groupDigits(999)).toBe('999')
    expect(groupDigits(1234567)).toBe('1,234,567')
  })

  it('does not mistake a dotless file name for an extension', () => {
    const dotless = photo({ relativeSourcePath: 'noext', sourcePath: 'E:/noext', isRaw: false })
    expect(describeFileType(dotless, null)).toBe('未知格式')
    expect(describeFileType(dotless, null)).not.toContain('NOEXT')
  })

  it('omits the pixel size when either dimension is missing', () => {
    expect(describePixelSize({ width: null, height: 4000 })).toBeNull()
    expect(describePixelSize({ width: 0, height: 0 })).toBeNull()
    expect(describePixelSize({ width: 1920, height: 1080 })).toBe('1920 × 1080 像素（2.1 MP）')
  })
})
