# dsh-workspace-keeper

> 让 AI 别再乱放文件，也让它造出来的工具各归各位。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。

Agent 干活时会不停地新建文件：一次性脚本、中间数据、验证产物。没人管的话，
根目录会慢慢长满 `test2.py`、`临时.txt`、`其它/`、`副本 (3)`。

这个插件在**落盘之前**拦一刀：位置不合规就拒绝，并告诉它该放哪。
规则不写在提示词里靠自觉，而是写成一份可以检查的登记表。

```
[workspace-keeper] 位置不允许：工作区根部不收散文件。
放进项目文件夹，或在 roots.json 的 workspaceEntries 里登记
```

---

## 一、它解决什么问题

| 症状 | 没有它 | 有它 |
| --- | --- | --- |
| 根目录堆满一次性脚本 | 每次都要人工清理 | 写不进去，提示该放哪 |
| 项目里出现 `其它/` `临时/` | 越堆越多，最后没人敢删 | 这些名字直接拒绝 |
| 对话造的工具散在各处 | 下个对话找不到，重复造 | 公共 / 项目两类，附登记文件 |
| 工具坏了直接删 | 下次遇到同样问题重新踩坑 | 归档到「历史工具」，附 `why.md` |
| 不同对话的临时文件互相覆盖 | 分不清谁的 | 按会话 id 隔离 |
| 规则靠提示词记 | 长对话就忘 | 每轮重新注入 + 落盘时强制 |

---

## 二、核心设计：登记表

规则挂在**真实根目录**，而不是某个约定的空壳目录：

```
<根>/
├── workflow/          工作区（内容都在这）
├── plugins/           插件源码
├── AGENTS.md  WORKSPACE.md  README.md  roots.json     根部文档
└── _archive/ _attic/ _backups/                        归档区（只读）
```

根部每个顶层条目都在 `roots.json` 里登记，**没登记的一律写不进去**：

```jsonc
{
  "version": 3,
  "workspace": "workflow",
  "entries": {
    "workflow":  { "kind": "workspace", "access": "rw", "note": "所有干活的东西" },
    "plugins":   { "kind": "plugin",    "access": "rw", "note": "插件源码" },
    "AGENTS.md": { "kind": "doc",       "access": "rw", "note": "对话指引" },
    "roots.json":{ "kind": "doc",       "access": "rw", "note": "本登记表" },
    "_archive":  { "kind": "archive",   "access": "ro", "note": "历史归档" }
  },
  "workspaceEntries": {
    "sunloom":   { "kind": "asset",    "access": "rw", "note": "长寿命工程，保留原名" },
    "外部支持":   { "kind": "asset",    "access": "rw", "note": "共享外部组件" },
    "tools":     { "kind": "tools",    "access": "rw", "note": "公共工具" },
    ".dsh":      { "kind": "sessions", "access": "rw", "note": "会话暂存区" }
  }
}
```

### 类别表

| kind | 含义 | 默认权限 |
| --- | --- | --- |
| `workspace` | 工作区根 | rw |
| `asset` | 常驻资产：长寿命工程、共享组件 | rw |
| `project` | 一次性项目 | rw |
| `tools` | 公共工具目录 | rw |
| `sessions` | 会话暂存区（按 id 隔离） | rw |
| `plugin` | 插件 | rw |
| `doc` | 根部单个文档文件 | rw |
| `external` | 外部依赖 | ro |
| `archive` | 归档区 | ro |

**项目文件夹不用登记**，靠命名规则 `<项目名>_<yyyy.mm.dd>_<模型名>` 隐式识别
——这样新建项目不需要先改配置。

---

## 三、规矩

### 1. 项目命名 `<项目名>_<yyyy.mm.dd>_<模型名>`

```
workflow/会话存档_2026.11.12_session工具/
├── README.md          做什么 / 产出 / 关键参数
├── _stat.json         模型名、创建时间
├── 会话存档-tools/    项目专用工具
│   └── 会话探针-tool/
└── <按内容命名的目录>/
```

只保留最新名字，**不留 `副本` `_v2` `old`** —— 历史交给 git。

### 2. 项目里禁「万能抽屉」

`其它` `其他` `杂项` `临时` `temp` `tmp` `misc` `other` `新建文件夹`

这些名字等于「我不知道归哪」，一旦存在就会无限膨胀。按内容起名，
一次性产物放 `.dsh/sessions/<会话 id>/`。

### 3. 工具分家

| 类型 | 位置 | 判据 |
| --- | --- | --- |
| 公共工具 | `workflow/tools/<对象>-<操作>-tool/` | 别的对话也会用 |
| 项目工具 | `<项目>/<项目名>-tools/<对象>-<操作>-tool/` | 只给这个项目 |
| 停用 | `workflow/tools/历史工具/<原名>_<版本>_<状态>/` | 跑不起来 / 被替代 |

工具名：**小写 kebab，恰好三段**，如 `bash-executor-tool`、`pdf-merge-tool`。
公共工具目录里必须有 `tool-manifest.json`（用途 / 用法 / 入口 / 状态）。

### 4. 会话暂存区按 id 隔离

`.dsh/sessions/<会话 id>/` —— 只能写**自己的** id，写别人的会被拒。
防止两个对话的临时文件互相覆盖。

### 5. 归档前必须 git 提交

`workspace_tools_archive` 会先跑 `git status --porcelain`，有未提交改动就拒绝
——否则「历史交给 git」就是空话，删了就真没了。

### 6. 命名禁区

禁用：空格、`<>:"/\|?*`、Windows 保留设备名（`CON` `PRN` `AUX` `NUL` `COM1`…）、
以点或空格结尾、超过 64 字符。日期按真实日历校验（`2026.02.31` 不合法）。

---

## 四、安全阀（重要）

这个插件会拦写文件，所以**必须**保证它不会把自己或整个 DSH 锁死。
三条硬性约束，全部有测试覆盖：

| 约束 | 实现 |
| --- | --- |
| DSH 配置目录永远放行 | `~/.dsh/**` 在代码里写死，不读配置 |
| 只管自己的工作区 | 只拦会话 cwd 之内的路径，之外一律不管 |
| 一句话停用 | `/workspace off` 关闭本次运行，`/workspace on` 恢复 |
| 登记表损坏时不静默放行 | 读失败 **拒绝并报错**，不是悄悄放过 |

```
/workspace check   体检：根部未登记项、项目缺件、工具登记
/workspace off     关闭闸门
/workspace on      恢复闸门
```

---

## 四之二、只能在工作区里工作（v0.2）

早期版本以**会话 cwd** 为基准：用户把会话开在外部文件夹，插件就把那里当成"根"，
agent 在外部目录照样乱塞。这是设计漏洞，已修。现在的行为：

| 写入目标 | 结果 |
| --- | --- |
| 工作区内部（登记过的位置） | 按规则放行 / 拒绝 |
| 工作区**之外**（桌面、下载、别人给的文件夹…） | **一律拒绝** |
| `~/.dsh/**`（DSH 配置） | 永远放行（安全阀） |
| 定位不到工作区 | 不拦（避免换机器直接全拒） |

拒绝时会明确告诉它怎么办：

```
[workspace-keeper] 只能在工作区里写文件。工作区是 A:\workflow\dsh，
你要写的位置在它之外：D:\别人的文件夹\out.txt。
需要引用外部内容就用相对路径去读，不要往外写。
```

**工作区根怎么定位**（按优先级）：

1. 插件配置 `workspaceRoot`
2. 从会话 cwd **向上查找** `roots.json`
3. 记忆文件 `$DSH_HOME/workspace-keeper.root`（找到根时自动写入）

三者都失败才进入"不拦"模式。这样无论是把会话开在工作区里、子目录里，
还是完全无关的盘符下，最终都落到同一个工作区。

---

## 五、提供的工具

| 工具 | 作用 |
| --- | --- |
| `workspace_tools_register` | 登记工具。`scope=shared` → `workflow/tools/`；`scope=project` → 当前项目的 `<项目名>-tools/` |
| `workspace_project_create` | 建 `<项目名>_<今天>_<模型名>/`，写 README 与 _stat.json |
| `workspace_tools_list` | 列公共工具（带状态）、项目工具、历史工具 |
| `workspace_tools_archive` | 公共工具停用：移进 `历史工具/`，写 `why.md` |
| `workspace_roots_list` | 列根部登记表 |
| `workspace_readme_build` | 重建工作区或项目 README |

---

## 六、安装

```sh
cd ~/.dsh/profiles/<你的 profile>
pnpm add link:<path-to>/dsh-workspace-keeper
```

然后在 profile 的 `dsh.profile.bundles` 里加一项：

```json
"dsh-workspace-keeper"
```

重启 DSH。首次使用前，在根部放一份 `roots.json`（参考第二节），否则所有写入都会被拒。

> 插件自带 `cordis.patch.yml`，用 `dsh plugin add` 安装时会自动挂载。

---

## 七、配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不挂闸门也不注册工具 |
| `promptRules` | `true` | 是否往系统提示注入「工作区规矩」 |
| `allow` | `[]` | 额外放行的相对路径前缀 |
| `defaultModel` | `未标注` | 取不到模型名时建项目用的占位 |

---

## 八、结构

```
dsh-workspace-keeper/
├── index.js             插件入口：闸门 + 六个工具 + /workspace 命令
├── lib/
│   ├── roots.js         登记表读取与校验
│   ├── layout.js        分类规则（根部 → 工作区 → 项目 → 工具 → 会话）
│   ├── naming.js        工具名 / 历史条目名校验
│   └── manifest.js      工具登记、归档、README 生成
├── cordis.patch.yml     挂载声明
└── test/                八套测试
```

判定顺序：

```
相对路径 → roots.resolve（根部登记） → classifyWorkspace（工作区内部）
        → 登记过的资产 / 项目命名规则 / 工具 / 会话 → 放行或拒绝
```

---

## 九、测试

```sh
node test/naming.test.mjs          # 工具名与历史条目名
node test/run.mjs                  # 布局规则 + 登记/归档
node test/apply.test.mjs           # 桩上下文：闸门与系统提示
node test/registry.test.mjs        # 登记表集成
node test/schema.test.mjs          # 工具 schema 合法（用 DSH 自己的校验器）
node test/safety.test.mjs          # 安全阀：~/.dsh 放行、off/on
node test/e2e.mjs                  # 全流程
node test/real-inventory.test.mjs  # ★ 拿真实目录跑分类器
node test/outside.test.mjs         # ★ 会话在外部目录时仍然只能写工作区
```

最后一套是重点。前面几套用的是夹具，**夹具照着代码写，代码错则夹具跟着错**。
`real-inventory` 直接扫描真实的 `roots.json` 和实际目录，断言：

- 每一个真实存在的可写路径都必须放行；
- 每一个已知坏位置都必须拒绝。

这个测试是在一次真实事故后补的：七套测试全绿，但真实工作区里有三处
（主力工程、共享组件、根部文档）被误拒——因为夹具里从来没有它们。

---

## 十、已知限制

- **只拦 `write` / `edit` / `apply_patch`**。`run_code` 里直接 `fs.writeFile`、
  shell 重定向都绕得过去，靠系统提示约束。这是 DSH 工具层的边界，插件无权接管。
- **`apply_patch` 直接拒绝**：它用补丁文本，拿不到单一路径，无法逐条校验。
- **登记表是唯一真相**。改名工作区却没改 `roots.json` 会导致误判，改完记得同步。
- 只处理 Windows 路径语义（保留名、非法字符），POSIX 下规则相同但保留名检查无意义。

---

## 十一、许可

MIT。见 [LICENSE](LICENSE)。
