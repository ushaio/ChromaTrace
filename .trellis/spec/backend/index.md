# 后端开发规范（Rust / Tauri）

> 本项目 `src-tauri/` 侧的开发约定。

---

## 这一层为什么存在

`trellis init` 把本仓库判定为**纯前端项目**，只生成了 `.trellis/spec/frontend/`。判定依据是**仓库根目录**的文件（Trellis CLI 的 `BACKEND_INDICATORS` 会找顶层的 `Cargo.toml` / `Cargo.lock`），而本项目的 Rust crate 在 `src-tauri/Cargo.toml`——低了一层。于是探测器只看到 `package.json` + `vite.config.ts` + `src/App.tsx`。

这一层是手工补上来的。`.trellis/scripts/common/packages_context.py` 里的 `_scan_spec_layers()` 只是**扫描 `.trellis/spec/` 的子目录**来发现层级，所以**不需要任何配置改动**——目录一旦存在，这一层立刻对会话上下文和子 agent 可见。

---

## 概述

后端是一个 Tauri 2（Rust）应用，负责：原生文件对话框、RAW 解码、磁盘上的本地资产库、系统凭据存储，以及所有对外的模型请求。前端通过 `#[tauri::command]` IPC 调用它，**没有 HTTP 服务端**。

---

## 规范索引

| 文档 | 内容 | 状态 |
|------|------|------|
| [目录结构](./directory-structure.md) | 模块划分与 IPC 命令映射 | 已填（仅事实） |
| [错误处理](./error-handling.md) | 错误类型与处理策略 | 已填（仅事实） |
| [质量规范](./quality-guidelines.md) | 代码标准、禁止模式 | 已填（仅事实） |
| [日志规范](./logging-guidelines.md) | 日志级别与日志落点 | 已填（仅事实） |
| [数据存储](./database-guidelines.md) | 本项目无数据库——状态实际存在哪里 | 已填（范围说明） |

> 本目录下的文档目前只包含**可验证的事实**（文件清单、命令名、磁盘状态位置、现有测试与日志现状）。需要人来拍板的部分（团队约定、禁止模式、评审清单）刻意保留为「待填」——填错比空着更糟，因为子 agent 会把它们当契约执行。

---

## 怎么填这些规范

每个文档都按同样的要求填：

1. 写**项目实际的做法**，不是理想做法
2. 附上**本项目代码里的例子**
3. 列出**禁止模式**，并说清为什么
4. 补上**团队踩过的坑**

目标只有一个：让 AI 助手和新成员看懂**你这个项目**是怎么运转的。

---

**语言**：本目录下所有文档一律使用**简体中文**。
