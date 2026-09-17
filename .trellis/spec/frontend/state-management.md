# 状态管理

> 本项目的状态怎么管。

---

## 概述

<!--
在这里记录本项目的状态管理约定。

需要回答：
- 用什么状态管理方案？
- 局部状态与全局状态怎么划界？
- 「服务端状态」怎么处理？
- 派生状态有什么模式？
-->

**已验证的现状**（读自 `src/App.tsx` 与相关模块，尚未上升为规则）：

- **没有引入任何状态库**（没有 Redux / Zustand / Jotai / React Query）。业务状态是 `useState` + 自定义 Hook，通过 props 往下传。
- 顶层有三套工作区，靠一个状态字段切换：`match`（AI 追色，双图）、`grade`（AI 调色，单图）、`settings`。
- ⚠️ **两个编辑工作区共用同一个 `source`**：`AiColorWorkspace`（`grade` 工作区）是通过 props 接收 `App.tsx` 里那份 `source` 的，不是自己持有的。**改动 `source` 的语义时必须同时检查两处。**
- **图像状态已迁移到工作区模型**（2026-09 起）：`src/lib/useWorkspace.ts` 是唯一真相源容器，`App.tsx` 里不再有 `source` / `reference` / `sourceData` / `sourceStats` / `referenceStats` 这几个 `useState`，它们由 Hook 派生：

  | 状态 | 归属 |
  |------|------|
  | `reference` / `referenceStats` | 工作区级（`manifest.reference`） |
  | `adjustments` / `fineTuneVisibility` / `matchRenderMode` / `modelStyle` | 每图（`photo.develop`） |
  | `source` / `sourceData` | 派生：当前选中 photo + 分析图 LRU |

- **`manifest` 是唯一真相源，`App.tsx` 的四个编辑态只是镜像**：切图时按 `photo.develop` 播种，改动后经 400ms 防抖写回 `photos[currentId].develop`。因此**不存在“切图时提交参数”这一步**，也就不会“忘记保存就切图”而丢参数。想再加编辑参数时，走 `useWorkspace().updateDevelop(patch)`，不要另起一份全局单份状态。
- 三级内存管线（多图常驻会 OOM）：缩略图 256px 落盘 `thumbs/`、分析图 1200px 内存 LRU（容量 5）、全解析图只保留当前一张，切图时对旧值 `revokeObjectURL`。
- 没有服务端状态。所谓「远端数据」只有两类：Tauri IPC 调用（本地进程）和模型 API 请求（一次性、不缓存）。
- 持久化只走 Tauri Store（非敏感设置）、工作区 `manifest.json`——见 [后端数据存储](../backend/database-guidelines.md)。

需要团队留意的既有约束：

- `App.tsx` 里的预览派生数据（`matchPreviewData`）依赖 `useElementSize` 观测到的预览框尺寸（80ms 防抖），内部含**全图 `drawImage` + `getImageData`**，并会牵动 GPU 纹理重建。因此 **预览区高度绝不能做布局动画**（不得悬停展开、不得可拖拽调高），否则鼠标每次扫过都会重跑一整轮。这是实测踩出来的坑，不是理论担忧。
- 同一条约束的推论：**缩略图栏固定 96px、绝不参与布局动画**。`.stage` 用五段网格 `55px auto minmax(0,1fr) auto 29px`（工具栏 / 卷条 / 预览框 / 缩略图栏 / 状态栏），空槽位高度为 0，这样预览框尺寸只随窗口变化。
- `useWorkspace` 的异步载入用自增 token（`selectionToken` / `referenceToken`）作废旧结果，快速连续切图时旧图的解码结果不会回写覆盖新图。

需要团队拍板的问题：

1. `App.tsx` 仍有 1200 行量级，是否继续把工作区/模型设置/资产库拆成 Context 或独立容器？
2. props 逐层透传的下限是多少层时应该改用 Context？


---

## 状态分类

<!-- 局部状态、全局状态、服务端状态、URL 状态各放哪里 -->

（待团队补充）

---

## 什么时候该提升为全局状态

<!-- 把状态提升到顶层 / Context 的判据 -->

（待团队补充）

---

## 服务端状态

<!-- 远端数据的缓存与同步策略 -->

（待团队补充）

---

## 常见错误

<!-- 团队在状态管理上踩过的坑 -->

（待团队补充）
