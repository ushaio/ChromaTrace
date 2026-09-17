# 实施计划：工作区与缩略图栏 V1

> 状态：P0 + P1 + P2 已完成并通过验证（2026-09-17）。剩余项为需真机的人工验收（见 prd.md）。

## 阶段 1：P0 数据地基

- [x] 扩展 `src/lib/types.ts`：manifest、photo、reference、volume、import、progress、磁盘空间、缓存报告。
- [x] 复用资产库 `library_root`；新增 Rust `workspace.rs` 与 20 条命令注册（`lib.rs`）。
- [x] manifest 原子读写（`.tmp` + rename）、`revision` 乐观并发、默认工作区创建、恢复状态归一化。
- [x] 卷判定（Windows `GetDriveTypeW` / `GetVolumeInformationW`，macOS/Linux 分支 + 未知回落）与挂载解析；`volume-policy-v1.json` 持久化（兼容裸字符串与记录对象两种形态）。
- [x] 复制 / 引用导入、`workspace-import-progress` 事件、取消、逐条 manifest 更新、大小校验与半成品清理。
- [x] `decode_raw_thumbnail`（rawler 内嵌预览 → `preview_image` → 完整解码回落）与 `thumbs/` 缓存读写。
- [x] `desktop.ts` 命令封装（含浏览器降级）、`workspace.ts` 纯逻辑、`thumbnails.ts` 缓存键与并发闸门、`hash.ts` 同步 SHA-1。

## 阶段 2：P1 可见能力

- [x] `Filmstrip.tsx` + 固定 96px 样式：单选切换、选中高亮、角标、键盘、绝对定位窗口化。
- [x] `App.tsx` 状态迁移：`source`/`sourceData`/`sourceStats`/`reference` 改为 `useWorkspace` 派生；每图 develop 独立持久化（切图播种 + 400ms 防抖回写）。
- [x] 多文件选择与按卷导入确认面板（`ImportConfirmPanel.tsx`）：目标路径、打开文件夹、空间预检、重复项提示、进度、失败清单。
- [x] 卷策略记忆、改判为「引用」的一次性警告、`VolumeBanner.tsx` 卷缺席聚合条（含「改为复制」/「重新定位」）、`LibrarySettingsPanel` 的卷记忆管理区块。
- [x] 清空工作区（副本 + 缩略图 + manifest，确认框显示可回收空间）与缩略图缓存清理。

## 阶段 3：P2 批量与例外

- [x] 缩略图栏 Ctrl/Shift 多选。
- [x] 「套用当前配方到所选」（`applyRecipeToPhotos`）。
- [x] 单图专属参考：后端 `import_workspace_reference(photo_id)` + `resolve_workspace_reference_path`，前端 `effectiveReference` 统一解析 + 角标。
- [x] 补纯逻辑单元测试与 Rust 路径 / 状态恢复测试。

## 验证与收口

- [x] `npm run test` → 11 个文件 / 86 个测试通过。
- [x] `npm run build`（`tsc -b && vite build`）→ 通过。
- [x] `cargo fmt -- --check` → 干净。
- [x] `cargo test` → 34 个测试通过；`cargo check --all-targets` → 零警告零错误。
- [x] 检查 `git diff`，未触碰用户既有改动范围之外的无关文件。
- [x] 更新 `.trellis/spec/`：`frontend/state-management.md`（状态归属已变更）、`frontend/directory-structure.md`、`frontend/type-safety.md`、`frontend/quality-guidelines.md`、`backend/directory-structure.md`、`backend/database-guidelines.md`、`backend/quality-guidelines.md`。

## 待人工验收（无法在本环境执行）

见 `prd.md` 的「人工验收」小节：真机导入 50 张混合 JPG + RAW、RAW 内嵌预览命中率与耗时、强杀续传、盘符漂移、拔盘提示文案、内存量级、预览不重算。

## 已知偏差（相对原计划）

1. **`photo.stats` 改为首次选中时计算并落盘**，而不是导入时批量预计算。导入时算 stats 需要把每张图解码到 1200px，对 200 张 RAW 正是计划第 5.2 节警告的成本陷阱。
2. **缩略图生成用 `createImageBitmap` + Canvas 而非纯 `createImageBitmap` 缩放**：`createImageBitmap` 只负责解码，尺寸变换与 JPEG 编码仍需 Canvas。
3. **单图入口（选择原片 / 拖入 / 文件输入）统一汇入工作区**，而不是保留并行的 legacy `source` 状态——两套真相源正是本计划要消除的问题。浏览器环境因拿不到本机路径，退化为「载入当前编辑但不写入工作区」。
4. **「重新定位」按卷内相对路径重挂**，保留原 `volumeId`，因此身份与缩略图缓存不失效。
5. **前端不自算 `scrollLeft`**：窗口化用绝对定位，当前项与选中项永远参与渲染，因此 `scrollIntoView` 总能命中；仅在目标落在可视区外时做一次粗调滚动。
