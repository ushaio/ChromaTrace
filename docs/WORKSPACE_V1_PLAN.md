# 工作区与缩略图栏 V1 实施计划与技术设计

> 更新日期：2026-09-15
> 平台：Windows 10/11 x64（macOS / Linux 为次要目标）
> 状态：设计已确认（逐分支推演完成），待实施

## 1. 目标

把现有的“单图修图”升级为“工作区批量修图”：

1. 在一个工作区中一次性导入多张图片，之后自由切换，不再反复选择文件；
2. 导入来源为可移动介质时，复制一份到资料库（内部硬盘）后再纳入工作区；
3. 来源为内部固定盘时，直接引用源路径，不占用额外磁盘；
4. 修图界面预览区下方提供缩略图导航栏，点击切换当前修图图片，并给出选中高亮。

**V1 非目标**（明确不做，避免范围蔓延）：工作区管理器 UI（新建 / 切换 / 重命名）、内容哈希去重、批量导出、批量删除、XMP sidecar 写回、缩略图栏拖拽排序。

**适用范围与前提**：本设计的额外磁盘占用**只发生在“可移动 / 不确定来源”这一支**，内部固定盘来源一律引用、零额外占用。即：这套复制语义是为“外部可移动磁盘可能不在位”而设的保险，不是通用的照片归集器。若日后希望把内部盘来源也纳入统一管理（例如所有照片都收进资料库目录），那是另一个需求，需要重新评估空间与迁移代价。

## 2. 已确认的关键决策

| 分支 | 决策 | 核心理由 |
| --- | --- | --- |
| 工作区实体 | 磁盘目录 + `manifest.json`，挂在现有资料库根下 | 复制策略必须有落地目录；“一次导入多次修图”隐含跨会话可恢复 |
| 工作区数量 | 单当前工作区；磁盘结构按 `workspaces/<id>/` 预留多工作区 | 避免为管理工作区写一套 UI，将来扩展不动数据 |
| manifest 粒度 | 轻 manifest + 独立 `thumbs/` 缓存目录 | RAW 缩略图必须缓存，否则冷启动退化为分钟级等待 |
| 卷判定 | Rust 侧三态判定（Removable / Fixed / Unknown），Unknown 预选“复制”，导入前确认面板可逐卷改判 | 判定粒度是挂载卷而非文件；网络盘、光盘、虚拟盘同样不可靠 |
| 副本落点 | `<资料库根>/workspaces/<id>/originals/` | 位置设置必须只有唯一真相源 |
| 副本组织 | 保留所选根目录的相对层级，重名由 `unique_relative_path` 加编号 | 复用 `asset_library.rs` 既有能力 |
| 空间策略 | 引用支路零额外占用；复制支路在导入前做剩余空间预检并显示真实目标路径 | 复制是换取“源介质缺席可用”的主动代价，必须让用户看得见、可回收、可改位置 |
| 图片身份 | 主键 = `volumeId + 卷内相对路径`，不做内容哈希 | 哈希需完整读取全部原片数据，代价远大于收益；而盘符会漂移，不能作身份 |
| 卷策略记忆 | 按 `volumeId` 记住用户对该卷的复制/引用选择，下次导入直接沿用 | 移动硬盘会被反复插拔反复导入，每次弹确认框最易招致反感 |
| 复制时机 | 立即后台复制、不阻塞 UI；每图带 `status` | 崩溃可续传；用户可立刻开始修已就绪的图 |
| 参考图作用域 | 双轨：工作区级共享为主，允许单图专属覆盖 | 共享满足“批量统一色调”，覆盖满足个别例外；代价仅一个 resolve 入口 |
| 参考图存储 | 与普通原片走同一导入管线；`ColorStats` 持久化进 manifest | 否则“源介质缺席仍可打开”的不变量会从参考图侧门漏掉 |
| 内存管线 | 三级：缩略图 256px 落盘 / 分析图 1200px LRU / 全解析图仅当前 | `LoadedImage` 若继续作为列表项类型，200 张 45MP 必然 OOM |
| 批量能力 | 缩略图栏支持多选，唯一批量动作为“套用当前配方到所选” | 没有批量套用，工作区只省掉导入的重复劳动 |

## 3. 数据模型

### 3.1 磁盘布局

```
<libraryRoot>/                     # 现有 library_root（library-location.json 可配置）
  xmp/                             # 现有预设资料库
  cube/                            # 现有 LUT 资料库
  workspaces/
    default/                       # V1 唯一的当前工作区
      manifest.json
      manifest.json.tmp            # 原子替换用
      originals/                   # origin == copy 的图片副本（保留源相对层级）
        2024/Wedding/IMG_0001.CR3
      references/                  # 参考图副本
      thumbs/<thumbKey>.jpg        # 缩略图缓存；整体删除可无损重建
```

选择此布局的连带后果：`migrate_library_location` 会连带搬运工作区副本，因此迁移确认框必须显示待搬总大小（扫描阶段已统计 `total_bytes`，直接暴露即可）。

### 3.2 manifest schema

```jsonc
{
  "version": 1,
  "id": "default",
  "createdAt": 1757900000000,
  "updatedAt": 1757900000000,
  "revision": 12,                       // 每次保存自增，用于乐观并发校验
  "reference": {                        // 工作区级参考图
    "id": "ref_1",
    "origin": "copy",                   // copy | reference
    "volumeId": "1A2B-3C4D",
    "relativeSourcePath": "refs/look.jpg",
    "sourcePath": "E:/refs/look.jpg",   // 仅用于展示与重新定位，不作身份依据
    "workspacePath": "references/look.jpg",
    "status": "ready",
    "stats": { /* ColorStats */ }
  },
  "photos": [
    {
      "id": "a3f5…",                          // sha1(volumeId + "|" + relativeSourcePath)
      "volumeId": "1A2B-3C4D",                // 卷序列号 / 卷 UUID，见 4.1
      "relativeSourcePath": "2024/Wedding/IMG_0001.CR3",   // 卷内相对路径
      "sourcePath": "E:/2024/Wedding/IMG_0001.CR3",        // 仅用于展示与重新定位
      "origin": "copy",                        // copy | reference
      "workspacePath": "originals/2024/Wedding/IMG_0001.CR3",
      "status": "ready",                       // pending | copying | ready | failed | missing
      "sizeBytes": 48392064,
      "mtimeMs": 1710000000000,
      "isRaw": true,
      "width": 6000,
      "height": 4000,
      "thumbKey": "9f2c…",                     // sha1(volumeId|relativeSourcePath|size|mtime|maxSide)
      "stats": { /* ColorStats，导入时算好落盘 */ },
      "referenceOverride": null,               // P2：单图专属参考
      "develop": {
        "adjustments": { /* Adjustments */ },
        "fineTuneVisibility": { /* … */ },
        "matchRenderMode": "ai",               // none | local | ai
        "modelStyle": "青橙电影感"
      },
      "editedAt": 1757900000000
    }
  ]
}
```

**身份用「卷标识 + 卷内相对路径」，而不是盘符。** 这是刻意的选择，因为外接设备的盘符会漂移：同一块移动硬盘今天是 `E:\`、明天插上变成 `F:\`。若以盘符路径为身份，会同时踩三个坑——重复导入检测失效（同一张图被当成新图再导一遍、白占一份空间）、缩略图缓存全部失效重建、`reference` 模式条目集体变 `missing`。卷序列号/UUID 是稳定标识，盘符只是它当前的一次投影。

### 3.3 图片状态机

```
pending ──▶ copying ──▶ ready ──▶ missing（源被删/被移，仅 reference 模式可能出现）
                 └────▶ failed（复制失败，可重试）
```

- `copy` 模式：`workspacePath` 指向工作区副本，源介质缺席不影响 `ready`。
- `reference` 模式：实际读取路径 = `resolve_volume_mount(volumeId)` + `relativeSourcePath`。打开工作区时若卷未挂载（或路径不可达），标记 `missing`，缩略图显示断链角标并提供“重新定位”。**注意：卷未挂载 ≠ 图片丢了**，提示文案要区分“请插入该设备”和“文件已被删除”。
- 由此得到一条**必须守住的不变量**：`ready` 且 `origin == copy` 的图片，其 `workspacePath` 必须始终可读。任何删除/迁移逻辑都要先检查这一点。

## 4. 导入流程

### 4.1 卷判定（Rust）

新增命令：

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceVolume {
    pub root_path: String,          // "E:\\" 或 "/Volumes/Photos"
    pub volume_id: String,          // 卷序列号 / 卷 UUID —— 稳定身份
    pub label: String,              // 卷标，如 "MyPassport"
    pub drive_type: String,         // removable | fixed | remote | cdrom | ramdisk | unknown
    pub recommendation: String,     // copy | reference
    pub remembered_policy: Option<String>,   // 用户上次对该卷的选择（见 4.2）
    pub file_count: u32,
    pub total_bytes: u64,
}

#[tauri::command]
pub fn classify_source_volumes(paths: Vec<String>) -> Result<Vec<SourceVolume>, String>;

/// 卷标识 → 当前挂载点。用于解析 reference 模式的真实读取路径。
#[tauri::command]
pub fn resolve_volume_mount(volume_id: String) -> Result<Option<String>, String>;
```

判定实现：

- Windows：`GetDriveTypeW` —— `DRIVE_REMOVABLE(2)` → `copy`；`DRIVE_FIXED(3)` → `reference`；`DRIVE_REMOTE(4)` / `DRIVE_CDROM(5)` / `DRIVE_RAMDISK(6)` / 其他 → `copy`（归为 Unknown，预选复制）。卷标识取 `GetVolumeInformationW` 的卷序列号。需在 `Cargo.toml` 的 `[target.'cfg(target_os = "windows")'.dependencies]` 增加 `windows` crate（当前无此依赖）。
- macOS：`diskutil info -plist <mount>`，读 `Internal` / `RemovableMedia` / `VolumeUUID`。
- Linux：读 `/sys/block/<dev>/removable`（`1` → removable），卷标识取 `/dev/disk/by-uuid` 对应项。
- 兜底：无法判定时返回 `unknown` + `copy`；卷标识取不到时回落为「挂载点路径」，此时盘符漂移问题无法免疫，需在日志中记录。

**判定必须在 Rust 侧完成**，前端只消费三态结论。一旦把盘符字母判断写进 TS，就再也跨不了平台。

### 4.2 导入确认面板

按卷分组展示，逐卷可改判：

```
检测到 2 个来源
  E:\  可移动设备   · 186 张 ·  8.6 GB   → 复制到资料库  [改为直接引用]
  D:\  内部硬盘     ·  14 张 ·  2.1 GB   → 直接引用      [改为复制]

将复制 8.6 GB 到：<资料库根>/workspaces/default/originals/   [打开文件夹]
该位置所在盘剩余 82.4 GB ✓                      合计需额外占用 8.6 GB
```

- `Unknown` 预选“复制”，但明确允许改成“引用”，并在文案中说明风险（源介质移除后该图不可用）。
- 面板同时承担“重复导入去重”的提示：已存在同 `volumeId + relativeSourcePath` 的图片标注“已在工作区，将跳过”。
- **必须显示真实目标路径并提供“打开文件夹”入口**：副本会落到应用数据目录（默认 `%APPDATA%`，但可由「设置 → 资料库」改到任意内部盘）。用户对“我的照片躺在哪”有强烈主权意识，把路径显示出来、让位置可配置，是这一设计能否被接受的关键。
- **磁盘剩余空间预检（必须做）**：显示复制目标盘的实际剩余容量与所需空间。不足时阻止导入，并给出两条出路：把对应卷改为“直接引用”，或先去「设置 → 资料库」更换到容量更大的位置。不要用“剩余百分比”之类的软阈值，按实际字节数判断。
- **卷策略记忆（避免每次导入都被追问）**：用户对某个卷的选择按 `volumeId` 记入 settings（`volumePolicyV1: { "<volumeId>": "copy" | "reference" }`）。同一块盘下次导入时直接沿用，面板折叠为一行摘要（“MyPassport · 按上次选择：复制 · [更改]”）。**按卷标识记忆而非盘符**，否则换一次盘符就要重问一次。需求方明确“针对可移动磁盘”的约束时，这条尤其重要——用户的移动硬盘会被反复插拔、反复导入，每次都弹确认框是最容易招致反感的设计。
- 提供「重置所有卷的记忆」入口，放在「设置 → 资料库」下，与位置设置同处一地。

**空间代价的说明口径**：复制必然产生第二份数据，这是**为“源介质缺席时工作区仍可用”主动支付的代价**，不是实现缺陷。因此：

- 内部盘来源不复制，零额外占用；
- 可移动来源的副本与工作区生命周期绑定——「清空工作区」即回收全部副本空间；
- 若用户认为空间代价过高，导入面板应显式提供“仅复制进入修图的图片”（按需复制）这一降级选项，见第 11 节未决项。

### 4.3 复制与引用

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportEntry {
    pub source_path: String,       // 当前绝对路径，用于实际读取
    pub volume_id: String,         // 卷标识，写入 manifest 作身份组成
    pub relative_source_path: String,   // 卷内相对路径，如 "2024/Wedding/IMG_0001.CR3"
    pub target_relative: String,   // 副本在工作区内的相对路径（保留源相对层级）
    pub origin: String,            // copy | reference
}

#[tauri::command]
pub async fn import_workspace_files(
    app: AppHandle,
    workspace_id: String,
    entries: Vec<WorkspaceImportEntry>,
    job_id: String,
) -> Result<WorkspaceImportReport, String>;

#[tauri::command]
pub fn cancel_workspace_import(app: AppHandle, job_id: String) -> Result<(), String>;
```

- 复用 `asset_library.rs` 的 `normalize_relative_path` / `unique_relative_path`（需改为 `pub(crate)` 或抽到 `lib.rs` 公共模块），深度沿用 `MAX_FOLDER_DEPTH = 8`。
- 复制逐文件流式进行（1MB 缓冲 + `sync_all`），沿用 `migrate_library_blocking` 里 `copy_file_with_progress` 的写法。
- 进度事件 `workspace-import-progress`，结构对齐现有 `library-migration-progress`（`phase` / `copiedBytes` / `totalBytes` / `copiedFiles` / `totalFiles` / `percent` / `currentFile`），前端复用同一套展示组件形态。
- 每完成一张，立即把该条目的 `status` 置为 `ready` 并写入 manifest（**逐条落盘，而非整批结束才写**）——这正是崩溃可续传的前提。
- 取消语义：停止后续条目，已复制完成的保留为 `ready`，正在复制的条目清理半成品文件并回到 `pending`。不做整批回滚（用户已完成的部分不应被回滚）。

### 4.4 崩溃恢复

启动或打开工作区时扫描 manifest：

- 存在 `pending` / `copying` 条目 → 提示“上次导入未完成，是否继续”，继续时跳过已就绪条目。
- `copy` 模式但 `workspacePath` 不存在 → 视为半成品，回到 `pending` 重新复制。
- 目标文件已存在但大小与 `sizeBytes` 不一致 → 同样回到 `pending`（避免写入中断产生的截断文件被当作完成）。

### 4.5 改判警告与卷缺席提示

这两件事都涉及“用户自己造成、应用无法替他兜住”的状态，提示策略必须克制，否则会退化成用户直接无视的噪音。

**改判警告（只在改判那一刻，一次）**：用户在导入面板把某个卷从“复制”改为“引用”时，弹一次明确警告，内容包含三件事——该卷当前图片数量、后果（该设备不在位时这些图片将不可编辑与导出）、以及“这个选择会被记住，下次不再询问”。**此后不再重复提示**；用户若要撤销，入口在「设置 → 资料库 → 卷记忆」里，可单独清除某卷记忆。

**卷缺席汇总提示（只报一次，不逐张弹窗）**：工作区打开时若某卷未挂载，**不逐张弹窗**，而是在预览区上方出现一条可关闭的汇总条：

```
设备 MyPassport（E:）未连接 · 37 张图片暂不可用   [改为复制]  [重新定位]  [忽略]
```

- 受影响的图片在缩略图栏显示断链角标，点击时聚焦到该汇总条而不是弹对话框；
- 「改为复制」允许把该卷的 `reference` 条目批量转为 `copy`（此时设备不在位，提示“请先连接设备”）；
- 「重新定位」用于源文件被移动、卷标识无法匹配的兜底场景；
- 汇总条按卷聚合，**一个卷一条**，不因图片数量膨胀。

**判定“卷未挂载”与“文件已删除”必须分开**：前者提示“请连接设备”，后者提示“文件已被删除”。两者都归入 `missing` 状态但文案不同——把“盘没插”说成“文件没了”会直接摧毁用户对应用的信任。

## 5. 缩略图与分析管线

### 5.1 三级管线

| 层级 | 尺寸 | 生命周期 | 用途 |
| --- | --- | --- | --- |
| 缩略图 | 约 256px，JPEG | 落盘 `thumbs/`，按需重建 | 缩略图导航栏 |
| 分析图 | 1200px（`ANALYSIS_MAX_SIDE`） | 内存 LRU，3~5 张 | 直方图、诊断面板、本地匹配 |
| 全解析图 | 原尺寸 | 仅当前一张，切图即释放 | 预览、导出 |

### 5.2 RAW 内嵌预览快路径（关键）

现状问题：`raw_decode.rs::decode_raw_file` 无论请求多大尺寸，都会执行完整 demosaic + develop，把 45MP RAW 展开为 f32 `Intermediate` 再转 RGB8（约 135MB 的 `Vec`），最后才 resize。**一张 256px 缩略图的代价与一张 4000px 预览完全相同。** 200 张 RAW = 200 次全解码，工作区方案将不可用。

解法：rawler 0.6.0 已暴露内嵌预览接口（`rawler-0.6.0/src/decoders/mod.rs`）：

```rust
pub trait Decoder: Send {
    fn thumbnail_image(&self, file: &mut RawFile) -> Result<Option<DynamicImage>>;
    fn preview_image(&self, file: &mut RawFile)   -> Result<Option<DynamicImage>>;
}
// RawLoader::get_decoder(&mut RawFile) 与 RawFile::new(path, reader) 均为 pub
```

新增命令：

```rust
/// RAW 缩略图：优先取相机内嵌预览，失败回落到完整解码。
#[tauri::command]
pub fn decode_raw_thumbnail(path: String, max_side: u32) -> Result<Vec<u8>, String> {
    // 1. File::open + BufReader → RawFile::new(path, reader)
    // 2. RawLoader::new().get_decoder(&mut rawfile)?.thumbnail_image(&mut rawfile)
    // 3. 取 img.to_rgb8().into_raw() -> Vec<u8> 与尺寸（仅用字节，不耦合 rawler 私有的 image 版本）
    // 4. 用本项目 image 0.25 的 JpegEncoder 按 max_side 缩放后编码
    // 5. None 时回落到 decode_raw_file(path, 512)
}
```

注意 `thumbnail_image` 的默认实现会 `warn!` 并返回 `None`（需回落），部分解码器（如 dng / arw）已实现该接口。**必须先确认目标机型 RAW 的命中率**，见第 10 节验收项。

### 5.3 缓存键与失效

`thumbKey = sha1(f"{volumeId}|{relativeSourcePath}|{sizeBytes}|{mtimeMs}|{maxSide}")`。

使用卷标识而非绝对路径，使同一块盘换盘符后缩略图缓存依然命中（否则整栏缩略图会被无谓地重建一遍）。

- 命中 → 直接读 `thumbs/<key>.jpg`，不触碰源文件。
- 未命中 → 生成并写入，不做旧文件清理（V1 允许缓存冗余，提供“清空缩略图缓存”入口即可整体删除重建）。
- 失效判断不需要额外状态：源文件被替换或修改，`size/mtime` 变化必然导致 key 变化。

读取方式：沿用现有 `read_binary_file` IPC 模式（`readNativeFile` → `Uint8Array` → `Blob` → `objectURL`），**不启用 `assetProtocol`**——当前 `tauri.conf.json` 未配置 `assetProtocol` 的 enable/scope，而资料库根目录用户可任意指定，配置 scope 会引入与位置设置同步的额外复杂度。256px JPEG 约 15~25KB/张，200 张约 4MB，按需懒加载可接受。若后续成为瓶颈，再评估启用 `assetProtocol` + `convertFileSrc`。

## 6. 前端架构改造

### 6.1 状态归属迁移

当前 `App.tsx` 中为全局单份的状态（`source` / `reference` / `sourceData` / `sourceStats` / `referenceStats` / `adjustments` / `fineTuneVisibility` / `matchRenderMode` / `modelStyle`），在工作区模型下必须迁移归属：

| 状态 | 新归属 |
| --- | --- |
| `reference` / `referenceStats` | 工作区级（`manifest.reference`） |
| `adjustments` / `fineTuneVisibility` / `matchRenderMode` / `modelStyle` | 每图（`photo.develop`） |
| `source` / `sourceData` | 派生值：由“当前选中图片 id”+ 分析图 LRU 计算得出 |

关键点：**不存在“切图时提交参数”这一步。** 调整参数时直接写回 `photos[currentId].develop`，单一真相源，切换图片只是改 `currentId`。这样也顺带消除了“忘记保存就切图”的丢失风险。

`LoadedImage`（`src/lib/files.ts`）语义降级：从“列表项类型”变为“当前图类型”，列表项改用新的 `WorkspacePhoto` 类型（仅含 `id / sourcePath / thumbUrl / status / stats / develop`）。

### 6.2 `effectiveReference` 解析

```ts
const effectiveReference = (photo: WorkspacePhoto, ws: Workspace): ReferenceEntry =>
  photo.referenceOverride ?? ws.reference
```

预览、导出、AI 追色、AI 二次校正四条路径全部穿过该入口，避免分支散落。

### 6.3 分析图 LRU

简单的 Map + 访问序：`Map<photoId, ImageData>`，容量 5，插入前淘汰最久未访问项；`photoId` 不在缓存时异步 `imageToImageData(element, ANALYSIS_MAX_SIDE)` 并插入。全解析图（`HTMLImageElement` + `objectURL`）在 `currentId` 变化时对旧值 `revokeObjectURL` 并置空。

## 7. 缩略图导航栏 UI 规格

**布局约束（重要）**：预览框尺寸由 `useElementSize` 观测，且 `matchPreviewData` 内含全图 `drawImage` + `getImageData`，随后牵动 GPU 纹理上传。**缩略图栏必须固定高度、不参与布局动画**，作为 stage 网格的独立一行（建议 96px：72px 图片 + 上下内边距），使 `matchFrameSize` 只在窗口尺寸变化时改变。禁止悬停展开、禁止可拖拽调高。

| 项 | 规格 |
| --- | --- |
| 位置 | `.stage` 网格内、预览框下方、`stage__footer` 之上 |
| 结构 | `role="tablist"` + 每项 `role="tab"` / `aria-selected`，与现有 `panel-tabs` 写法一致 |
| 选中高亮 | `is-active` 类：2px accent 描边 + 轻微上浮；`aria-selected="true"` |
| 图片 | `object-fit: cover`，固定 72×72，圆角 |
| 角标 | 左上：RAW；右上：`status`（复制中 / 失败 / 断链）；左下：已修（`editedAt` 存在）；右下：专属参考（P2） |
| 滚动 | `overflow-x: auto`；选中变化时 `scrollIntoView({ inline: 'nearest', block: 'nearest' })`，不自算 `scrollLeft` |
| 键盘 | 容器可聚焦，`←` / `→` 切换，`Home` / `End` 跳首尾；`Ctrl/Shift + 点击` 多选 |
| 虚拟化 | 一屏内渲染可见项 ±20 个（简单窗口化即可，不引入虚拟列表依赖） |
| 空态 | 无图片时不占用高度（`display: none`），避免空条带 |
| 卷缺席提示 | 预览区上方聚合条，一个卷一条（见 4.5）；**禁止逐张弹窗** |
| 工具区 | 右侧固定两个动作：「套用到所选」（需多选且当前图已有配方）、「清空工作区」（删除 manifest 条目 **并删除 `originals/` 与 `references/` 下的副本**，二次确认文案中显示可回收的空间大小；`thumbs/` 一并清理） |

## 8. 代码改动清单

**Rust（`src-tauri/`）**

| 文件 | 改动 |
| --- | --- |
| `Cargo.toml` | `[target.'cfg(windows)'.dependencies]` 增加 `windows` crate（`Win32_Storage_FileSystem`） |
| `src/workspace.rs` | **新增**：manifest 读写（含 `revision` 乐观并发与 `.tmp` 原子替换）、`classify_source_volumes`、`resolve_volume_mount`、卷策略记忆读写、`import_workspace_files`、`cancel_workspace_import`、缩略图缓存读写 |
| `src/raw_decode.rs` | **新增** `decode_raw_thumbnail`（内嵌预览快路径 + 回落） |
| `src/asset_library.rs` | `normalize_relative_path` / `unique_relative_path` / `sanitize_segment` 提升可见性供 workspace 复用；`LibraryLocation` 逻辑（含自定义位置）复用 |
| `src/lib.rs` | 注册新命令；`mod workspace;` |

**前端（`src/`）**

| 文件 | 改动 |
| --- | --- |
| `lib/types.ts` | 新增 `WorkspacePhoto` / `WorkspaceManifest` / `ReferenceEntry` / `SourceVolume` / `ImportEntry` |
| `lib/desktop.ts` | `pickImagePath()` 增加 `multiple: true` 变体；新增 workspace / 卷判定（含 `resolve_volume_mount`）/ 导入进度 / 缩略图 / 卷策略记忆 命令封装 |
| `lib/workspace.ts` | **新增**：工作区加载、导入前确认数据组装、`effectiveReference`、批量套用配方 |
| `lib/thumbnails.ts` | **新增**：`thumbKey` 计算、缓存读取、`createImageBitmap` 缩放 + 落盘、并发闸门（2~4） |
| `lib/files.ts` | `LoadedImage` 语义降级；新增 `loadImageThumbnail` |
| `App.tsx` | 全局单份图像状态迁移为工作区 store；`reference` 提升为工作区属性；预览/导出改走 `effectiveReference` |
| `components/Filmstrip.tsx` | **新增**：缩略图导航栏（含卷缺席断链角标的点击聚焦行为） |
| `components/VolumeBanner.tsx` | **新增**：卷缺席汇总条（按卷聚合，见 4.5） |
| `components/LibrarySettingsPanel.tsx` | 增加「卷记忆」区块：列出已记住的卷（卷标 + 标识 + 当前策略 + 清除按钮） |
| `components/AiColorWorkspace.tsx` | 接收项改为“当前图片项”，跟随 `currentId` |
| `styles.css` | 缩略图栏样式（固定高度、选中态、角标、滚动条） |

## 9. 分阶段实施

**P0｜数据地基（不可跳过的地基，无 UI 产出）**

1. `windows` crate 依赖 + `classify_source_volumes`（含三平台分支、卷标识提取）+ `resolve_volume_mount` + 卷策略记忆
2. `workspace.rs`：manifest schema、原子写入、`revision` 校验
3. 导入管线：复制 / 引用、逐条落盘、进度事件、取消
4. `decode_raw_thumbnail` 快路径 + `thumbs/` 缓存读写
5. 前端：`lib/workspace.ts`、`lib/thumbnails.ts`、`desktop.ts` 命令封装

**P1｜可见能力**

6. `App.tsx` 状态迁移（`reference` 升为工作区级，develop 参数下沉到每图）
7. `Filmstrip.tsx` + 样式：单选切换、选中高亮、角标、键盘、懒加载
8. 导入确认面板（按卷分组、可改判、重复项提示、剩余空间预检、卷策略记忆）
9. 改判警告 + 卷缺席汇总条 + 「设置 → 资料库 → 卷记忆」管理入口

**P2｜批量与例外**

10. 多选 + “套用当前配方到所选”
11. 单图专属参考覆盖（`referenceOverride`）+ 角标 + “恢复共享参考”

## 10. 测试与验收

**单元测试（Vitest）**

- `thumbKey` 对 `mtime` / `size` / `maxSide` 变化敏感，对路径大小写归一。
- `effectiveReference`：有覆盖取值、无覆盖回落、工作区无参考图时返回 `null`。
- manifest 读取：`revision` 冲突时拒绝覆盖；截断/缺字段时降级而非抛错。

**Rust 测试（`cargo test`）**

- 卷判定：对固定路径返回 `fixed`，无法判定路径返回 `unknown` + `copy`。
- 导入：`copy` 模式复制后 `workspacePath` 存在且大小一致；`reference` 模式不产生副本。
- 崩溃恢复：`copying` 状态且无目标文件 → 回到 `pending`；目标文件大小不符 → 回到 `pending`。

**人工验收（关键项）**

1. 从移动硬盘导入 50 张混合 JPG + RAW：确认全程不阻塞 UI，缩略图逐张出现，已就绪项可立即进入修图。
2. **RAW 缩略图命中率**：抽查本项目目标机型 RAW，确认 `thumbnail_image` 命中而非回落全解码；记录单张耗时（目标 < 200ms）。
3. 内部盘导入：确认零副本产生，`origin == "reference"`，磁盘占用无增长。
4. 复制进行中强杀应用，重启后确认可续传且无截断文件被误判为完成。
5. 切换 20 张图，观察工作集内存（目标：稳定在数百 MB 量级，不随浏览张数线性增长）。
6. 缩略图栏出现/滚动/窗口缩放时，确认预览不重算（可用性能面板观察 `drawImage` / `getImageData` 调用次数）。
7. 参考图位于移动硬盘时，拔盘后确认工作区仍可打开，且该错误被定位到缩略图角标与提示，而非整页崩溃。
8. 空间预检：把资料库位置指向一个剩余空间不足的盘，确认导入被阻止且给出“改为直接引用 / 更换位置”两条出路，而不是复制到一半才失败。
9. 回收闭环：导入后执行「清空工作区」，确认 `originals/`、`references/`、`thumbs/` 被清理且确认框显示的可回收空间与实际释放量一致。
10. 盘符漂移：把同一块移动硬盘从 `E:\` 改挂到 `F:\`（或换 USB 口重新分配盘符），重新导入同批图片，确认全部被识别为“已在工作区”而非重复导入，且缩略图缓存全部命中、`reference` 模式条目未变 `missing`。
11. 卷策略记忆：对同一块盘连续导入两次，确认第二次不再弹完整确认面板而是折叠摘要；点「更改」仍可改判。
12. 改判警告只出现一次：把某卷改为“引用”并确认，第二次改判同一卷时确认框不再出现警告文案之外的重复提示；「设置 → 资料库 → 卷记忆」可单独清除该卷记忆。
13. 卷缺席提示是汇总而非刷屏：拔掉移动硬盘后打开工作区，确认只出现一条聚合提示条（按卷），缩略图显示断链角标，且文案是“请连接设备”而不是“文件已被删除”。

## 11. 风险与未决项

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| rawler `thumbnail_image` 对部分机型返回 `None` | RAW 缩略图回落全解码，导入变慢 | 先做机型命中率验证；必要时改为并发全解码 + 进度可见 |
| 迁移资料库时携带数 GB~数十 GB 副本 | 用户长时间等待 | 迁移确认框显示总大小；文案说明工作区副本会一并迁移 |
| 副本占用内部盘空间（默认为系统盘 `%APPDATA%`） | 用户系统盘被吃掉数 GB 至数十 GB，可能引发强烈不满 | 导入确认面板显示目标盘剩余空间并做预检；资料库位置可改到大容量数据盘；提供“按需复制”降级选项与「清空工作区」回收入口 |
| `App.tsx` 已 1200 行，状态迁移会进一步膨胀 | 维护成本 | 迁移时同步抽出 `useWorkspace` hook，避免继续堆在组件内 |
| `reference` 模式依赖外部源路径 | 源被移动/删除后图片缺失 | `missing` 状态 + 重新定位入口；导入确认面板明确提示风险 |
| 外接设备盘符漂移（`E:\` → `F:\`） | 重复导入、缓存失效、引用条目集体 `missing` | 身份与缓存键一律用 `volumeId + 卷内相对路径`；读取前经 `resolve_volume_mount` 解析当前挂载点 |
| 卷标识取不到（部分虚拟盘 / 网络挂载） | 上述防护失效 | 回落到挂载点路径作为标识并写日志；此类来源本就预选“复制”，影响面可控 |
| manifest 频繁逐条落盘 | 写入放大（尤其 SSD） | 逐条写入仅限导入期间；日常参数调整用 300~500ms 防抖合并写入 |

**未决项（需在 P0 结束时定）**

- **是否默认“按需复制”（可选优化，非阻塞）**：仅当后续真实用户反馈“空间占用过大”时才考虑。做法是导入时只登记全部条目并生成缩略图（约 20KB/张），仅当用户首次选中某张进入修图时才复制其原件（RAW 约 45MB/张），空间占用即从“导入 200 张即约 9 GB”变为按实际修图张数线性增长，代价是每次首修多一次等待。
- 若启用“按需复制”，状态机需新增 `deferred`（已登记、未复制）。此时必须明确：卷不在位时选中该图应**明确失败并提示插设备**，**不允许**用缩略图冒充全图参与调色预览——那会把“预览精度”污染成随状态漂移的变量，代价远大于收益。
- 缩略图栏横向滚动是否支持鼠标滚轮直接横向滚动（当前考虑需 Shift 或仅触控板）。
- 导入确认面板是模态对话框还是左栏内联区块（倾向内联，与现有 `left-console` 风格一致）。
- 工作区上限建议值（例如 500 张），超过后是否切换到“分页导入”策略。

## 12. 设计收口

本设计把「单图修图」升级为「工作区批量修图」，核心是三条互相咬合的机制：**工作区落盘为 `<资料库根>/workspaces/<id>/` 目录 + 轻量 `manifest.json`**（图片身份用 `volumeId + 卷内相对路径`，缩略图以同源键缓存到 `thumbs/`，使得重启、换盘符都不丢状态）；**导入时按挂载卷做三态判定**（可移动与不确定来源复制到 `originals/` 并保留源相对层级，内部固定盘只引用），复制立即在后台进行、每图带 `status` 逐条落盘，因此不阻塞 UI 且崩溃可续传；**参考图升为工作区级属性并允许单图覆盖**，每张图独立持有 `develop` 参数，配合三级内存管线（缩略图落盘 / 分析图 LRU / 全解析图仅当前）避免多图常驻导致 OOM。缩略图导航栏固定高度置于预览区下方，点击切换、`aria-selected` 高亮、多选后可用唯一批量动作「套用当前配方到所选」。整个链路最关键的两个技术前提是：RAW 缩略图必须走 rawler 的内嵌预览快路径（否则成本等同全尺寸解码），以及缩略图栏绝不能参与布局动画（否则会反复触发预览框的像素级重算）。

**一句话判据**：这套复制语义是“外部可移动磁盘可能不在位”的保险，不是通用的照片归集器——内部盘来源零额外占用，可移动来源的副本与工作区生命周期绑定、可整体回收。
