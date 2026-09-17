# 技术设计：工作区与缩略图栏 V1

## 1. 边界与模块

- Rust `workspace.rs` 负责资料库根目录下工作区文件布局、manifest 读取/写入、卷元数据、导入复制和缓存文件操作；不把前端业务状态塞进 Rust。
- Rust `asset_library.rs` 暴露路径规范化和唯一目标路径能力，`workspace.rs` 复用并通过现有 library location 作为唯一根目录。
- Rust `raw_decode.rs` 增加内嵌预览快路径，保持现有 `decode_raw_file` 兼容。
- TS `lib/types.ts` 是跨模块数据模型唯一来源；`lib/desktop.ts` 只负责 IPC/浏览器 fallback；`lib/workspace.ts` 负责 manifest 归一化、身份、派生引用和批量配方；`lib/thumbnails.ts` 负责缓存键与有限并发。
- React 组件 `Filmstrip`、`VolumeBanner`、导入面板负责显示和用户交互；App 仍是当前应用的编排层，但调整状态必须由 workspace photo 作为唯一真相源。

## 2. 数据流

1. App 启动时调用 `load_workspace_manifest(default)`，Rust 读取 manifest 并执行 copy 条目恢复检查；引用条目通过 `resolve_volume_mount` 判断当前可用性。
2. 用户多选图片后，前端按返回的来源卷调用 `classify_source_volumes`，将重复项和空间预检数据组装到导入确认模型。
3. 确认后前端创建 manifest 条目并调用 `import_workspace_files`。Rust 每完成一条就更新 manifest 并发出 `workspace-import-progress`；当前端收到完成事件后只刷新就绪条目的缩略图和当前列表。
4. Filmstrip 只持有 `WorkspacePhoto` 元数据与 thumb URL；当前选中项才加载全解析 `LoadedImage`。切换时释放旧 object URL，分析图由有限 LRU 管理。
5. 编辑器调整直接通过 `updatePhotoDevelop` 写入 workspace manifest 的当前 photo；持久化使用 300ms 防抖并通过 revision 乐观校验拒绝旧覆盖。

## 3. 关键契约

- `WorkspaceManifest.version = 1`，`revision` 每次保存递增；写入采用 `manifest.json.tmp` + rename。
- `WorkspacePhoto.id = sha1(volumeId + "|" + relativeSourcePath)`，没有 SHA-1 依赖时前端使用稳定 FNV-1a 兼容键，Rust 以输入组合保持同一逻辑；不以绝对路径做身份。
- copy 条目的读取路径始终是 workspace root 下的 `workspacePath`；reference 条目解析为当前卷挂载点 + `relativeSourcePath`。
- `copy` 目标路径必须经过相对路径规范化、深度限制和目录 containment 检查；不能允许 `..`、盘符或绝对路径穿越。
- 取消导入保留 ready 条目，正在复制项删除半成品并回到 pending。
- thumbnail key 对 volumeId、相对路径、size、mtime、maxSide 敏感；缓存文件不是 manifest 真相，缺失时可重建。

## 4. 前端兼容策略

- 浏览器环境没有原生卷信息，使用一个虚拟 fixed volume 和本地内存 manifest，保证组件测试/预览不崩溃；不伪造桌面复制语义。
- 既有单图入口继续可用：导入单图时创建/替换 default 工作区中的当前 photo；在 workspace 无图片时保留旧的 `source` fallback，避免升级后空白。
- `reference` 无值时 `effectiveReference` 返回 null；AI 追色和预览调用前先判断。

## 5. 性能与回滚

- RAW 缩略图首选嵌入预览，目标 maxSide 256；fallback 明确走现有 decoder，不在前端把原始 RAW 常驻内存。
- Filmstrip 高度固定 96px，缩略图加载并发上限 3，不做虚拟列表依赖；超过窗口时用简单可见范围切片。
- 先提交纯逻辑和 IPC 类型，再接 App；若状态迁移影响现有编辑器，保留适配层，把当前单图映射到 active photo，避免一次性重写全部 UI。
- 若 Rust 新依赖在目标平台不可用，前端仍可构建，桌面能力以明确错误返回；不修改现有模型调用链。
