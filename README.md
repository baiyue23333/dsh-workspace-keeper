# dsh-workspace-keeper

规制 Agent 的文件乱放，并给"对话里造出来的工具"分家。

## 根部登记表（roots.json）

规则挂在**真实根部**（`A:/workflow/dsh`），不是某一个空壳目录。根部每个顶层目录在 `roots.json` 登记：

| kind | 含义 | 默认 |
| --- | --- | --- |
| `workspace` | 工作区：项目与公共工具 | 可写 |
| `project` | 独立项目（如 sunloom） | 可写 |
| `tool` | 公共工具目录 | 可写 |
| `plugin` | 插件目录（每个插件一个文件夹） | 可写 |
| `external` | 外部依赖（comfy 等） | 只读 |
| `archive` | 归档区（_archive/_attic/_backups/scratch） | 只读 |

判断顺序：**先查登记** → 登记过按 `access` 放行/拒绝 → 未登记的顶层条目与根部散文件一律拒绝。
以后新增位置 = 在 `roots.json` 加一条登记，不改规则。

## 工作区结构

```
工作区/
├── tools/
│   ├── <对象>-<操作>-tool/            公共工具：其他对话也能用，带 tool-manifest.json
│   └── 历史工具/<原名>_<版本>_<状态>/   停用的公共工具：只读，带 why.md
├── <项目名>_<yyyy.mm.dd>_<模型名>/     项目文件夹
│   ├── <项目名>-tools/<对象>-<操作>-tool/  只给这个项目用的工具
│   ├── <其他文件夹>/                   名字由 AI 按内容自己定
│   ├── README.md                       结构说明（插件生成维护）
│   └── _stat.json                      模型名与时间（插件读写）
└── .dsh/sessions/<会话>/               插件暂存区，放一次性产物
```

写入闸门：`write` / `edit` 落盘前检查目标路径，不在上面这些位置就拒绝，并告诉 Agent 该放哪。
会被拒：根部散文件、`scripts/` `tmp/` `misc/` 等保留名、`.tmp .bak .log` 后缀、带 `..` 的路径、
工作区外绝对路径、不按 `<项目名>_<yyyy.mm.dd>_<模型名>` 命名的项目文件夹。

## 工具命名

```
<对象>-<操作>-tool
  │      │      └ 固定后缀，一眼认出是工具
  │      └ 做什么：executor / merge / crop / repair
  └ 处理什么：bash / pdf / image / session
```

小写 kebab、恰好三段。`bash-executor-tool` ✅；`bash_repair`、`Bash-repair-tool`、`dsh-bash-executor-repair` ❌。

历史条目换下划线：`<原名>_<vN>_<状态>`，状态 `broken`（跑不起来）或 `deprecated`（被替代），例如
`bash-executor_v1_broken`。同名再归档版本号自增（v2、v3），绝不覆盖。

## 工具

| 工具 | 作用 |
| --- | --- |
| `workspace_tools_register` | `scope=shared` → `tools/<名>/`；`scope=project` → 当前项目文件夹的 `<项目名>-tools/<名>/`；都写 tool-manifest.json |
| `workspace_project_create` | 建 `<项目名>_<今天>_<模型名>/`，写 README.md 与 _stat.json |
| `workspace_tools_list` | 列公共工具（带状态）、项目工具、历史工具 |
| `workspace_tools_archive` | 公共工具不能用了：整个文件夹移进 `tools/历史工具/<原名>_<版本>_<状态>/`，写 why.md |
| `workspace_readme_build` | 重建根部或某个项目的 README.md |
| `/workspace check` | 检查根部散文件、工具登记、命名是否合规 |

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不挂闸门也不注册工具 |
| `promptRules` | `true` | 是否往系统提示里加「工作区规矩」 |
| `allow` | `[]` | 额外放行的相对路径前缀 |
| `defaultModel` | `未标注` | 会话取不到模型名时，建项目文件夹用它 |

## 安装

```yaml
# profile 的 cordis.patch.yml
- insert:
    - id: dsh-workspace-keeper
      name: dsh-workspace-keeper
      config:
        enabled: true
        promptRules: true
        allow: []
```

本包自带 `cordis.patch.yml`，`dsh plugin add` 安装时会自动挂载。

## 测试

```sh
node test/naming.test.mjs   # 命名规则与历史名生成
node test/run.mjs           # 布局放行/拒绝、登记、归档、项目 README
node test/apply.test.mjs    # 桩上下文：闸门与系统提示
node test/e2e.mjs           # 全流程，含真实旧名 dsh-bash-executor-repair 被拒
```
