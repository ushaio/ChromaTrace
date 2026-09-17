# 目录结构

> 本项目前端代码的组织方式。

---

## 概述

前端是 React 19 + Vite 的单页应用，源码全部在 `src/`，**只有三个目录层级**：`src/` 根、`src/components/`、`src/lib/`。

没有 `features/`、`hooks/`、`stores/`、`pages/` 这类目录——组件的组织方式是**扁平**的（全部并列在 `src/components/`），有状态逻辑与纯工具**同放在 `src/lib/`**，测试与被测文件**同目录并列**。

---

## 目录布局

```
src/
├── main.tsx                     (5 行)     React 挂载入口
├── App.tsx                      (1203)     顶层导航 + 三套工作区 + 全局状态
├── styles.css                   (3878)     全局样式（单文件）
│
├── components/                  16 个文件（含 1 个测试）
│   ├── AssetLibraryPanel.tsx    (1428)     资产库面板
│   ├── AiColorWorkspace.tsx     (1171)     AI 调色工作区（接收 props 的 source）
│   ├── ModelSettingsWorkspace.tsx  (619)   模型设置工作区
│   ├── FineTunePanels.tsx       (361)      追色高级精修面板
│   ├── ImportConfirmPanel.tsx   (~155)     按卷分组的导入确认面板
│   ├── LibrarySettingsPanel.tsx (330)      资料库位置、迁移、卷记忆
│   ├── Filmstrip.tsx            (~250)     缩略图导航栏（固定 96px）
│   ├── CompareModeControls.tsx  (171)      Before/After 对比控件
│   ├── VolumeBanner.tsx         (~70)      卷缺席汇总条（按卷聚合，一个卷一条）
│   ├── CurveEditor.tsx          (114)      五点曲线编辑器
│   ├── ImageDrop.tsx            (67)       拖拽 / 选择图片
│   ├── Control.tsx              (29)       通用表单控件
│   ├── Histogram.tsx            (18)       直方图
│   ├── PhotoPropertiesDialog.tsx (119)     图片属性弹窗（文件信息 + EXIF）
│   └── AssetLibraryPanel.test.ts (44)
│
└── lib/                         30 个文件（含 11 个测试）
    ├── gpuPreview.ts            (1084)     WebGL2 预览渲染
    ├── colorEngine.ts           (970)      本地颜色分析与像素处理（CPU）
    ├── desktop.ts               (1328)     Tauri IPC 桥接 + 浏览器降级
    ├── useWorkspace.ts          (986)      工作区状态容器（唯一真相源）
    ├── lightroomXmp.ts          (486)      XMP 预设读写
    ├── workspace.ts             (~430)     工作区纯逻辑：身份、容错、导入计划、批量套用、删除后的落点
    ├── types.ts                 (473)      跨模块共享类型
    ├── cubeLut.ts               (241)      CUBE LUT
    ├── thumbnails.ts            (~170)     缩略图缓存键与生成（有限并发）
    ├── files.ts                 (197)      图片解码、重编码、Canvas、JPEG 输出
    ├── modelSettings.ts         (162)      模型设置持久化与默认值
    ├── exportImage.ts           (150)      导出
    ├── hash.ts                  (~105)     纯 JS 同步 SHA-1（与 Rust 同约定）
    ├── defaults.ts              (133)      默认参数
    ├── fineTuneVisibility.ts    (108)      精修模块可见性（统一驱动预览/导出）
    ├── useElementSize.ts        (61)       元素尺寸观测 Hook
    ├── photoProperties.ts       (114)      属性弹窗的文件信息组装（EXIF 分组由后端给成品文案）
    ├── format.ts                (20)       字节数 / 千分位格式化（工作区与属性弹窗共用）
    └── aiColor.ts               (48)       AI 调色配方强度转换
```

共约 15000 行。行数是体量信号，不是规则。

---

## 模块组织

| 位置 | 放什么 | 不放什么 |
|------|--------|----------|
| `src/App.tsx` | 顶层导航、工作区切换、编辑态镜像 | 具体的图像算法、IPC 细节 |
| `src/components/` | 纯 UI 组件（扁平并列，不嵌套子目录） | 图像算法、网络请求、类型定义 |
| `src/lib/` | 图像处理、IPC 桥接、类型、Hook、持久化、工作区状态容器 | JSX |

几条已存在的实际边界：

- **`desktop.ts` 是唯一的 IPC 边界**。组件不直接 `invoke()`，而是调用 `desktop.ts` 导出的函数；浏览器模式下由它内部降级，因此 `npm run dev` 不依赖 Tauri 外壳。
- **`types.ts` 是唯一的跨模块类型出口**。组件与 lib 模块不各自定义跨模块类型。
- **GPU 与 CPU 双实现**：`gpuPreview.ts`（WebGL2）负责预览，`colorEngine.ts`（Canvas 2D）是 CPU 实现也是回落路径。改颜色算法时要意识到有两条路径。
- **`useWorkspace.ts` 是图像状态的唯一真相源**（`src/lib/` 下，不新建 `hooks/` 目录——本项目把有状态 Hook 也放在 `lib/`）。它持有 manifest、当前图片、分析图 LRU、缩略图 URL 与导入流程；`App.tsx` 只镜像当前图的四个编辑态。
- **纯逻辑与副作用分离**：`workspace.ts` / `thumbnails.ts` / `hash.ts` 是不碰 DOM、不碰 Tauri 的纯函数层，可以直接单测；`useWorkspace.ts` 与 `desktop.ts` 负责编排与 IO。


---

## 命名约定（观测所得，尚未形成正式规则）

- 组件文件：`PascalCase.tsx`，一个文件一个组件。
- lib 模块：`camelCase.ts`。
- 测试：与被测文件**同目录同前缀**，扩展名 `.test.ts`（`colorEngine.ts` → `colorEngine.test.ts`）。
- 自定义 Hook：`use` 前缀（目前只有 `useElementSize.ts`）。
- 样式：不使用 CSS Modules / CSS-in-JS / Tailwind，全部写进全局 `src/styles.css`。

以上若有不对或该收紧的地方，直接改这个文件——它就是子 agent 未来要遵守的契约。

---

## 示例

`src/lib/fineTuneVisibility.ts`（108 行）是「小而单一职责」的范例：一个纯函数把精修模块的可见性统一算出，预览、导出、另存 XMP 三处都调它，避免了三处各写一遍判断。

---

## 待决问题

- `App.tsx`（1203 行）与 `AssetLibraryPanel.tsx`（1428 行）是否拆分？拆的第一个切口在哪？
- `components/` 一直扁平，组件数量继续增长后要不要按工作区分子目录？
- `styles.css` 是单个 3878 行的文件，是否引入样式方案（CSS Modules / 原子化 CSS）？
- `src/lib/` 现在混合了「纯算法」与「有状态 Hook」，要不要分开？
