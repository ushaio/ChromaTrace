/**
 * 展示用的格式化工具。
 *
 * 这些函数被工作区状态容器与属性弹窗共用：字节数的单位（KB/MB/GB）在两处必须一致，
 * 否则同一个文件会在两个界面上显示成不同大小。
 */

/** 人类可读的字节数。 */
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

/**
 * 千分位分组。
 *
 * 刻意不用 `toLocaleString`：属性弹窗要展示精确字节数，而同一份信息在不同系统语言下
 * 会显示成 `1,234,567` 或 `1 234 567`，截图与工单里就对不上了。
 */
export function groupDigits(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
