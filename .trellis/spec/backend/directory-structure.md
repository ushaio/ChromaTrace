# 目录结构

> 本项目后端代码的组织方式。

---

## 概述

后端是单一 Rust crate，根在 `src-tauri/`，拆成四个各管一摊的模块加上 Tauri 启动代码。业务逻辑**就写在拥有该资源的模块里**——没有额外的 service / repository 分层。前端能碰到的每一个能力，都是一个 `#[tauri::command]` 函数，并且**只在一个地方注册**：`src-tauri/src/lib.rs`。

---

## 目录布局

```
src-tauri/
├── Cargo.toml
├── tauri.conf.json          窗口与打包配置（NSIS，当前用户安装模式）
└── src/
    ├── main.rs              (6 行)   二进制入口，调 lib::run()
    ├── lib.rs               (~90)    模块声明、2 个通用文件命令、
    │                                 插件初始化、invoke_handler 注册
    ├── credentials.rs       (92)     系统凭据：macOS Keychain /
    │                                 Windows Credential Manager
    ├── raw_decode.rs        (~265)   RAW 解码（rawler）：完整解码 + 缩略图快路径
    ├── asset_library.rs     (1358)   磁盘资产库 + 位置迁移
    ├── workspace.rs         (~1900)  工作区：manifest、卷判定、导入管线、
    │                                 缩略图缓存、卷策略记忆
    ├── photo_info.rs        (~1650)  图片属性：EXIF 解析（JPEG/PNG/WebP/TIFF 系，rawler 兜底）、
    │                                 属性读取 / 在文件管理器中定位 / 从工作区删除
    └── model_client.rs      (1621)   对外的视觉 / 图像编辑请求
```

行数只是体量信号，不是规则。真正的领域复杂度压在 `asset_library.rs`、`workspace.rs` 和 `model_client.rs` 上。

---

## 模块职责

| 模块 | 负责什么 | 对外命令数 |
|------|----------|-----------|
| `lib.rs` | crate 接线、插件初始化、命令注册 | 2 |
| `credentials.rs` | 只负责 API Key 持久化（绝不落普通文件） | 3 |
| `raw_decode.rs` | RAW → RGB 字节（rawler）：`decode_raw_file` 完整解码、`decode_raw_thumbnail` 内嵌预览快路径 | 2 |
| `asset_library.rs` | 库根目录 + `library-location.json`、导入 / 列出 / 重命名 / 移动 / 删除、带进度事件的目录迁移 | 14 |
| `workspace.rs` | 工作区 manifest（原子写入 + revision 乐观并发）、卷判定与挂载解析、卷策略记忆、复制 / 引用导入管线（进度 + 取消 + 逐条落盘）、缩略图缓存读写、参考图登记与解析、磁盘空间预检、清空工作区 | 18 |
| `model_client.rs` | 连接测试、视觉分析、调色工作流建议、提示词优化、图生图 | 6 |
| `photo_info.rs` | 图片属性：自研 EXIF 解析（容器定位 + IFD 遍历，RAW 走 rawler 兜底）、属性读取、文件管理器定位、按 id 批量从工作区移除（副本 + 缩略图回收，不碰源文件） | 3 |

**注册是集中的。** 加一个命令意味着两件事：在所属模块里写函数，**并且**把它加进 `lib.rs` 的 `tauri::generate_handler![...]` 列表。不在那个列表里的函数，前端永远看不见——这是最容易犯的一类接线错误。

---

## IPC 接口面（48 个命令，均从 `lib.rs` 核对）

**通用文件读写 —— `lib.rs`**
`read_binary_file`、`write_binary_file`

**RAW 解码 —— `raw_decode.rs`**
`decode_raw_file`、`decode_raw_thumbnail`

**资产库 —— `asset_library.rs`**
`get_library_location`、`open_library_folder`、`migrate_library_location`、
`list_library_assets`、`import_library_asset`、`import_library_folder`、
`import_library_asset_bytes`、`read_library_asset_text`、
`delete_library_asset`、`rename_library_asset`、`rename_library_folder`、
`delete_library_folder`、`move_library_asset`、`move_library_folder`

**工作区 —— `workspace.rs`**
`read_workspace_manifest`、`write_workspace_manifest`、`classify_source_volumes`、
`resolve_volume_mount`、`get_volume_policies`、`set_volume_policy`、
`clear_volume_policies`、`clear_volume_policy`、`import_workspace_files`、
`cancel_workspace_import`、`import_workspace_reference`、
`resolve_workspace_reference_path`、`resolve_workspace_photo_paths`、
`list_absent_workspace_volumes`、`read_workspace_thumbnail`、
`write_workspace_thumbnail`、`purge_workspace_thumbnails`、`clear_workspace`、
`workspace_disk_space`、`open_workspace_folder`

**图片属性 —— `photo_info.rs`**
`read_workspace_photo_properties`、`reveal_photo_location`、`delete_workspace_photos`
**凭据 —— `credentials.rs`**
`save_api_key`、`delete_api_key`、`has_api_key`

**模型请求 —— `model_client.rs`**
`test_model_connection`、`analyze_with_model`、`refine_match_with_model`、
`suggest_color_workflows`、`optimize_color_prompt`、`generate_colored_image`

前端桥接层在 `src/lib/desktop.ts`，它同时提供浏览器降级实现，所以 `npm run dev` 在没有 Tauri 外壳时也能跑。

---

## 长耗时命令的写法

需要读写大量文件的命令**不要**同步执行，一律 `tauri::async_runtime::spawn_blocking`，并把进度通过命名事件推给前端：

| 命令 | 事件名 | 进度结构 |
|------|--------|----------|
| `migrate_library_location` | `library-migration-progress` | `phase` / `copiedBytes` / `totalFiles` / `percent` / `currentFile` |
| `import_workspace_files` | `workspace-import-progress` | 同上，另带 `jobId`（前端按 jobId 过滤，因为可能并发触发） |

取消语义：`cancel_workspace_import(job_id)` 只把 `AtomicBool` 置位，复制循环在每张图片开始前检查它。**已复制完成的条目保留 `ready`，正在复制的清掉半成品回到 `pending`——不做整批回滚**，用户已完成的部分不应被回滚。


---

## 命名约定（观测所得，尚未形成正式规则）

- 模块：`snake_case.rs`，一个模块一个资源 / 一类能力。
- 命令：`snake_case`，动词在前（`list_*`、`import_*`、`delete_*`、`move_*`、`rename_*`）。
- 命令统一返回 `Result<T, String>`——详见 [错误处理](./error-handling.md)。
- 参数用拥有型（`String`、`Vec<u8>`）而非借用型，因为 Tauri 命令参数是每次调用独立反序列化的。

以上若有不对或该收紧的地方，直接改这个文件——它就是子 agent 未来要遵守的契约。

---

## 示例

`asset_library.rs` 是完整模块的范例：自己持有磁盘状态、暴露一族连贯的命令，并且用进度事件（`library-migration-progress`）而不是阻塞 UI 线程。

---

## 待决问题

- `model_client.rs` 涨到 1600 行以上之后，要不要按能力拆（视觉 / 图像编辑）？
- 长耗时命令有偏好写法吗——进度事件（迁移就是这么做的）还是直接阻塞返回？
