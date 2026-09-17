# 质量规范

> 后端代码的质量标准。

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

**已验证的现状**（读自仓库，尚未上升为规则）：

- 文档化的检查项（README「测试与构建」章节），在 `src-tauri/` 下执行：
  ```powershell
  cargo fmt -- --check
  cargo test
  ```
- 测试覆盖**不完整且不均匀**：只有 `asset_library.rs`、`model_client.rs`、`workspace.rs`、`raw_decode.rs` 有 `#[cfg(test)]` 模块。`credentials.rs` 和 `lib.rs` **完全没有测试**。
- 2026-09 工作区改造后共 **41 个测试**（`workspace.rs` 12 个 + `raw_decode.rs` 3 个 + `photo_info.rs` 7 个 + 既有 19 个）。新增测试覆盖的是纯函数与不依赖真实磁盘的降级逻辑：路径穿越 / 深度限制、`copy` 与 `reference` 的落点差异、未知盘符类型回落 `copy`、缩略图键对 `volumeId` / `size` / `mtime` / `maxSide` 的敏感性、崩溃恢复降级、卷策略文件的双形态解析。`photo_info.rs` 的测试用内存 `Cursor` 喂自造字节：小端 TIFF 夹具（IFD0 + ExifIFD + GPS IFD）、JPEG 里跳过 APP0/XMP 再取 Exif APP1、PNG `eXIf` 与 WebP `EXIF` 块、非图片输入返回空、越界 IFD 不 panic、图像数据段超过段上限时仍能继续找到 EXIF，以及「1/250 秒 / f/2.8 / +0.3 EV / 无穷远 / 0000 日期」这些格式化判据。
- CI 里**没有 `clippy` 关卡**，`Cargo.toml` 里也没有 `[lints]` / `#![deny(...)]` 配置。CI（`.github/workflows/build-macos.yml`）只做构建。也就是说，目前 Rust 侧唯一的自动化关卡是「能编译」。
- 涉及网络或文件系统的命令本身不被测试覆盖；通常做法是把逻辑抽成一个纯函数，然后测那个纯函数（例如 `parse_volume_policies(&[u8])` 从 `load_volume_policies(&AppHandle)` 里抽出来）。

### 踩过的坑（Rust 侧）

- **`rawler` 的 `Decoder` trait 方法作用在 `dyn Decoder` 上时不需要 `use rawler::decoders::Decoder;`** —— 加了反而会得到 `unused_imports` 警告（`rawler::get_decoder` 返回的已经是 `Box<dyn Decoder>`，方法可直接调用）。
- **`raw_decode.rs::decode_raw_file` 无论请求多大尺寸都会全量 demosaic + develop**（45MP 展开为 f32 后转 RGB8 约 135MB，最后才 resize）。一张 256px 缩略图的成本与一张 4000px 预览完全相同 —— 缩略图必须走 `decode_raw_thumbnail` 的内嵌预览快路径，否则 200 张 RAW 的工作区方案不可用。
- **`GetVolumeInformationW` 取卷序列号要传入足够长的缓冲**，且拿不到卷标时要用盘符类型名兜底，不要返回空串（前端要靠它让用户认出是哪块盘）。
- **`windows` crate 的 `GetDiskFreeSpaceExW` 出参是 `Option<*mut u64>`**，不是 `&mut u64`；写错会得到难以看懂的类型错误。
- 字符字面量 `'\\'`（单个反斜杠）**不要**误写成 `'\\\\'`——后者在 Rust 里是长度为 2 的字符字面量，直接编译失败。


需要团队拍板的问题：

1. `cargo clippy -- -D warnings` 要不要变成硬性关卡（本地、CI，或两者）？
2. 新增一个 `#[tauri::command]` 是否必须附带其纯函数的测试，还是在应用里手动验证即可？
3. `raw_decode.rs` 和 `credentials.rs` 承担着文件与密钥处理，是否应该补齐到另两个模块的覆盖水平？

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
