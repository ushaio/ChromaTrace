# 类型安全

> 本项目的类型模式。

---

## 概述

<!--
在这里记录本项目的类型安全约定。

需要回答：
- 用什么类型系统？
- 类型怎么组织？
- 用什么校验库？
- 类型推断怎么处理？
-->

**已验证的现状**（读自 `tsconfig.app.json` 与 `src/lib/types.ts`，尚未上升为规则）：

- TypeScript 5.7，`tsconfig.app.json` 里 **`strict: true`**，另有 `allowJs: false`、`isolatedModules: true`、`noEmit: true`、`moduleResolution: "Bundler"`、`target: "ES2022"`、`jsx: "react-jsx"`。
- 类型检查**是构建的一部分**：`npm run build` = `tsc -b && vite build`，所以类型错误会让构建失败。这是前端目前最硬的门禁。
- **没有引入任何运行时校验库**（没有 Zod / Yup / io-ts / Ajv / valibot）。依赖里只有 `typescript` 本身。
- 共享类型集中在一个文件：`src/lib/types.ts`（473 行）。组件与工具模块不各自定义跨模块类型。
- 风格上是 **interface 优先 + 字符串字面量联合当枚举**：`interface`（`ColorStats`、`Adjustments`、`ModelConfig`…）配 `type X = 'a' | 'b'`（`CurveChannel`、`HslChannel`、`ColorGradeZoneName`、`ModelApiType`、`AiColorMethod`、`ImageQuality`…）。
- 组合用 `extends` 而不是重复声明：`ModelColorParameters extends Adjustments`、`VisionRuntimeConfig extends VisionModelConfig`。
- IPC 边界的类型（`LibraryAsset`、`LibraryLocation`、`WorkspaceManifest` 等）是**手写**映射 Rust 侧结构的 interface，**没有从 Rust 自动生成**——Rust 改了字段名，TypeScript 这边不会有任何提示。
- 手写映射的代价是真实存在的：改 Rust 结构体字段名时，**必须同时**改 `src/lib/types.ts` 里的对应 interface（camelCase）与 Rust 侧的 `#[serde(rename_all = "camelCase")]`，否则只会在运行时静默变成 `undefined`。
- **外部输入一律做容错归一化，不做类型断言**：`src/lib/workspace.ts::normalizeManifest` 把磁盘上的 manifest 逐字段降级（缺字段补默认、单条图片缺关键字段就丢那一条、非法枚举值回落到默认值），因此磁盘文件被截断时页面不会整体打不开。新增持久化结构时应沿用这个模式，而不是 `as WorkspaceManifest` 一断了之。
- **跨语言摘要必须两端一致**：图片身份与缩略图缓存键是 SHA-1（Rust `sha1` crate / 前端 `src/lib/hash.ts`）。前端刻意用**纯 JS 同步实现**而不是 `crypto.subtle`——后者只存在于安全上下文，且 vitest 跑在 node 环境。两端各有一条测试钉住同一个输入 → 同一个摘要（`hash.test.ts` 与 `workspace.rs::tests::thumb_key_tracks_identity_and_file_state` 断言同一个 hex 值），改算法时两边会同时红。

需要团队拍板的问题：

1. IPC 边界要不要引入代码生成（如 `ts-rs` / `specta` / `tauri-specta`）来消除手写漂移？
2. 外部输入（模型 API 返回的 JSON、`library-location.json` 的历史版本）要不要加运行时校验？现在完全靠类型断言。
3. 字符串字面量联合是否要统一收敛到类型文件，还是允许就近定义？

---

## 类型组织

<!-- 类型定义在哪；共享类型 vs 局部类型的边界 -->

（待团队补充）

---

## 校验

<!-- 运行时校验模式（Zod / Yup / io-ts 等） -->

（待团队补充）

---

## 常用模式

<!-- 类型工具、泛型、类型守卫 -->

（待团队补充）

---

## 禁止模式

<!-- any、类型断言 as、@ts-ignore、非空断言 ! 等 -->

（待团队补充）
