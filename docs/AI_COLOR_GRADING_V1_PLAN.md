# AI 调色 V1 实施计划与技术设计

> 更新日期：2026-07-19  
> 平台：Windows 10/11 x64  
> 状态：首版代码已实现，等待真实模型联调与 Windows UI 人工验收

## 1. 目标

在保留现有“AI 追色（原片 + 参考图）”的基础上，新增独立“AI 调色（单张照片）”工作区。

用户流程：

1. 选择一张照片；
2. 选择调色执行方式；
3. 视觉模型分析照片并返回 3 套可选择的调色配方；
4. 用户选择配方；
5. 通过本地参数渲染或图像编辑模型生成最终效果；
6. Before/After 对比并导出 JPEG。

## 2. 两种调色方式

### 2.1 AI 参数调色

- 上传由 Canvas 重编码的分析缩略图；
- 视觉模型返回结构化配方和完整基础调色参数；
- 用户选择配方和强度；
- Canvas 2D 在本地执行曝光、对比度、高光、阴影、白色、黑色、色温、色调、自然饱和度、饱和度、褪色和颗粒；
- 最终像素不由云端模型生成；
- 导出时基于较高分辨率原片重新本地渲染。

### 2.2 AI 图生图调色

- 第一阶段仍由视觉模型生成 3 套配方；
- 用户选择配方并可填写补充要求；
- 客户端将重编码图片与配方发送到 `{baseUrl}/images/edits`；
- 图像编辑模型完成调色并返回 Base64 图片或临时图片 URL；
- 客户端载入结果、提供 Before/After 对比并导出 JPEG；
- 界面明确提示图像模型可能改变人物、文字或局部细节，用户应人工检查。

## 3. 技术栈

沿用现有技术栈，避免引入第二套桌面框架：

- Tauri 2：Windows 窗口、原生文件对话框、命令桥接和 NSIS 打包；
- Rust：模型请求、Multipart 图片上传、凭据读取和响应校验；
- React 19 + TypeScript + Vite：步骤式工作流和预览界面；
- Canvas 2D：缩略图重编码、本地参数调色和 JPEG 导出；
- reqwest + rustls：Responses、Chat Completions 和 Image Edit API；
- Windows Credential Manager：API Key；
- Tauri Store：非敏感模型设置；
- Vitest + Cargo Test：参数缩放、Schema 解析和 Data URL 解码测试。

## 4. 模型配置

共用配置：

- Provider Name；
- Base URL；
- API Key；
- 视觉模型；
- Responses API / Chat Completions；
- 分析超时；
- 分析缩略图最长边。

图生图附加配置：

- 图像生成/编辑模型；
- 输出质量：low / medium / high；
- 输出尺寸：auto / 1024x1024 / 1536x1024 / 1024x1536；
- 图生图超时；
- 上传图片最长边。

第一版共用同一 Base URL 和 API Key。兼容服务必须提供 OpenAI 风格的 `/images/edits` Multipart 接口。

## 5. 结构化配方

视觉模型必须返回 3 套配方：

1. 自然修正；
2. 电影化处理；
3. 编辑/风格化处理。

每套配方包含：

```ts
interface ColorWorkflowSuggestion {
  id: string
  title: string
  description: string
  rationale: string
  generationPrompt: string
  parameters: {
    exposure: number
    contrast: number
    highlights: number
    shadows: number
    whites: number
    blacks: number
    temperature: number
    tint: number
    vibrance: number
    saturation: number
    fade: number
    grain: number
  }
}
```

Rust 层对所有数值和字符串再次限幅，不能直接信任模型输出。

## 6. 隐私设计

- 本地参数方式：只发送分析缩略图，最终像素完全本地生成；
- 图生图方式：单独二次确认，明确会发送较大重编码图片；
- 不发送本地路径和 EXIF；
- Base URL 改变时自动清除两类隐私确认状态；
- API Key 只保存在 Windows Credential Manager；
- 不在普通配置文件和日志中保存 API Key；
- 图生图结果必须由用户检查身份、文字、物体和几何一致性。

## 7. 已实现文件

```text
src/components/AiColorWorkspace.tsx  AI 调色步骤式工作区
src/lib/aiColor.ts                   配方强度与本地参数转换
src/lib/aiColor.test.ts              参数缩放测试
src/lib/types.ts                     AI 调色、配方和图像模型配置类型
src/lib/desktop.ts                   新增 Tauri 命令桥接
src/lib/files.ts                     Data URL 图片载入与 Canvas 绘制
src/App.tsx                           AI 追色 / AI 调色 / 模型设置导航
src/styles.css                        AI 调色界面样式
src-tauri/src/model_client.rs         配方分析与 /images/edits 请求
src-tauri/src/lib.rs                  新命令注册
src-tauri/Cargo.toml                  multipart 与 base64 依赖
```

## 8. Rust 命令

```rust
suggest_color_workflows
generate_colored_image
```

`suggest_color_workflows`：

- 支持 Responses API；
- 支持 Chat Completions；
- Chat Completions 在 `json_schema` 返回 HTTP 400 时自动退回普通 JSON；
- 强制解析 3 套配方；
- 对参数与文字长度进行服务端限幅。

`generate_colored_image`：

- 使用 Multipart 调用 `/images/edits`；
- 首次使用 `image[]` 字段；
- HTTP 400 时使用 `image` 字段重试，以兼容不同服务；
- 发送模型、图片、提示词、质量、尺寸、JPEG 输出格式和压缩质量；
- 支持读取 `b64_json`；
- 兼容读取返回的临时 `url`；
- 最终返回前端可直接载入的图片 Data URL。

## 9. 验证结果

截至 2026-07-19：

- [x] TypeScript + Vite 生产构建通过；
- [x] Rust 4 个单元测试通过；
- [x] AI 调色页面、方法切换、配方选择、参数强度和导出逻辑已实现；
- [x] 图像模型配置和独立隐私确认已实现；
- [ ] 使用真实视觉模型验证 3 套配方质量；
- [ ] 使用真实图像编辑模型验证 `/images/edits`；
- [ ] 检查横图、竖图和方图的 Before/After 对齐；
- [ ] Windows 100%、125%、150% DPI 人工验收；
- [ ] 重新构建并烟测 NSIS 安装包。

## 10. 开发启动

```powershell
npm install
npm run tauri:dev
```

只预览前端界面：

```powershell
npm run dev
```

注意：浏览器模式不能调用 Windows Credential Manager 或 Rust 模型命令，完整 AI 调色流程必须使用 `npm run tauri:dev`。

## 11. 后续迭代

- 用 Web Worker 执行高分辨率本地调色，避免阻塞 UI；
- 增加局部蒙版、主体/肤色/天空保护；
- 增加曲线、HSL、Color Grading 三向轮参数；
- 根据原图宽高比自动选择图像模型输出尺寸；
- 增加失败重试、取消生成和请求进度；
- 保存历史配方和调色版本；
- 在稳定后增加 Lightroom XMP 与 CUBE LUT 输出。
