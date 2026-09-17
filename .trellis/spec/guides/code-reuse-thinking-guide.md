# 代码复用思考指南

> **目的**：动手写新代码之前先停一下——这东西是不是已经有了？

---

## 问题在哪

**重复代码是不一致性 bug 的第一大来源。**

当你复制粘贴或重写已有逻辑时：

- 修好的 bug 传不过去
- 行为随时间逐渐分叉
- 代码库越来越难懂

---

## 写新代码之前

### 第一步：先搜

```bash
# 搜相似函数名
grep -r "函数名" .

# 搜相似逻辑
grep -r "关键词" .
```

### 第二步：问自己这几个问题

| 问题 | 如果是「是」…… |
|------|----------------|
| 已经有类似的函数了吗？ | 用它，或扩展它 |
| 这个模式别处在用吗？ | 沿用已有模式 |
| 这个能不能做成公用工具？ | 放到正确的位置去建 |
| 我是在从别的文件拷代码吗？ | **停** —— 抽成共享的 |

---

## 常见的重复模式

### 模式 1：复制粘贴的函数

**坏**：把某个校验函数拷到另一个文件。

**好**：抽到共享工具里，需要的地方 import。

### 模式 2：高度相似的组件

**坏**：新建一个跟已有组件 80% 相似的组件。

**好**：用 props / 变体扩展已有组件。

### 模式 3：重复的常量

**坏**：同一个常量在多个文件里各定义一份。

**好**：单一事实来源，到处 import。

### 模式 4：重复的载荷字段提取

**坏**：多个消费方各自对同一份 JSON / 事件字段做本地断言：

```typescript
const description = (ev as { description?: string }).description;
const context = (ev as { context?: ContextEntry[] }).context;
```

哪怕只有两行，这也是被复制的契约逻辑。每个消费方从此都有了自己对「什么算合法载荷」的定义。

**好**：把解码器 / 类型守卫 / 投影函数放在数据所有者的旁边：

```typescript
if (isThreadEvent(ev)) {
  renderThreadEvent(ev);
}
```

**规则**：同一个未类型化的载荷字段如果被 2 处以上读取，就在加第三个读取方之前，先建一个共享的类型守卫 / 归一化函数 / 投影。

---

## 什么时候该抽象

**该抽象**：

- 同一段代码出现 3 次以上
- 逻辑复杂到足以藏 bug
- 可能有多个人需要它

**不该抽象**：

- 只用一次
- 就是个一行代码
- 抽象完比重复本身还复杂

---

## 批量改动之后

当你对多个文件做了类似改动：

1. **复查**：所有实例都改到了吗？
2. **搜索**：grep 一遍找漏网的
3. **评估**：这该不该抽象出来？

### Reducer 应该用穷尽结构

当状态是从类 action 的值（`action`、`kind`、`status`、`phase`）派生出来的时候，优先用一个 `switch` 的 reducer，而不是散布各处的 `if/else`。

```typescript
// 坏 —— 按 action 分散的状态迁移很难审计
if (action === "opened") { ... }
else if (action === "comment") { ... }
else if (action === "status") { ... }

// 好 —— 迁移表由一个 reducer 独占
switch (event.action) {
  case "opened":
    ...
    return;
  case "comment":
    ...
    return;
}
```

当事件日志是事实来源时，这条尤其重要。reducer 是被文档化的重放模型；展示代码和命令层**不应该**各自复制这个重放模型的一部分。

---

## 提交前清单

- [ ] 搜过是否已有相似代码
- [ ] 没有该共享却被复制粘贴的逻辑
- [ ] 没有在共享解码器之外重复提取未类型化的载荷字段
- [ ] 常量只定义在一处
- [ ] 相似模式遵循同一套结构
- [ ] reducer / action 的状态迁移只存在于一个 reducer 或命令分发器里

---

## 坑：Python if/elif/else 没有穷尽性检查

**问题**：Python 的 if/elif/else 链没有编译期穷尽性检查。当你往一个 `Literal` 类型里加了新值，既有的 if/elif/else 链会**静默**掉进 `else`，给出错误的默认值。

**症状**：新平台只工作了一半——某些方法返回了默认值而不是该平台专属的值。**不报任何错。**

**例子**：

```python
# 坏：新增的 "gemini" 掉进 else，返回了 "claude"
@property
def cli_name(self) -> str:
    if self.platform == "opencode":
        return "opencode"
    else:
        return "claude"  # gemini 悄悄拿到了 "claude"！

# 好：每个取值都显式分支
@property
def cli_name(self) -> str:
    if self.platform == "opencode":
        return "opencode"
    elif self.platform == "gemini":
        return "gemini"
    else:
        return "claude"
```

**预防**：往 Python `Literal` 类型加新值时，搜出**所有**在该类型上分支的 if/elif/else 链，逐条补显式分支。不要指望 `else` 对新值是对的。

---

## 坑：两套不对称机制产出同一结果

**问题**：当两套不同机制必须产出同一批文件时（例如初始化用递归目录拷贝、更新用一份手写的文件清单），结构性变更（改名、移动、加子目录）只会通过**自动那套**传播。手写那套会静默漂移。

**症状**：初始化完美，但更新创建的文件路径错了，或者干脆漏掉文件。

**预防**：

- **最佳**：消灭不对称——让手写那套直接调用自动那套（例如 `collectTemplateFiles()` 去调 `getAllScripts()`，而不是自己维护一份清单）
- **不对称无法避免时**：补一个回归测试，比对两套机制的输出
- 迁移目录结构时，搜出**所有**引用旧结构的代码路径

> 上游实例（供理解模式，与本项目无关）：`trellis update` 曾为 11 个脚本维护了一份手写 `files.set()` 清单，而 `getAllScripts()` 本来就追踪了它们；修复方式是删掉重复清单，改为 `for..of getAllScripts()` 循环。

---

## 速查

```bash
# 改任何值之前先搜
grep -r "要改的值" .
```

---

## 附录：以下内容仅适用于 Trellis 上游仓库，本项目不适用

> 保留原文以便与上游对照；**读到这里可以直接跳过**，本节描述的是 Trellis 自己的 monorepo，与本项目的构建无关。

### 模板文件注册（Trellis 专用）

往 `src/templates/trellis/scripts/` 加新文件时：

**唯一的注册点**：`src/templates/trellis/index.ts`

1. 加 `export const xxxScript = readTemplate("scripts/path/file.py");`
2. 加进 `getAllScripts()` 的 Map

就这两步。`commands/update.ts` 直接使用 `getAllScripts()`，不需要手工同步。

**为什么重要**：没注册进 `getAllScripts()`，`trellis update` 就不会把该文件同步到用户项目里，bug 修复与新功能都传不下去。

**历史**：v0.4.0-beta.3 之前，`update.ts` 自己维护着一份文件清单，经常跟 `getAllScripts()` 不同步，导致 11 个 Python 文件在 `trellis update` 时被静默跳过。修复方式是删掉重复清单，以 `getAllScripts()` 为唯一事实来源。

### 模板同步约定

`.trellis/scripts/`（自举副本）与 `packages/cli/src/templates/trellis/scripts/`（模板）必须保持一致。改完 `.trellis/scripts/` 后要同步：

```bash
rsync -av --delete --exclude='__pycache__' .trellis/scripts/ packages/cli/src/templates/trellis/scripts/
```

**坑**：rsync 的源 / 目标路径写错会造出嵌套的垃圾目录（例如 `.trellis/scripts/packages/cli/...`）。执行前务必核对路径。
