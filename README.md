# 色迹 ChromaTrace

色迹是一个面向 **Windows 10/11 x64** 的本地优先 AI 调色客户端。当前版本包含两个独立工作区：

- **AI 追色**：导入原片和参考图，在本地完成颜色统计匹配，并可选用视觉模型优化参数；
- **AI 调色**：导入单张照片，由视觉模型生成三套调色工作流，用户选择后通过本地参数引擎或图像编辑模型执行。

第一版暂不包含 Lightroom 预设、CUBE LUT、RAW、批处理或云账号系统。

## 当前功能

### AI 追色

- 原片/参考图文件选择和 Windows 原生拖拽导入；
- JPG、JPEG、PNG、WebP 输入；
- 跨图明度分位数曲线迁移；
- OKLab 阴影/中间调/高光分区颜色迁移；
- 线性光曝光与白平衡处理；
- 曝光、对比度、高光、阴影、白色、黑色、色温、色调、自然饱和度和饱和度精修；
- 五点总明度曲线与红、绿、蓝通道曲线；
- 红、橙、黄、绿、青、蓝、紫、洋红八色 HSL；
- 阴影、中间调、高光三分区色彩分级，以及平衡和混合控制；
- 受约束的红、绿、蓝三原色色相与饱和度校准；
- 匹配强度、明度保护、肤色保护、褪色和颗粒；
- 可选视觉模型增强，失败时自动回退本地追色；
- Before/After 分割预览和 JPEG 导出。

### AI 调色

1. 选择一张照片；
2. 选择执行方式；
3. 视觉模型分析图片并返回三套可选调色配方；
4. 选择配方并执行调色；
5. 检查 Before/After，导出 JPEG。

支持两种执行方式：

- **AI 参数调色**：视觉模型只输出结构化调色参数，最终像素由本地 Canvas 引擎生成；
- **AI 图生图调色**：视觉模型先给出可选工作流，再将选中的配方和重编码图片发送给支持图片编辑的模型，由模型返回调色后的图片。

本地参数调色支持：曝光、对比度、高光、阴影、白色、黑色、色温、色调、自然饱和度、饱和度、褪色、颗粒和配方强度。

> 图生图模型可能改变人物、文字、物体或局部细节。应用会在首次使用前单独进行隐私确认，结果必须由用户人工检查。

## 技术栈

- 桌面外壳：Tauri 2、Rust；
- 前端：React 19、TypeScript、Vite；
- UI 图标：Lucide React；
- 本地图像处理：Canvas 2D + TypeScript；
- 模型请求：Rust `reqwest` + rustls；
- 本地设置：Tauri Store；
- 密钥存储：Windows Credential Manager（Rust `keyring`）；
- 测试：Vitest、Rust `cargo test`；
- Windows 安装：NSIS，当前用户安装模式。

## 开发环境

建议准备：

1. Windows 10/11 x64；
2. Node.js 20 或更新的 LTS 版本；
3. Rust stable 与 Cargo；
4. Microsoft C++ Build Tools；
5. WebView2 Runtime（Windows 10/11 通常已安装）。

检查 Tauri 环境：

```powershell
npm run tauri -- info
```

## 安装依赖

在项目根目录执行：

```powershell
npm install
```

如果已经存在 `node_modules`，通常可以直接启动。

## 开发启动

### 启动 Windows 客户端

```powershell
npm run tauri:dev
```

Tauri 会同时启动 Vite 开发服务器和 Windows 客户端窗口。首次运行需要编译 Rust 依赖，耗时会比后续启动更长。

### 只启动浏览器界面

```powershell
npm run dev
```

浏览器模式适合检查 UI 和本地 Canvas 颜色引擎，但以下功能只能在 Tauri Windows 客户端中使用：

- Windows 原生文件和保存对话框；
- Windows Credential Manager；
- 视觉模型请求；
- 图像编辑模型请求。

## 模型配置

配置入口位于顶部 **模型设置**。AI 调色的两种方式都需要先开启模型能力并保存 API Key。

### 通用视觉模型

- **服务商名称**：只用于界面标识；
- **Base URL**：默认 `https://api.openai.com/v1`，也支持 OpenAI 兼容服务；
- **视觉模型**：必须支持图片输入，用于 AI 追色增强和生成三套 AI 调色配方；
- **接口类型**：Responses API 或 Chat Completions 兼容接口；
- **请求超时**：视觉分析请求超时；
- **缩略图最长边**：发送给视觉模型的重编码 JPEG 尺寸；
- **API Key**：由 Rust 层保存到 Windows Credential Manager。

### 图像编辑模型

- **图像模型**：默认 `gpt-image-2`，也可填写兼容服务支持的模型 ID；
- **质量**：`low`、`medium`、`high`；
- **输出尺寸**：推荐 `auto`，也支持界面提供的固定尺寸；
- **图生图超时**：独立于视觉分析的超时时间；
- **上传图片最长边**：发送给图像编辑模型的重编码图片尺寸。

### Base URL 规则

通常填写 API 根地址，例如：

```text
https://api.openai.com/v1
https://your-compatible-service.example/v1
http://127.0.0.1:1234/v1
```

应用会自动追加对应端点：

- Responses API：`/responses`；
- Chat Completions：`/chat/completions`；
- 连接测试：`/models`；
- 图像编辑：`/images/edits`。

兼容服务若要支持 AI 图生图调色，需要实现 Multipart 图片编辑接口并返回 `b64_json`，或返回应用能够下载的临时图片 URL。

## 隐私与安全

- 纯本地追色不会发起模型网络请求；
- AI 参数调色只向视觉模型发送由 Canvas 重编码的 JPEG 缩略图；
- AI 图生图调色会发送尺寸较大的重编码 JPEG 图片，并使用独立隐私授权；
- 不主动发送原始文件、EXIF、本地路径；
- API Key 不写入 React 持久化状态、Local Storage、普通配置文件或安装包；
- Windows 客户端中的 API Key 只通过 Windows Credential Manager 持久化；
- Base URL、模型名称和非敏感设置保存在 Tauri Store；
- 修改 Base URL 会清除已有的图片上传隐私授权，要求用户重新确认。

使用第三方兼容服务时，请自行确认服务商的接口兼容性、数据保留政策和安全性。

## 测试与构建

前端单元测试：

```powershell
npm run test
```

前端生产构建：

```powershell
npm run build
```

Rust 格式检查和测试：

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

当前开发构建未配置代码签名证书，Windows 可能显示“未知发布者”。正式分发前应配置 Windows 代码签名。

### 使用 GitHub Actions 构建 macOS

仓库中的 `.github/workflows/build-macos.yml` 会在 `macos-14` Runner 上构建同时支持 Apple Silicon 与 Intel 的 Universal 应用。可在 GitHub 仓库的 **Actions → Build macOS → Run workflow** 手动启动；推送 `v*` 版本标签时也会自动运行。

工作流完成后，`.app.zip` 和 `.dmg` 会上传到对应标签的 **GitHub Release**，并在运行详情页的 **Artifacts** 中保留一份：

```text
ChromaTrace.app.zip
ChromaTrace_0.1.0_universal.dmg
```

该自动构建默认未使用 Developer ID 签名和 Apple 公证，仅适合内部测试。正式公开分发时，需要在仓库 Secrets 中配置 Apple 开发者证书、公证账号，并为工作流增加签名与 notarization 环境变量。

macOS 使用系统 Keychain 保存 API Key；Windows 继续使用 Credential Manager。

如果标签已经存在但 Release 中只有源码包，可手动运行该工作流，并在 `release_tag` 中填写已有标签（例如 `v0.1.0`）；工作流会创建或更新 Release，并补充安装文件。

## 项目结构

```text
src/
  App.tsx                         顶层导航、AI 追色和模型设置
  components/AiColorWorkspace.tsx AI 调色工作流界面
  components/FineTunePanels.tsx  追色高级精修面板
  components/CurveEditor.tsx     五点曲线编辑器
  lib/aiColor.ts                 AI 调色配方强度转换
  lib/colorEngine.ts             本地颜色分析与像素处理
  lib/desktop.ts                 Tauri 命令桥接与浏览器降级
  lib/files.ts                   图片解码、重编码、Canvas 和 JPEG 输出
  lib/types.ts                   业务类型、模型设置和默认参数
src-tauri/
  src/lib.rs                     Tauri 命令与插件注册
  src/credentials.rs             系统安全凭据（Keychain / Credential Manager）

如果标签已经存在但 Release 中只有源码包，可手动运行该工作流，并在 `release_tag` 中填写已有标签（例如 `v0.1.0`）；工作流会创建或更新 Release，并补充安装文件。
  src/model_client.rs            视觉模型与图像编辑模型请求
  tauri.conf.json                基础窗口与 Windows 打包配置
docs/
  AI_COLOR_MATCH_MVP_PLAN.md
  AI_COLOR_GRADING_V1_PLAN.md
  AI_COLOR_MATCH_ENGINE_V0_4.md
```

## 当前限制

- 本地颜色迁移和参数调色是全局处理，不是局部蒙版或语义分区调色；
- 肤色保护是软规则，可能同时影响木材、沙地等暖色区域；
- 图像编辑模型可能改变画面内容，不能视为完全无损的传统调色；
- 尚未实现完整 ICC 色彩管理；
- 不支持 RAW、Lightroom 预设、CUBE LUT 和批处理；
- AI 追色 JPEG 导出最长边为 2400 px；AI 参数调色导出最长边为 3000 px；
- OpenAI 兼容服务对图片消息、结构化输出和 Multipart 字段的支持可能不同；
- 尚未实现请求取消、真实生成进度、代码签名和自动更新。

详细设计、范围、数据结构和后续迭代见：

- `docs/AI_COLOR_MATCH_MVP_PLAN.md`
- `docs/AI_COLOR_GRADING_V1_PLAN.md`
- `docs/AI_COLOR_MATCH_ENGINE_V0_4.md`

## 许可证

本项目基于 [GNU General Public License v3.0](LICENSE)（GPL-3.0-only）发布。

