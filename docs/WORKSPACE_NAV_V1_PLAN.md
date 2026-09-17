# 工作区层级导航改造 V1 计划

> 更新日期：2026-09-17
> 平台：Tauri 2 (Windows) + React 19 + TypeScript
> 状态：**已实施完毕，待人工试用验收**（`cargo check` / `tsc` / `vitest` 86 项 / `npm run build` 全绿）

---

## 1. 需求原文

> 将工作区放在顶部 AI 追色左侧，类似于 Lightroom 和像素蛋糕，工作区进入显示展示各工作区（文件夹语义），然后进入工作区再显示工作区下的素材进入查看，在进入对应工作区下，然后切换到 AI 追色、调色等功能时，则相关修图展示的图片内容即为对应工作区的素材了，如要切换工作区，则返回到工作区页面下进入到其他工作区的素材页面再切换回修图菜单。

补充约束：

> 切换修图菜单必须要进入工作区内容才可以。

> 依旧回到工作区，返回到上一级进入到对应工作内下，回到修图菜单；并且工作区加一个下拉箭头，展示当前存在的工作区，用于快速切换。

### 可验收行为

| # | 行为 | 验收要点 |
|---|------|----------|
| B1 | 顶部导航最左侧新增「工作区」组合控件 | 位于「AI 追色」左边；带下拉箭头 |
| B2 | 点「工作区」文字 → 工作区列表页 | 文件夹语义卡片（名称 / 张数 / 封面 / 更新时间） |
| B3 | 点下拉箭头 → 展开工作区列表供**快速切换** | 列出 `workspaces.json` 中全部工作区 |
| B4 | 进入某工作区 → 显示该工作区素材 | 网格画廊 + 视图切换（大图 + 底部缩略图栏） |
| B5 | 从素材页切到 AI 追色 / 调色，修图内容即该工作区素材 | `source` / `reference` 天然来自该工作区 manifest |
| B6 | **准入条件**：未进入过任何工作区时，修图菜单不可用 | 见 §3.2 的精确触发条件 |
| B7 | 快速切区需二次确认 | 见 §3.4 |

---

## 2. 勘察结论（影响方案可行性的硬事实）

### 2.1 后端：几乎零改造

- `src-tauri/src/workspace.rs` 中 **23 个 `#[tauri::command]` 全部已接收 `workspace_id: String`**（`lib.rs` 50–69 行注册）。
- 磁盘结构已是 `workspaces/<id>/`，含 `originals/`、`references/`、`thumbs/`。
- `normalize_workspace_id(raw)`（157 行）已内建路径穿越防护：拒绝空、`.`、`..`、`/`、`\`、控制字符、`:`、`\0`。
- `ensure_workspace_dirs`（177 行）做 canonicalize 越界校验 + 符号链接拒绝。

⇒ **现有 23 个命令零签名改动**，只需新增「枚举 / 新建 / 重命名 / 删除」类命令。

### 2.2 前端：改造集中在三处

| 文件 | 改造内容 | 风险 |
|------|----------|------|
| `src/lib/useWorkspace.ts` | 接收 `workspaceId` 入参；内部所有 `desktop.ts` 调用显式传参；切区时清空缓存与派生状态 | **高** —— 缓存隔离做错会串图 |
| `src/App.tsx` | 新增顶层视图状态；`.workspace-nav` 插入工作区组合控件；新增列表页渲染分支；stage 内加视图模式 | 中 |
| `src/lib/desktop.ts` + `types.ts` + Rust | 新增工作区注册表与 IPC；修复浏览器预览的单份 manifest | 中 |

### 2.3 缓存隔离是核心风险（正确性，非优化）

`photoId`（= `sha1(volumeId + "|" + relativeSourcePath)`）**与工作区无关**——同一张图在两个工作区里 id 相同。但缓存是**按工作区隔离的**：

- `thumbs/<key>` 物理落在各自工作区目录下；
- `analysisCache`（LRU，容量 5）与 `thumbUrls`（objectURL）都是当前工作区的派生数据。

⇒ **切区必须清空** `thumbUrls`（逐个 `URL.revokeObjectURL`）、`thumbInFlight`、`analysisCache`、`sourceRef`/`referenceRef`，并重置 `currentId` / `selection` / `source` / `sourceData` / `sourceStats`。漏掉任何一项都会出现「A 区的缩略图挂在 B 区的图上」。

### 2.4 切区必须先 flush 写入防抖

`MANIFEST_WRITE_DEBOUNCE_MS = 400`。切区前若不 flush，A 区最后 400ms 内的 develop 改动会被写入 B 区的 manifest（commit 串区），属于数据损坏。

### 2.5 参考图边界已安全

`loadReference(entry)` 的行为是：**先** `setReferenceImage(null)` + revoke 旧 URL，**再**判断 `entry.status !== 'ready'` 提前返回。所以切到无参考图的工作区时，上一个工作区的参考图会被正确释放，不会残留。

### 2.6 不能碰的布局约束

`matchPreviewData` 依赖 `useElementSize` 观测的预览框尺寸（80ms 防抖），内含全图 `drawImage` + `getImageData` 并牵动 GPU 纹理重建。

⇒ 预览区高度**绝不能做布局动画**；网格与预览必须**共用同一个 stage 实例**，用视图模式显隐，而非挂载第二套预览（否则切换时预览框从 0 尺寸建立，触发全量重算 + 闪屏）。

### 2.7 数据模型障碍：「未登记文件」方案不可行（已否决）

原计划在网格中额外展示 `originals/` 下未登记的裸文件。勘察后发现数据模型不足以支撑：

- 去重键是 `photoIdentity(volumeId, relativeSourcePath)`（`workspace.ts:272`），identity **必须**包含 `volumeId`；
- 但 `photo_target_relative` 落盘为 `originals/{relativeSourcePath}`（`workspace.rs:288`）——**卷维度被丢弃**，无法从路径反推 `volumeId`；
- 更严重：跨卷同名文件（C 盘与 E 盘各有一份 `2024/a.cr3`）在 `originals/` 下**会撞路径**——`buildImportPlan` 无跨卷同名检测，`photo_target_relative` 也未调用 `unique_relative_path`。

⇒ **决策：网格仅展示 manifest 中已登记的 photos**（与 Filmstrip 完全同源）。跨卷同名撞路径是既存隐患（另行评估）。

### 2.8 浏览器预览的单份 manifest 是必须修的缺陷

`desktop.ts:915` 的 `browserWorkspace` 是**单个全局变量**：

```ts
let browserWorkspace: WorkspaceManifest = emptyBrowserManifest()
```

所有 `!isTauri()` 分支都读写它。即使传入不同 `workspaceId`，浏览器环境下所有工作区都指向**同一份** manifest。多工作区改造后这会直接表现为「浏览器预览里切换工作区无变化」。⇒ 必须改为 `Map<string, WorkspaceManifest>` + `browserThumbnails` 的 key 加 `workspaceId` 前缀。

---

## 3. 已确认的决策

### 3.1 分叉点 A：工作区名称 → **独立注册表（A1）**

`library_root/workspaces.json` 存 `{ id, name, createdAt, updatedAt }`。

理由：枚举工作区**不必扫描所有 manifest**（大工作区不卡）；名称与 manifest 的 revision 乐观并发解耦，改名不触发「工作区已在别处更新」的冲突提示。张数 / 封面由列表页惰性读取，不进注册表。

### 3.2 分叉点 B：修图菜单的准入条件 → **仅拦「未选工作区」**

规则收敛为一句话：

> **只有在「从未选择过任何工作区」或「上次选的工作区已不存在」时，才拦住修图菜单。**

- **空工作区（0 张素材）不拦** —— 左栏的「导入图片（可多选）」与 `ImportConfirmPanel` 就在那里，进去能直接导入，不是死胡同。
- **冷启动恢复上次状态** —— `activeWorkspaceId` 持久化到 localStorage，重启后直接回到上次的修图界面，不强制走一遍列表页。

⇒ 拦截的真实触发场景只剩一个：**首次运行**（localStorage 无有效 `activeWorkspaceId`）。
⇒ localStorage 中的 id 失效校验：启动时用 `listWorkspaces()` 结果比对，不在列表中则清除并视为「未选」。

### 3.3 导航路径：**两条并存**

- **长路径**（用户原文）：修图态 →（点「工作区」文字）→ 列表页 → 点另一区 → 网格 → 回修图菜单。
- **短路径**（新增）：修图态 →（点下拉箭头）→ 直接选另一区 → 确认 → 切换。列表页仍然存在且可达。

⇒ 「工作区」组合控件**全程常驻顶部**，进区后不隐藏。

### 3.4 快速切区 → **弹确认框**

下拉选中其他工作区时弹确认：「正在编辑「风光精选」，切换到「人像客片」？」
理由：切区是秒级无声操作，会 flush 写入 + 清空全部缩略图缓存，手滑点错的代价是重新加载一遍。

### 3.5 素材页形态 → **共用 stage + 视图模式切换**

- 素材页与 AI 追色**共用同一个 stage 组件实例**；
- 点「网格」时预览区被网格覆盖（预览仍在 DOM，仅隐藏），点「单图」恢复；
- 预览框尺寸保持不变 ⇒ 切换零重算、不闪屏；网格双击一张图可平滑进入修图。

---

## 4. 导航状态机

```
workspaceMode: 'workspaces' | 'match' | 'grade' | 'settings'
                └─ 一级 ─┘   └──── 修图态 ────┘
stageView: 'grid' | 'single'          // 仅在有 activeWorkspaceId 时可用
activeWorkspaceId: string | null      // 持久化到 localStorage
```

- **`workspaces`（一级）**：工作区列表页，整页替换 `<main>`。卡片 = 文件夹语义。
  点击卡片 → `activeWorkspaceId = id` + `workspaceMode = 'match'` + `stageView = 'grid'`。
- **`match` / `grade`（修图态）**：沿用现有布局；`stageView` 控制预览区 vs 网格。
- **顶部组合控件**：左段文字「工作区」→ 进一级；右段箭头 → 下拉列出全部工作区，选中但非当前项时弹确认。

### 准入判断（B6）

```
canUseEditor = activeWorkspaceId !== null && activeWorkspaceId ∈ workspaces
```

`!canUseEditor` 时：AI 追色 / AI 调色按钮 `disabled` + `title="请先进入工作区"`。

---

## 5. 代码改动清单

### 5.1 Rust（`src-tauri/src/workspace.rs` / `lib.rs`）

- [ ] `WorkspaceInfo` 结构体（`id` / `name` / `created_at` / `updated_at`）。
- [ ] 注册表读写：`library_root/workspaces.json`，沿用 `write_manifest_atomic` 的原子替换策略（含 Windows `.bak` 分支）。
- [ ] `list_workspaces(app)` → `Vec<WorkspaceInfo>`，首次调用若注册表不存在，以现有 `default` 目录播种。
- [ ] `create_workspace(app, name)` → `WorkspaceInfo`（`normalize_workspace_id` 生成 id + `ensure_workspace_dirs` + 写注册表）。
- [ ] `rename_workspace(app, workspace_id, name)`。
- [ ] `delete_workspace(app, workspace_id)`（拒绝删除最后一个工作区；拒绝越界路径）。
- [ ] 在 `lib.rs::generate_handler` 注册新命令。

### 5.2 前端类型与 IPC

- [ ] `types.ts`：新增 `WorkspaceInfo`。
- [ ] `desktop.ts`：新增 `listWorkspaces` / `createWorkspace` / `renameWorkspace` / `deleteWorkspace` 封装。
- [ ] `desktop.ts`：**修复 §2.8 缺陷** —— `browserWorkspace` 改为 `browserWorkspaces: Map<string, WorkspaceManifest>`；`browserThumbnails` key 加 `workspaceId` 前缀；`clearWorkspace` 只清对应项。

### 5.3 `useWorkspace.ts`

- [ ] 签名改为 `useWorkspace(notify, workspaceId: string)`。
- [ ] 所有 `desktop.ts` 调用显式传 `workspaceId`（当前全是隐式默认值）。
- [ ] 第 416 行缩略图 effect 中硬编码的 `DEFAULT_WORKSPACE_ID` 改为参数值。
- [ ] 新增 `workspaceId` 变化时的重置 effect（**顺序不可颠倒**）：
      ① **先 flush 写入防抖**（§2.4，否则串区）
      ② revoke 全部 `thumbUrls`
      ③ `thumbInFlight.clear()`
      ④ `analysisCache.clear()`
      ⑤ `sourceRef` / `referenceRef` revoke
      ⑥ `setReady(false)` / `setCurrentId(null)` / `setSelection([])` / `setSource(null)` / `setSourceData(null)` / `setSourceStats(null)`
- [ ] 切区时 `selectionToken` / `referenceToken` 自增，作废在途请求的竞态保护。

### 5.4 `App.tsx`

- [ ] 新增 `activeWorkspaceId` state（localStorage 持久化，启动时以 `listWorkspaces()` 校验有效性）。
- [ ] 新增 `workspaces: WorkspaceInfo[]` state + `refreshWorkspaces()`。
- [ ] `useWorkspace(notify, activeWorkspaceId)`。
- [ ] `workspaceMode` 类型扩展为 `'workspaces' | 'match' | 'grade' | 'settings'`。
- [ ] 新增 `stageView: 'grid' | 'single'` state。
- [ ] `.workspace-nav` 最左侧插入工作区组合控件（复用已 import 的 `FolderKanban`）：
      - 左段按钮「工作区」→ `setWorkspaceMode('workspaces')`，`is-active` 当处于一级页；
      - 右段箭头按钮 → 展开下拉（列出 `workspaces`），当前项打勾，选中非当前项时弹确认；
      - 下拉关闭：点外部（复用 `helpMenuRef` 的同类模式）。
- [ ] AI 追色 / AI 调色按钮加 `disabled={!canUseEditor}` + `title`（§4 准入判断）。
- [ ] 新增 `<WorkspacesPage>` 渲染分支（一级）。
- [ ] stage 内新增网格层：`stageView === 'grid'` 时覆盖预览区；双击卡片 → `selectPhoto` + `stageView = 'single'`；提供「网格 / 单图」切换按钮（放在 `.stage__toolbar`）。
- [ ] 复核 `onFocusAbsentVolumes={() => setWorkspaceMode('match')}` 等跨模式跳转。

### 5.5 `styles.css`

- [x] `.topbar` 网格：`workspace-nav` 从 `justify-self: center` 改为左对齐分组（`grid-template-columns: auto 1fr auto`）。
- [x] 新增 `.workspace-switcher`（组合控件 + 下拉）、`.workspaces-page`、`.workspace-card`、`.stage-grid`、`.stage-view-toggle`、`.text-input`、`.button--ghost` 样式。
- [x] 光照主题同步补齐上述新类名的变量覆盖（追加在文件末尾的 day-theme 区块）。
- [x] 网格模式下收掉底栏与缩略图栏（`.workspace-stage.is-grid`），把纵向空间让给网格；预览区仍保持挂载与固定尺寸。

---

## 6. 非目标（本次仍不做）

- 内容哈希去重、批量导出、批量删除、XMP sidecar 写回、Filmstrip 拖拽排序。
- 工作区间拖拽搬运素材。
- 工作区嵌套层级（只做一级 folder）。
- 未登记文件扫描与登记（见 §2.7，数据模型障碍）。
- 跨卷同名文件的撞路径修复（既存隐患，独立评估）。

---

## 7. 实施记录（2026-09-17）

### 7.1 落地范围

| 层 | 文件 | 内容 |
|----|------|------|
| Rust | `src-tauri/src/workspace.rs` | `WorkspaceInfo` / `WorkspaceRegistry`、`write_registry_atomic`、`load_registry`（剔幽灵 + 补缺失 + 以 `default` 播种）、`derive_workspace_id`、`validate_workspace_name`；4 个命令 `list/create/rename/delete_workspace` |
| Rust | `src-tauri/src/lib.rs` | `generate_handler!` 注册 4 个新命令 |
| TS | `src/lib/types.ts` | `WorkspaceInfo` 接口 |
| TS | `src/lib/desktop.ts` | 4 个 IPC 封装 + 浏览器预览注册表；**并修复单份 `browserWorkspace` 缺陷**（改为 `Map<workspaceId, manifest>`，缩略图 key 加工作区前缀） |
| TS | `src/lib/useWorkspace.ts` | 签名加 `workspaceId`；10 处调用显式传参；切区 effect（flush → 作废在途 → 清缓存 → 载入新区） |
| TS | `src/App.tsx` | `WorkspaceMode` 扩展、`stageView`、`WorkspacesPage`、工作区组合控件 + 下拉 + 确认框、准入 guard、stage 网格覆盖层 |
| CSS | `src/styles.css` | 上述新类名 + day-theme 覆盖 |

### 7.2 实施中新发现并修复的缺陷

**`seededPhotoRef` 记账键缺少工作区维度（真实串区 bug）**

- 位置：`App.tsx` 的「切图播种 develop」与「参数写回 develop」两个 effect。
- 成因：`photoId = sha1(volumeId + "|" + relativeSourcePath)`（`workspace.ts:31`）**不含工作区**，同一张源文件在任何工作区里 id 都相同。而 `seededPhotoRef` 原本只存 `photoId`，切区后若新区含同一张图，`seededPhotoRef.current === photoId` 成立 → 播种被跳过。
- 后果：新区继承上一个区的滑块值 / 风格串 / 可见性，而 manifest 才是真相源，本地状态只是镜像 → 显示出不属于该工作区的编辑状态。
- 修法：ref 改存 `${activeWorkspaceId}|${photoId}`。写回 effect 做同样的键校验，且切区瞬间 `currentIdRef` 已被清空，写入不会串到新区。

**`createEmptyManifest()` 未传 `workspaceId`（清空后写入落到 default）**

- 位置：`useWorkspace.ts::clearWorkspace`。
- 修法：改为 `createEmptyManifest(workspaceId)`。

### 7.3 验证结果

| 检查 | 命令 | 结果 |
|------|------|------|
| Rust 编译 | `cargo check --all-targets` | Finished，0 error / 0 warning |
| 类型 | `npx tsc -p tsconfig.app.json --noEmit` | exit 0 |
| 单测 | `npx vitest run` | 11 文件 / 86 用例全通过 |
| 构建 | `npm run build` | 1618 modules，`dist/` 产出正常（CSS 136.76 kB） |

### 7.4 待人工验收的行为

按 §1 的 B1–B7 在 Tauri 真机（非浏览器预览）逐条走一遍，重点：

1. **切区后缩略图是否全部换新**（缓存清理是否彻底）。
2. **在 A 区拖滑块后立刻切 B 区，回到 A 区参数是否还在**（防抖 flush 是否生效）。
3. **A/B 两区含同一张图时，切区后滑块是否回到该区自己的值**（§7.2 的修复是否到位）。
4. 预览区在网格 ↔ 单图来回切换时是否无闪屏（§2.6 的布局约束是否守住）。

---

## 8. 后续调整（2026-09-17 同轮）

### 8.1 顶栏模式标签恢复居中

**成因**：§7 改造时为了让新增的工作区控件有位置，把 `.topbar` 从 `minmax(180px,1fr) auto minmax(220px,1fr)` 改成 `auto 1fr auto` 并让 nav 左对齐——这是主动取舍，不是意外损坏。

**用户确认的决策**：三个标签以**整个窗口**为基准居中；工作区控件放在**品牌右侧、与标签分离**。

**修法**：

- `.topbar` 改回等宽双侧列 `minmax(0, 1fr) auto minmax(0, 1fr)`——这是让中间列真正居中的唯一办法；用 `auto` 会被左侧较宽内容挤偏。
- 新增 `.topbar__left` 容器（`display: flex; gap: 16px`）收纳品牌 + 工作区控件。用 `gap` 而非 `space-between`，使两者整体靠左。
- `.workspace-nav` 恢复 `justify-content: center; justify-self: center`，JSX 中只留三个模式按钮。
- `.workspace-switcher` 从「nav 内靠右边框分隔」改为**独立带边框 pill**，并为 `__label` / `__caret` 补齐完整自带样式——它们已不在 `.workspace-nav` 里，**不再继承 nav 按钮样式**。
- 断点：`≤1080px` 收窄两侧列 + 工作区名称 `max-width: 110px`；`≤840px` **显式放弃居中**（`auto minmax(0,1fr) auto` + 左对齐 + 隐藏名称文字只留图标），因为窄屏强撑等宽列会挤压标签。

### 8.2 删除左栏「工作区导入」卡片

用户指令：「左侧的工作区导入可以删掉」。确认删除范围为**整张卡片**（标题 + 按钮 + 说明），剩余卡片编号重排为 `00` / `01`。

- 删除 `.left-console__body` 中 `00 工作区导入` 的 `.rail-card`（含「导入图片（可多选）」按钮与「内部硬盘来源只引用…」说明）。
- `01 双图样本` → `00`；`02 样本分析` → `01`。
- `ImportConfirmPanel` 从 `? :` 三元改为 `? null`（它是导入流程中的确认面板，与入口无关，保留）。
- **无死代码**：`pickWorkspaceImages` 仍被 `pickSourceFromStage`（预览区空态）调用；`LoaderCircle` / `Upload` 仍有其他使用点；`.settings-card__note` / `.rail-card__meta` 的 CSS 仍被别处使用，均保留。
- **导入入口未减少**：左栏「双图样本」区选原片走 `handleFile → workspace.importSingleFile`，同样会登记进工作区；批量导入仍可从预览区空态 / 网格空态的「导入图片到工作区」进入。

**验证**：`tsc` exit 0；`vitest` 86/86；`npm run build` 成功。产物扫描确认「导入图片（可多选）」与旧说明文字已从 bundle 消失，预览区导入入口仍在。

### 8.3 去除左栏与视图区的「AI 味」

用户指令：「左侧栏和视图中间区域UI优化一下，当前的GPT味儿太重了」。确认口径：**克制减法**（保留布局结构与信息层级，只改视觉手法）+ 参照 **像素蛋糕风**（实色、更大圆角、更清晰的主次）。

改动清单：

| 手法 | 处置 |
| --- | --- |
| 斜向高光渐变 `.rail-card` / `.recipe-prompt-card` | 删 → 纯色 `var(--panel-2)`，圆角 10 → 14px |
| 左侧栏顶部青色光带 + `__head` 的 `backdrop-filter: blur` | 删 → 纯色 `var(--panel)` |
| `.status-dot.is-ready::before` / `.gpu-dot` 的发光 `box-shadow` | 删，只留 6px 圆点 |
| `.stage` 点阵网格背景 | 删 |
| `.preview-frame` 四角准星 + 重投影 | 删，边距 18 → 16px |
| `.image-drop__empty` 四角准星 | 删（同一装饰不再出现两处） |
| 装饰性编号徽章 `.rail-card__index` | CSS 全删；DOM 移除 5 处（`App.tsx` 2 + `AiColorWorkspace.tsx` 3） |
| 7/8/9px 极小字号（`.rail-progress` / `.image-drop` / `.match-pair` / `.stage*` / `.kicker`） | 统一提到 11px（标题 12px） |
| `.image-drop` 虚线边框 | 改实线（虚线是上传组件符号，与已载入容器语义不符），圆角 8 → 12px |
| 半透明底（`.stage__toolbar` / `.stage__footer` / `.left-console__foot`） | 改纯色 `var(--panel)` |

light theme 同步：`.left-console` / `__head` / `__foot` / `.rail-card` / `.rail-progress li` 去渐变与半透明。

**验证**：`tsc` exit 0；`vitest` 86/86；`npm run build` 成功（**1618 modules**，CSS 137.90 → **136.15 kB**——删掉的渐变/发光规则多于新增的字号声明）。

### 8.4 沉淀为长期约定

本轮确立两条项目级视觉约定（见 `.workbuddy/memory/MEMORY.md`）：

1. **正文最小字号 11px**；判定「AI 味」的 6 个特征（斜向渐变 / 强调色光晕 / 极小字号 / 装饰性编号 / 同装饰重复出现 / 卡片套卡片）出现即应消除。
2. **改字号按「区域作用域」而非全局搜替**——`styles.css` 有 100+ 处 7–9px，其中 `.settings-*` / `.library-*` / `.recipe-*` 属设置页与右栏，不在本轮范围。不做「顺手全局统一」。

### 8.5 文案精简：删装饰性英文标签与冗余描述

用户反馈：「存在大量 description 文本和英文标签」。口径：英文标签**删纯装饰的、保留有信息的**；描述文案**直接删**（不做悬停兜底）；中英混排标题（`XMP 预设库` / `CUBE LUT 库`）**保持现状**。

**英文标签**：删 `SOURCE` / `REFERENCE`（与图片标题重复，`eyebrow` prop 机制一并拆掉）、`BEFORE` / `AFTER`（分割线控件已表达前后）；`READY`/`WAIT` → `就绪`/`待载入`，`LOCAL` → `本地`；`AI IMAGE`/`AI LOCAL`/`MANUAL` → `AI 生成`/`AI 配方`/`手动`（携带「当前是哪一版」信息，保留）；stage 底栏读数（`PREVIEW`/`NO IMAGE`/`WEBGL2 GPU`/`GPU ERROR`/`GPU INITIALIZING`/`NO RECIPE SELECTED`）与 `canvasEngineLabel` 全改中文。行业缩写 `XMP`/`LUT`/`RAW`/`JPG`/`sRGB` 保留。

**描述文案**：删掉 9 组，含拖放区空态提示、卡片副标题（`JPG · PNG · WebP`、`本地渲染`/`云端生成`）、`.grade-privacy-note` 与 `.recipe-waiting__intro` 的副句、`.xmp-library-hint`、工作区列表页副标题、两处空态补语。

**连带孤儿 CSS**：7 条规则已无 DOM 生产者，同步删除（`.image-drop__eyebrow`、`.image-drop__meta span`、`.xmp-library-hint`、`.grade-privacy-note span`、`.recipe-waiting__intro div span`、`.method-toggle > button small`、`.stage-grid__empty p/strong`），各含其 light theme 版本。

### 8.6 左栏 UI/UX 适配工作区逻辑

用户指令：「由于当前引入了工作区逻辑，左侧的 UI、UX 也要相应调整了吧，有的元素是不需要的了」。

**关键不对称**（决定「不能一刀切」）：AI 追色有素材网格 + 缩略图栏 ⇒ 左栏「原片」是第三个选图入口；AI 调色**两者都没有** ⇒ 左栏「选择照片」是唯一换图入口，删了就断头。

| 决策 | 落地 |
| --- | --- |
| 追色「原片」改**只读回显** | `ImageDrop` 新增 `readOnly`：不挂拖拽 handler、不渲染隐藏 input、不显示更换/移除按钮，改为整层透明按钮 `.image-drop__open`（点击 `setStageView('grid')`）；`onFile`/`onPick`/`onClear` 全部改可选 |
| 调色「选择照片」保留但导入改**多选** | `onPick` 从 `pickNativeImage('source')` 改为 `pickSourceFromStage`（工作区多选），与追色一致 |
| 精简首步与无效状态 | `rail-progress` 追色 `原片/参考/分析` → `参考/分析`，调色 `照片/方式/配方` → `方式/配方`（进区即自动选中照片，首步恒为已完成）；CSS `repeat(3,…)` → `repeat(2,…)`；status-dot 追色 → `可追色/待分析`，调色 → `!source ? 待载入 : (activeRecipe‖importedPreset) ? 已应用 : 待调色` |

**顺带修正的语义错误**：

- `clearImage('source')` 实为 `workspace.deselect()`（仅取消选中），但 tooltip 硬编码「移除图片」→ 按 `accent` 分流：`source` 用「取消选中/更换图片」，`reference` 用「移除参考图/更换参考图」（后者才是真删）。
- 参考图是**工作区级共享**（`notify('参考图已设为工作区共享参考')`），但卡片「双图样本」把它摆成逐图配对 → 标签改「工作区共享」。

**验证**：`tsc` exit 0；`vitest` 86/86；`npm run build` 成功（CSS 136.17 → **135.37 kB**，JS 505.72 → **504.21 kB**）。产物扫描：新文案已进 bundle，被删文案零命中。

### 8.7 修正：点工作区不再直接跳进追色（新增工作区内容页）

用户报告：「工作区页面中，点击某一个工作区，就自动进入到追色页面了，这是错误的，应当是进入工作区内容页面，即展示工作区内的素材，而不是跳转到其他菜单下」。

**根因**：`enterWorkspace` 硬编码 `setWorkspaceMode('match')`。§3.5 当初把「素材页」实现为追色 stage 里的一层网格**覆盖层**（`stageView: 'grid'`），于是「进工作区看素材」在结构上就等于「进追色菜单」。⇒ **不是赋值写错，是层级里缺了一层**。

**用户确认的三项决策**：

| 项 | 决策 |
| --- | --- |
| 网格放哪 | **只放内容页**；追色页的「网格/单图」切换删掉（缩略图栏已能切图） |
| 点击素材 | 单击仅选中；**双击**进修图；**右键**出菜单（AI 追色 / AI 调色） |
| 工作区标签去向 | 有激活区时 → **内容页**；列表页走下拉里的「+ 新建 / 管理」 |

**落地**：

- 新增 `src/components/WorkspaceContentPage.tsx`：头部（`← 全部工作区` / 名称 + 素材数 / 清空 / 导入）+ 网格画廊 + 右键菜单。
- `WorkspaceMode` 增加 `'content'`；`enterWorkspace(id)` 只切区并落 `'content'`；新增 `openPhotoInEditor(photoId, target)` 承担「选图 + 切修图菜单」。
- `stageView` / `StageView` / `stage-view-toggle` / `.workspace-stage.is-grid` **整体删除**（含 light theme 覆盖），网格样式由 `.stage-grid*`（绝对定位覆盖层）改写为 `.content-grid*`（块级布局）。
- 顶栏新增 `isEditorMode = match || grade` 用于「帮助 / 导出」——原先判 `!== 'settings'`，会把内容页也算进去，导致内容页出现**只读导出按钮**与**错配的设置帮助文案**。

**右键菜单的坑**：关闭逻辑必须用 `contains` 判断（点菜单内部不关），否则 `pointerdown` 会在 `click` 之前把菜单卸载，表现为「右键菜单点了没反应」。

**验证**：`tsc` exit 0；`vitest` 86/86；`npm run build` 成功（**1619 modules**，CSS **135.17 kB**，JS **506.15 kB**）。产物扫描：`stage-grid`/`stage-view-toggle`/`is-grid` 零命中。

**未决**：冷启动默认模式仍是 `'match'`（localStorage 有激活区时启动即落在追色页）。这是 §3.2「冷启动恢复上次状态」的延续，若要改为落在内容页，只需改 `useState<WorkspaceMode>('match')` 的初值。

### 8.8 修复：内容页导入后素材不显示

用户报告：「在工作区明细内，导入图片未直接显示出来，逻辑似乎和我想的不一致」。

**根因（与 §8.7 同类）**：`beginImport()` 只把 `importPlan` 写进状态，真正导入要等用户在 `ImportConfirmPanel` 上确认；而该面板**只在追色左栏渲染**（`App.tsx` 唯一一处，位于 `workspaceMode === 'match'` 分支内）。内容页没有它 ⇒ 选完文件后状态已变、界面不动。**AI 调色页同模**同样渲染不了它，是同一个潜伏 bug。

**用户确认的两项决策**：

1. **内容页直接导入**——选完文件直接执行，不弹确认。
2. **只在需要决策时弹**——仅当「非内部硬盘 / 空间不足 / 有重复会被跳过」时才弹面板。

**落地**：

- `workspace.ts` 新增纯谓词 `needsImportDecision(plan)`：`blocked || duplicateCount > 0 || 有卷 driveType !== 'fixed'`。
- `useWorkspace` 抽出 `runImport(plan)`（原 `confirmImport` 主体），`confirmImport` 退化为薄封装；`beginImport(autoConfirmWhenTrivial?)` 自行 `buildImportPlan` 并据此决定「直接导入」还是「落 importPlan 等确认」。
- `ImportConfirmPanel` 从追色左栏**移到 app-shell 顶层的遮罩弹窗**（`.import-dialog`），使三个模式都能显示——这类「面板只挂在某一个模式里」的错误已犯两次，根因都是**入口分布跨模式而渲染点单一**。
- `ImportConfirmPanel` 的接口未变，故无需改动其内部实现。

**验证**：`tsc` exit 0；`vitest` **91/91**（新增 5 条 `needsImportDecision` 用例）；`npm run build` 成功（**1619 modules**，CSS **135.65 kB**，JS **506.62 kB**）。

### 8.9 性能：内容页浏览与进入追色的卡顿

用户报告：「进入追色页面很卡，需要等很久」。

**诊断出两处开销，且都在内容页发生 —— 而内容页两者都不显示，所以都是纯浪费**：

| 开销 | 机制 |
| --- | --- |
| **主线程同步冻结** | `matchPreviewData` 的依赖只有 `[source, stableMatchFrame.w/h]`，与模式无关。它对 4096px 的图做高质量 `drawImage` + `getImageData`，全程同步阻塞主线程；而消费者全在 `workspaceMode === 'match'` 分支内（655–749 三个 effect 都以 `workspaceMode !== 'match'` 提前 return） |
| **Rust 侧不可取消的完整显影** | 内容页单击素材即 `selectPhoto → currentId 变` ⇒ 每点一次跑一次 `decodeRawNative(path, 4096)`。`decode_raw_file` 是 **decode → 全量 develop → 转全尺寸 RGB8 → 最后才 resize**，`max_side` 省不掉时间；Rust 无取消 ⇒ 连点堆积、占满 CPU/磁盘，这才是「进追色要等很久」的主因 |

**用户确认的决策**：**单击只高亮，不载入**（内容页单击只改浏览态高亮，不碰 `currentId`）。

**落地**：

1. `matchPreviewData` 加 `workspaceMode !== 'match'` 门禁，依赖数组补 `workspaceMode`。
2. 高亮状态提到 `App.tsx`（`contentSelection`），内容页 props 由 `currentId` + `onSelect` 改为 `highlightId` + `onHighlight`；`enterWorkspace` 清空它。
3. 新增 `openEditorFromNav(target)`：内容页下逐级取「本次高亮 → `workspace.currentId` → `photos[0]`」，**每级都校验仍在 `photos` 中**，保证「高亮的那张 = 即将修的那张」且不会拿失效 id 去载入。

**刻意保留**：进区时那一次载入没有一并门禁掉。它是**每次进区一次**（不再每次单击一次），并且正好充当免费预载，使进入追色时通常已就绪；若一并推迟，进追色就必然要现场等一次完整显影，反而加重本症状。

**验证**：`tsc` exit 0；`vitest` **91/91**；`npm run build` 成功（**1619 modules**，CSS **135.65 kB**，JS **507.02 kB**）。

**遗留**：`decode_raw_file` 的 `max_side` 实际无效（在最后才 resize）。省时间需在**显影阶段**降分辨率，属 Rust 侧改造，本次未做。




