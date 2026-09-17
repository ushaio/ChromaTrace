# 数据存储规范

> 本项目的持久化方式与约定。

---

## 概述

**本项目没有数据库。** Rust crate 里没有接任何 SQL 引擎、ORM、迁移框架或嵌入式 KV 存储。如果某个任务需要关系型存储，那是一次架构变更，必须显式决策——**不要顺手引入**。

这个文件之所以存在，是因为 Trellis 的后端模板会生成它。这里保留为一份**范围说明 + 状态实际存放位置的地图**——对任何想找「数据库在哪」的人来说，这才是有用的部分。

---

## 状态实际存在哪里

| 状态 | 存放位置 | 归属模块 |
|------|----------|----------|
| API Key | 系统凭据库（Windows Credential Manager / macOS Keychain） | `credentials.rs` |
| 资产库根目录位置 | 应用数据目录下的 `library-location.json` | `asset_library.rs` |
| 资产库内容（文件、文件夹） | 库根目录下真实的目录与文件 | `asset_library.rs` |
| 非敏感设置（Base URL、模型 ID、超时） | Tauri Store（JSON） | 前端 + `tauri_plugin_store` |
| 迁移进度 | 内存事件流（`library-migration-progress`） | `asset_library.rs` |
| 工作区（图片列表 + 每图调色参数 + 共享参考图） | `<库根>/workspaces/<id>/manifest.json` | `workspace.rs` |
| 工作区副本 | `<库根>/workspaces/<id>/originals/`（保留源相对层级）、`references/`（参考图） | `workspace.rs` |
| 缩略图缓存 | `<库根>/workspaces/<id>/thumbs/<thumbKey>.jpg` | `workspace.rs` |
| 卷的复制 / 引用记忆 | `<库根>/volume-policy-v1.json` | `workspace.rs` |
| 导入进度 | 内存事件流（`workspace-import-progress`） | `workspace.rs` |

几个值得知道的后果：

- **没有事务。** 多步文件操作（比如整树拷贝的目录迁移）**不是原子**的。中途中断，磁盘上就是「最后一个完成的步骤」留下的状态。
- **没有 schema 版本化。** 任何新增的持久化 JSON 结构，都要自己处理向前 / 向后兼容。
- **路径安全是手写的**，不靠查询层兜底——见 `asset_library.rs` 里的 `normalize_relative_path` / `unique_relative_path` / `sanitize_segment` / `path_is_within`，以及 `MAX_FOLDER_DEPTH`。

### 工作区（`workspace.rs`）的持久化约定

- **manifest 用 `.tmp` + rename 原子替换**，并带 `revision`：每次保存自增，写入时校验调用方传入的 `expectedRevision`，不一致就拒绝覆盖。这是本项目唯一的乐观并发控制。
- **逐条落盘而非整批落盘**：导入时每完成一张图片就把该条目的 `status` 置 `ready` 并存一次 manifest —— 这是「复制中途崩溃可续传」的前提，也是唯一允许的高频写盘场景。日常参数调整走 400ms 防抖合并（前端 `queueManifest`）。
- **`copy` 条目的 `status` 由磁盘事实决定，不接受前端声明**：载入时 `recover_manifest` 会检查副本存在且大小与 `sizeBytes` 一致，否则把 `ready`/`copying` 降回 `pending`。写入前也会重跑一次该检查，因此**截断的半成品文件永远不会被当作已完成**。
- **图片身份 = `sha1(volumeId + "|" + 卷内相对路径)`，缩略图键 = `sha1(volumeId|小写化的卷内相对路径|sizeBytes|mtimeMs|maxSide)`。** 刻意不用盘符（移动硬盘换 USB 口后盘符会漂移，用盘符会让重复导入检测失效、缩略图缓存整片重建、引用条目集体变 `missing`），也不用内容哈希（要完整读取全部原片，代价远大于收益）。
- **两种参考图语义**：`copy` 读工作区副本（源介质缺席仍可用），`reference` 读 `resolve_volume_mount(volumeId)` 解析出的当前挂载点。**判定「卷未挂载」与「文件已删除」必须分开**——前者提示「请连接设备」，后者提示「文件已被删除」。
- 参考图与普通原片走**同一条导入管线**（否则「源介质缺席仍可打开」的不变量会从参考图侧门漏掉）。
- 卷记忆文件兼容两种形态：裸字符串（`"copy"`）与记录对象（`{"policy":"copy","label":"MyPassport","updatedAt":...}`）。改结构时必须保留旧形态的读取路径，否则用户既有的设备记忆会在升级后整体丢失。


---

## 查询模式

不适用。

---

## 迁移

本代码库里唯一的「迁移」概念是**资产库位置迁移**（用户可见的功能：把库根目录搬到另一个盘），实现在 `asset_library.rs`。它要求目标目录为空、搬迁整棵树、并发出进度事件。**它不是 schema 迁移。**

---

## 命名约定

不适用。真正适用的命名规则（相对路径归一化、路径片段清洗）见 [目录结构](./directory-structure.md)。

---

## 常见错误

- 因为模板问了「数据库」就假设项目里有数据库。
- 把资产库的文件搬迁当成事务性操作。
- 新增一个持久化 JSON 文件却不先决定它的版本 / 兼容策略。
- 把「卷未挂载」当成「文件已删除」上报给用户——这会直接摧毁用户对应用的信任。
- 用盘符（`E:\`）当图片身份或缓存键的一部分。
- 在工作区导入过程中用整批 manifest 覆盖代替逐条更新，或在取消/失败后不做整批回滚之外的处理（已完成的部分**不应**被回滚）。
