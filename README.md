<div align="center">

<img src="src-tauri/icons/icon.png" width="120" height="120" alt="色迹 ChromaTrace" />

# 色迹 ChromaTrace

**本地优先的 AI 追色与 AI 调色工作台**

把「决定怎么调」和「真正去调」分开：模型只负责理解画面并给出配方，最终像素由本地引擎渲染。

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6.svg)](#快速开始)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-stable-000000.svg)](https://www.rust-lang.org)

[功能](#功能) · [技术栈](#技术栈) · [快速开始](#快速开始) · [模型配置](#模型配置) · [隐私与安全](#隐私与安全) · [测试与构建](#测试与构建) · [友情链接](#友情链接)

</div>

---

## 简介

色迹是面向 **Windows 10/11 x64** 的本地优先桌面调色客户端，基于 Tauri 2 + React 19 构建，macOS（Universal）可通过仓库内的工作流构建。

- 不启用模型时可**完全离线**使用，纯本地追色与参数调色不发起任何网络请求；
- 图像编辑类模型仅在显式授权后调用，且授权按端点独立记录；
- API Key 交由系统凭据存储保管，不写入前端配置或安装包。

## 界面与工作区

应用围绕「工作区」这一素材容器组织，共五个视图：

| 视图 | 说明 |
| --- | --- |
| **工作区** | 工作区列表，文件夹语义卡片：名称、张数、封面、更新时间；支持新建、重命名、删除 |
| **工作区内容** | 当前工作区的素材网格，可多选、删除、打开所在位置、查看属性 |
| **AI 追色** | 双图追色工作区，底部为缩略图导航栏 |
| **AI 调色** | 单图 AI 调色工作区，含 XMP / CUBE 预设库 |
| **设置** | `01 外观` · `02 资料库` · `03 模型` |

顶栏最左侧是**工作区快速切换**控件（带下拉箭头）。未进入任何工作区时，`AI 追色` 与 `AI 调色` 会被禁用并提示「请先进入一个工作区」；切换工作区会二次确认，避免误丢当前编辑上下文。外观支持夜间 / 日间主题。

## 功能

### 工作区与素材库

- 一次导入多张图片，跨会话恢复，无需反复选择文件；
- 支持多选 **JPG / PNG / WebP**，桌面端另支持**相机 RAW**；
- 导入前按**卷**判定来源类型（内部硬盘 / 可移动设备 / 网络磁盘 / 光盘 / 内存盘 / 来源不确定）并给出策略建议；
- 两种纳入方式：
  - **复制到资料库** —— 适合可移动介质，源设备不在位时仍可编辑导出；
  - **直接引用原文件** —— 适合内部固定盘，零额外磁盘占用；
- 复制前做**剩余空间预检**并显示真实目标路径，复制在后台进行，可立即开始修图；
- 策略按**卷标识**记忆（与盘符无关），下次导入同一设备直接沿用；
- **重复检测**：身份为 `sha1(volumeId | 卷内相对路径)`，已存在的图片会被识别并跳过；
- **设备离线处理**：卷不在位时顶部横幅提示，可重新连接、**重新定位**到新根目录，或本次不再提示；
- **资料库位置**可迁移到新目录，保留目录结构，迁移期间有分阶段进度提示；
- 底部**缩略图导航栏**：虚拟滚动、`RAW` / `待复制` / `复制失败` / `断链` / `已修` / `专属参考` 角标，支持 ←/→、Home/End 键盘浏览与 Ctrl / Shift 多选，并提供「套用到所选」批量应用当前配方。

### AI 追色

1. 在工作区中选定**原片**与**参考图**（参考图默认工作区共享）；
2. 运行 **AI 语义追色**，或退而使用**本地快速匹配**；
3. 按需进行 **AI 二次校正**与精细调整；
4. 对比后导出。

- 左侧「匹配样本」显示直方图与原片 / 目标均值色块；
- 「追色控制」在 AI 配方生效时只保留**肤色保护**，本地模式提供**明度迁移强度**、**颜色迁移强度**、**保留原片明度**、**肤色保护**；
- 「匹配诊断」实时给出亮度偏移、饱和差异、暖色偏向与当前方法；
- 对比模式：滑动对比 / 左右分屏 / 上下分屏 / 切换对比。

> AI 语义追色会区分场景环境与可迁移风格，**不使用同图像素对应**。本地快速匹配仅适合场景与光线接近的照片。

### AI 调色

1. 选择一张照片并选择**执行方式**；
2. 视觉模型分析并返回**三套调色配方**；
3. 选择配方并执行；
4. 检查 Before/After 后导出。

两种执行方式：

| 执行方式 | 说明 | 渲染位置 |
| --- | --- | --- |
| **参数调色** | 视觉模型只输出结构化参数，最终像素由本地引擎生成 | 本地 |
| **图生图** | 将选中配方与重编码图片发送给图像编辑模型，由模型返回图片 | 云端 |

可选填**风格提示**（最多 800 字）来约束配方方向，也可对提示词做一次模型优化。图生图路径额外提供输出质量、输出尺寸等参数。

> 图生图会重新生成图片，可能改变人物、文字、物体与局部细节，结果必须由用户人工检查。应用会在首次使用前单独进行隐私确认。

### 预设与查找表

**XMP 预设库**（Lightroom / Camera Raw）

- 导入 `.xmp` 预设（单文件 ≤ 2 MB），映射曝光、对比度、高光、阴影、白色、黑色、色温、色调、自然饱和度、饱和度、黑白、颗粒、纹理、清晰度、去朦胧、锐化、降噪、暗角、八通道 HSL、色调曲线、参数曲线、三分区色彩分级与三原色校准；
- 可将当前参数**保存为 XMP 预设**，在资料库中以文件夹组织，在 Lightroom 中亦可继续使用；
- **暂未应用**并会明确列出的字段：镜头配置文件、镜头畸变、垂直透视、横向色差、裁剪；
- 固定白平衡色温按 5500K 中性点近似换算。

**CUBE LUT 库**

- 导入 `.cube` 文件（≤ 48 MB），仅支持 **3D LUT**，格点需为 17 / 33 / 64 / 65；
- 采用 sRGB 三线性插值，强度可 0–100% 混合；
- 应用顺序位于调色与空间细节之后、颗粒之前；
- 目前仅在 **AI 调色**工作区生效，AI 追色不应用 LUT。

### 精细调整

| 模块 | 控制项 |
| --- | --- |
| 基础明暗 | 曝光、对比度、高光、阴影、白色、黑色 |
| 基础色彩 | 色温、色调、自然饱和度、饱和度 |
| 曲线 | 17 点单调总明度曲线 + 红 / 绿 / 蓝通道 |
| 分颜色调整 | 红橙黄绿青蓝紫洋红八色，各含色相、饱和度、明度 |
| 三分区色轮 | 阴影 / 中间调 / 高光，各含色相、饱和度、明度，另有平衡与混合 |
| 三原色校准 | 红 / 绿 / 蓝原色的色相与饱和度 |
| 细节与清晰 | 纹理、清晰度、去朦胧、锐化、锐化半径、锐化细节、锐化蒙版、明亮度降噪、颜色降噪 |
| 质感与输出 | 暗角、暗角中点、暗角羽化、褪色、颗粒 |

每个模块都可折叠，并有独立的眼睛 / 旁路开关，可整体停用该模块而不丢失参数。

### 相片属性

右键素材选择「属性」可查看文件名、类型、像素尺寸、体积、各项时间、来源（已复制 / 直接引用）、状态、原始位置与工作区副本路径、卷内相对路径与设备标识，以及读取自文件内 EXIF 或相机 RAW 元数据的拍摄信息。

### 导出

- 输出 **JPEG**，质量 0.92；
- 默认按**原图像素全分辨率**处理，仅当 GPU 纹理上限受限时才缩放，不设预览级尺寸上限；
- 优先走 **WebGL2 GPU** 流水线，失败时自动回退 CPU 并给出提示；
- 色彩空间为 sRGB / 8 bit，**不保留 EXIF 等原始元数据**；
- 文件名后缀区分来源，例如 `-chromatrace.jpg`、`-lightroom-xmp.jpg`、`-ai-image-color.jpg`。

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 桌面外壳 | Tauri 2、Rust |
| 前端 | React 19、TypeScript、Vite |
| UI 图标 | Lucide React |
| 本地图像处理 | Canvas 2D（CPU 流水线）+ WebGL2（GPU 预览与导出） |
| 相机 RAW 解码 | `rawler`（dnglab） |
| 模型请求 | Rust `reqwest` + rustls，支持 Multipart |
| 本地设置 | Tauri Store |
| 密钥存储 | Windows Credential Manager / macOS Keychain（Rust `keyring`） |
| 测试 | Vitest、`cargo test` |
| Windows 打包 | NSIS，当前用户安装模式 |

## 快速开始

### 环境要求

1. Windows 10/11 x64；
2. Node.js 20 或更新的 LTS 版本；
3. Rust stable 与 Cargo；
4. Microsoft C++ Build Tools；
5. WebView2 Runtime（Windows 10/11 通常已安装）。

检查 Tauri 环境：

```powershell
npm run tauri -- info
```

### 安装依赖

```powershell
npm install
```

### 启动 Windows 客户端

```powershell
npm run tauri:dev
```

Tauri 会同时启动 Vite 开发服务器与客户端窗口。首次运行需要编译 Rust 依赖，耗时会明显更长。

### 只启动浏览器界面

```powershell
npm run dev
```

浏览器模式适合检查 UI 与本地颜色引擎，但以下能力仅在桌面客户端可用：

- Windows 原生文件与保存对话框；
- 系统凭据存储；
- **相机 RAW 解码**；
- 视觉模型与图像编辑模型请求；
- 资料库位置迁移、EXIF 属性读取、整夹导入。

## 模型配置

配置入口位于 **设置 → 模型**。AI 相关流程需要开启模型能力、填写模型 ID 并保存 API Key，否则相关按钮保持禁用，顶栏显示「图片仅在本机处理」。

### 视觉模型

用于 AI 语义追色增强、二次校正，以及生成三套 AI 调色配方。

| 字段 | 说明 |
| --- | --- |
| 服务商名称 | 仅用于界面标识 |
| Base URL | 默认 `https://api.openai.com/v1`，兼容任意 OpenAI 风格服务 |
| 视觉模型 | 必须支持图片输入 |
| 接口类型 | Responses API 或 Chat Completions 兼容接口 |
| 请求超时 | 视觉分析请求超时时间 |
| 缩略图最长边 | 发送给视觉模型的重编码 JPEG 尺寸 |
| API Key | 由 Rust 层写入系统凭据存储 |

### 图像模型

用于 AI 图生图调色。

| 字段 | 说明 |
| --- | --- |
| 图像模型 | 默认 `gpt-image-2`，可填兼容服务的模型 ID |
| 质量 | `low`、`medium`、`high` |
| 输出尺寸 | 推荐 `auto`，也支持界面提供的固定尺寸 |
| 图生图超时 | 独立于视觉分析的超时时间 |
| 上传图片最长边 | 发送给图像编辑模型的重编码图片尺寸 |

### Base URL 规则

通常填写 API 根地址：

```text
https://api.openai.com/v1
https://your-compatible-service.example/v1
http://127.0.0.1:1234/v1
```

应用会自动追加对应端点：

| 用途 | 端点 |
| --- | --- |
| Responses API | `/responses` |
| Chat Completions | `/chat/completions` |
| 连接测试 | `/models` |
| 图像编辑 | `/images/edits` |
| 图像生成 | `/images/generations` |

兼容服务若要支持图生图调色，需要实现 Multipart 图片编辑接口并返回 `b64_json`，或返回应用能够下载的临时图片 URL。不同服务对图片消息、结构化输出与 Multipart 字段的支持可能存在差异。

## 隐私与安全

- 纯本地追色与参数调色不发起模型网络请求；
- **参数调色**只向视觉模型发送由本地重编码的 JPEG 缩略图；
- **图生图调色**会发送尺寸较大的重编码图片，使用独立隐私授权，并明确提示该端点会重新生成图片；
- 不主动发送原始文件、EXIF 与本地路径，也不使用同图像素对应；
- API Key 不写入 React 持久化状态、Local Storage、普通配置文件或安装包，桌面端只通过系统凭据存储持久化；
- Base URL、模型名称与非敏感设置保存在 Tauri Store；
- 修改 Base URL 会清除已有的图片上传隐私授权，要求用户重新确认。

使用第三方兼容服务时，请自行确认服务商的接口兼容性、数据保留政策与安全性。

## 测试与构建

前端单元测试：

```powershell
npm run test
```

前端生产构建：

```powershell
npm run build
```

Rust 格式检查与测试：

```powershell
cd src-tauri
cargo fmt -- --check
cargo test
```

生成 Windows NSIS 安装包：

```powershell
npm run tauri:build
```

默认产物：

```text
src-tauri/target/release/chromatrace.exe
src-tauri/target/release/bundle/nsis/ChromaTrace_0.1.0_x64-setup.exe
```

当前开发构建未配置代码签名证书，Windows 可能显示「未知发布者」。正式分发前应配置代码签名。

### 使用 GitHub Actions 构建 macOS

仓库中的 `.github/workflows/build-macos.yml` 会在 `macos-14` Runner 上构建同时支持 Apple Silicon 与 Intel 的 Universal 应用。可在 **Actions → Build macOS → Run workflow** 手动启动，也可推送 `v*` 标签自动触发。

工作流完成后，`.app.zip` 与 `.dmg` 会上传到对应标签的 **GitHub Release**，并在运行详情页的 **Artifacts** 中保留一份：

```text
ChromaTrace.app.zip
ChromaTrace_0.1.0_universal.dmg
```

该自动构建默认未使用 Developer ID 签名与 Apple 公证，仅适合内部测试。正式公开分发时，需要在仓库 Secrets 中配置 Apple 开发者证书与公证账号，并为工作流增加签名与 notarization 环境变量。

macOS 使用系统 Keychain 保存 API Key；Windows 继续使用 Credential Manager。

若标签已存在但 Release 中只有源码包，可手动运行该工作流并在 `release_tag` 中填写已有标签（例如 `v0.1.0`），工作流会创建或更新 Release 并补充安装文件。

## 项目结构

```text
src/
  App.tsx                        五个视图的顶层导航、AI 追色与设置
  components/
    AiColorWorkspace.tsx         AI 调色工作流
    WorkspaceContentPage.tsx     工作区素材网格
    AssetLibraryPanel.tsx        XMP / CUBE 预设库面板
    Filmstrip.tsx                缩略图导航栏（虚拟滚动）
    FineTunePanels.tsx           精细调整面板组
    CurveEditor.tsx              17 点曲线编辑器
    ImportConfirmPanel.tsx       导入确认（卷策略与空间预检）
    VolumeBanner.tsx             设备离线提示与重新定位
    PhotoPropertiesDialog.tsx    相片属性与 EXIF
    LibrarySettingsPanel.tsx     设置 · 资料库
    ModelSettingsWorkspace.tsx   设置 · 模型
    Histogram.tsx                直方图
    CompareModeControls.tsx      对比模式切换
  lib/
    colorEngine.ts               本地颜色分析与像素处理（CPU 流水线）
    gpuPreview.ts                WebGL2 两段式预览与导出渲染
    cubeLut.ts                   .cube 解析与三线性插值
    lightroomXmp.ts              Lightroom / Camera Raw XMP 读写
    aiColor.ts                   AI 调色配方与强度转换
    workspace.ts                工作区数据模型
    useWorkspace.ts             工作区状态与导入流程
    thumbnails.ts               缩略图缓存
    hash.ts                      图片身份与重复检测
    photoProperties.ts           EXIF 属性装配
    modelSettings.ts             模型设置与校验
    exportImage.ts               JPEG 导出
    desktop.ts                   Tauri 命令桥接与浏览器降级
    files.ts                     图片解码与重编码
    types.ts / defaults.ts       业务类型与默认参数
src-tauri/
  src/
    lib.rs                       Tauri 命令注册
    workspace.rs                 工作区命令
    asset_library.rs             资料库与预设库
    raw_decode.rs                相机 RAW 解码（rawler）
    photo_info.rs                EXIF 与 RAW 元数据读取
    model_client.rs              视觉与图像模型请求
    credentials.rs               系统凭据存储
    main.rs                      入口
  tauri.conf.json                窗口与打包配置
docs/                            设计文档
```

## 已知限制

- 颜色迁移与参数调色是**全局处理**，不是局部蒙版或语义分区调色；
- 肤色保护是软规则，可能同时影响木材、沙地等暖色区域；
- 图像编辑模型可能改变画面内容，不能视为完全无损的传统调色；
- 导出为 JPEG 且不写回 EXIF / ICC，尚未实现完整 ICC 色彩管理；
- 尚无评分、旗标、色标、虚拟副本、批量导出与导出预设；
- 单图专属参考图已在数据模型中预留，但暂无创建入口；
- 模型请求暂不支持取消，图生图也没有真实生成进度；
- LUT 目前只在 AI 调色工作区生效；
- 相机 RAW 解码仅在桌面客户端可用，浏览器模式仅支持 JPG / PNG / WebP；
- 尚无代码签名与自动更新。

## 设计文档

- [`docs/AI_COLOR_MATCH_MVP_PLAN.md`](docs/AI_COLOR_MATCH_MVP_PLAN.md) — AI 追色 MVP 范围与数据结构
- [`docs/AI_COLOR_MATCH_ENGINE_V0_4.md`](docs/AI_COLOR_MATCH_ENGINE_V0_4.md) — 本地追色引擎设计
- [`docs/AI_COLOR_GRADING_V1_PLAN.md`](docs/AI_COLOR_GRADING_V1_PLAN.md) — AI 调色 V1 方案
- [`docs/WORKSPACE_V1_PLAN.md`](docs/WORKSPACE_V1_PLAN.md) — 工作区与缩略图栏设计
- [`docs/WORKSPACE_NAV_V1_PLAN.md`](docs/WORKSPACE_NAV_V1_PLAN.md) — 工作区层级导航改造

## 许可证

本项目基于 [GNU General Public License v3.0](LICENSE)（GPL-3.0-only）发布。

## 友情链接

<a href="https://linux.do" target="_blank"><img src="https://img.shields.io/badge/Linux%20Do-新的理想型社区-1f6feb?style=flat-square" alt="Linux Do" /></a>

**[Linux Do](https://linux.do)** —— 面向开发者与技术爱好者的中文社区，欢迎前往交流。
