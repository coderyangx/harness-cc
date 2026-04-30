# 什么是系统提示词

system prompt 不是一整块静态文本，而是一条**被逐段组装**出来的输入流水线。
它是给模型的系统级说明，它通常负责告诉模型：

- 你是谁
- 你能做什么
- 你应该遵守什么规则
- 你现在处在什么环境里

**一句话记住：**system prompt 的关键不是“写一段很长的话”，而是“把不同来源的信息按清晰边界组装起来”。

# 最小心智模型

最容易理解的方式，是把 system prompt 想成 6 段：

```
1. 核心身份和行为说明
2. 工具列表
3. skills 元信息
4. memory 内容
5. CLAUDE.md 指令链
6. 动态环境信息
```

然后按顺序拼起来：

```
core
+ tools
+ skills
+ memory
+ claude_md
+ dynamic_context
= final system prompt
```

# 最小实现结构

## 第一步：做一个 builder

```python
class SystemPromptBuilder:
    def build(self) -> str:
        parts = []
        parts.append(self._build_core())
        parts.append(self._build_tools())
        parts.append(self._build_skills())
        parts.append(self._build_memory())
        parts.append(self._build_claude_md())
        parts.append(self._build_dynamic())
        return "\n\n".join(p for p in parts if p)
```

## 第二步：每一段只负责一种来源

```
例如：
_build_tools() 只负责把工具说明生成出来
_build_memory() 只负责拿 memory
_build_claude_md() 只负责读指令文件
这样每一段的职责就很清楚。
```

## CLAUDE.md 为什么要单独一段
