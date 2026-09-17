# 质量规范

> 前端代码的质量标准。

---

## 概述

<!--
在这里记录本项目的质量标准。

需要回答：
- 哪些模式被禁止？
- 强制执行哪些 lint 规则？
- 测试要求是什么？
- 代码评审遵循什么标准？
-->

**已验证的现状**（读自 `package.json` 与仓库，尚未上升为规则）：

- 可用脚本只有这些（`package.json`）：`dev`、`build`、`test`、`preview`、`tauri`、`tauri:dev`、`tauri:build`。
- **类型检查是构建的一部分**：`build` = `tsc -b && vite build`。也就是说类型错误会让构建直接失败——这是前端侧目前最硬的一道门禁。
- 单元测试：`npm run test`（即 `vitest run`）。测试文件与被测源码同目录并列放置（`*.test.ts`），集中在 `src/lib/` 与 `src/components/AssetLibraryPanel.test.ts`。**vitest 默认跑在 node 环境**（`vite.config.ts` 没有 `test` 段）——纯逻辑可以测，依赖 DOM 的代码（缩略图生成、Canvas 绘制）测不了；写新逻辑时应把可测部分抽成不碰 DOM 的纯函数。
- 2026-09 工作区改造后的测试面貌：**12 个测试文件 / 103 个测试**。新增的纯逻辑测试为 `src/lib/hash.test.ts`（SHA-1 标准向量 + 与 Rust 钉同一摘要）、`src/lib/thumbnails.test.ts`（缓存键敏感性、大小写归一、并发闸门）、`src/lib/workspace.test.ts`（图片身份、`effectiveReference`、manifest 容错、批量套用、导入计划与空间预检、删除后的当前图落点）、`src/lib/photoProperties.test.ts`（属性弹窗的文件信息组装、字节单位与千分位、无点号文件名不当作扩展名）。
- 工具辅助检查（非强制门禁，改完建议跑）：`npx tsc -p tsconfig.app.json --noEmit --noUnusedLocals --pretty false` 能暴露构建不拦的死导入。**注意**：仓库里有若干**既有**未使用项（`App.tsx` 的 `KeyRound` / `Save` / `Wifi` / `WifiOff` / `canvasToBlob`、`AiColorWorkspace.tsx` 的 `canvasToBlob` / `generatedSourceData`、`AssetLibraryPanel.tsx` 的 `count`），别把它们当成自己引入的问题。
- **没有配置 ESLint / Prettier**：仓库里没有相关配置文件，`package.json` 里也没有 `lint` / `format` 脚本。所以代码风格目前靠约定，不靠工具。
- 测试覆盖集中在纯逻辑：`colorEngine`（970 行）有 380 行测试、`gpuPreview`、`lightroomXmp`、`cubeLut`、`aiColor`、`modelSettings`、`fineTuneVisibility` 都有对应测试；而**体量最大的两个文件没有测试**——`App.tsx`（1203 行）和 `components/AssetLibraryPanel.tsx`（1428 行）。

需要团队拍板的问题：

1. 要不要引入 ESLint（+ Prettier）并加进 CI？现在唯一的自动化门禁是「类型 + 构建」。
2. `App.tsx` / `AssetLibraryPanel.tsx` 这类巨型组件长期没有测试，是否接受？如果要补，先从哪里切？
3. 测试放哪：继续与源码同目录并列，还是迁到独立的 `__tests__/`？

---

## 禁止模式

<!-- 绝不允许使用的模式，以及原因 -->

（待团队补充）

---

## 必须遵循的模式

<!-- 必须始终使用的模式 -->

（待团队补充）

---

## 测试要求

<!-- 期望达到的测试程度 -->

（待团队补充）

---

## 代码评审清单

<!-- 评审者应该检查什么 -->

（待团队补充）
