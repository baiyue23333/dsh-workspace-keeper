/**
 * dsh-workspace-keeper — 规制 Agent 的文件乱放，并给"对话里造出来的工具"分家。
 *
 * 两半：
 *  1. 布局闸门：write / edit 落盘前拦一刀，只放行 tools/<工具>/、tools/历史工具/（只读）、
 *     项目文件夹、.dsh/sessions/<会话>/，其余一律拒并告诉它该放哪。
 *  2. 工具分家：workspace_tools_register 分公共（tools/<名>/）与项目专用
 *     （<项目文件夹>/<项目名>-tools/<名>/）；workspace_tools_archive 把坏掉的公共工具
 *     连同登记移进 tools/历史工具/<原名>_<版本>_<状态>/；workspace_readme_build 重建说明。
 *
 * 工具命名走「对象-操作-tool」（见 lib/naming.js），历史条目走「原名_版本_状态」。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  classify, normalize, ROOT_RESERVED, BANNED_EXT, TOOLS_DIR, HISTORY_DIR, README_NAME,
  parseProject, parseProjectFolder, today,
} from './lib/layout.js'
import { validateToolName, toKebab, TOOL_SUFFIX } from './lib/naming.js'
import {
  readManifest, writeManifest, listShared, listHistory, listProjects, listProjectTools,
  readStat, writeStat, archiveTool, writeProjectReadme, writeRootReadme, rel,
} from './lib/manifest.js'

export const name = 'dsh-workspace-keeper'

/** workingDirectory：解析会话 cwd 与项目；systemPrompt：挂规则段；tools：注册四个工具。 */
export const inject = ['workingDirectory', 'systemPrompt', 'tools']

export const Config = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: true },
    allow: { type: 'array', items: { type: 'string' }, default: [] },
    promptRules: { type: 'boolean', default: true },
    /** 默认模型名：会话路由里取不到模型时，建项目文件夹用它。 */
    defaultModel: { type: 'string', default: '未标注' },
  },
}

async function sessionRoot(ctx, exec) {
  try {
    const dir = exec?.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    if (typeof dir === 'string' && dir !== '') return dir
  } catch { /* 回落到进程 cwd */ }
  return process.cwd()
}

/** 会话当前用的模型名：先看请求头里的路由，再退回默认值。 */
function modelOf(exec, fallback) {
  try {
    const m = exec?.agent?.session?.requestHeader?.()?.config?.model
    if (typeof m === 'string' && m !== '') return m.replace(/[_\s/]+/g, '-')
  } catch { /* 取不到就用默认 */ }
  return fallback
}

function outText() {
  return {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_a, v) => [{ type: 'text', text: String(v.text) }],
  }
}

function rulesText() {
  return [
    '## 工作区规矩（dsh-workspace-keeper 在落盘前强制执行）',
    '',
    '工作区结构：',
    '- tools/<工具名>/ —— 公共工具，其他对话也能用；',
    '- tools/历史工具/<原名>_<版本>_<状态>/ —— 停用的公共工具，只读；',
    '- <项目名>_<yyyy.mm.dd>_<模型名>/ —— 项目文件夹：<项目名>-tools/ 放这个项目的工具，其他文件夹名字自己按内容取；',
    '- .dsh/sessions/<会话>/ —— 一次性产物，用完自己清理。',
    '',
    '工具命名：<对象>-<操作>-'+TOOL_SUFFIX+'（例：bash-executor-'+TOOL_SUFFIX+'、pdf-merge-'+TOOL_SUFFIX+'），小写 kebab，三段；',
    '工具登记用 workspace_tools_register：scope=shared 进 tools/，scope=project 进当前项目文件夹的 <项目名>-tools/；',
    '公共工具坏了、不能用了：workspace_tools_archive，status 选 broken（跑不起来）或 deprecated（被替代）。',
    '',
    '会被拒绝：根部散文件、' + ROOT_RESERVED.join(' ') + ' 这类保留名、' + BANNED_EXT.join(' ') + ' 后缀、带 .. 的路径、工作区外绝对路径、不按 <项目名>_<yyyy.mm.dd>_<模型名> 命名的项目文件夹。',
    '需要新位置先问人；确实要放行请改插件配置 allow。',
  ].join('\n')
}

export function apply(ctx, config = {}) {
  const conf = { enabled: true, allow: [], promptRules: true, defaultModel: '未标注', ...(config ?? {}) }
  if (!conf.enabled) return

  if (conf.promptRules) {
    ctx.systemPrompt.section({
      name: 'workspace-keeper',
      order: ctx.systemPrompt.getSectionOrder('FILE_REFERENCE'),
      text: rulesText(),
    })
  }

  // ── 1. 写入闸门 ─────────────────────────────────────────────────────────
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision?.kind !== 'allow') return decision
    if (exec.name !== 'write' && exec.name !== 'edit') return decision
    const raw = exec.arguments?.file_path
    if (typeof raw !== 'string' || raw.trim() === '') return decision
    const root = await sessionRoot(ctx, exec)
    const target = normalize(path.relative(root, path.isAbsolute(raw) ? raw : path.resolve(root, raw)))
    if (target === '' || target === '.') return decision
    const v = classify(target, { allow: conf.allow, projects: listProjects(root) })
    if (v.ok) return decision
    return {
      kind: 'deny',
      reason: '[workspace-keeper] 位置不允许：' + v.reason + '。' + v.hint,
      info: { source: 'dsh-workspace-keeper', rel: target, reason: v.reason, hint: v.hint },
    }
  })

  // ── 2. 工具分家 ─────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'workspace_tools_register',
    description: '登记对话里造出来的工具。scope=shared → tools/<name>/ 并写 tool-manifest.json（公共）；scope=project → 当前项目文件夹的 <项目名>-tools/<name>/（只给这个项目用）。名字必须是 <对象>-<操作>-' + TOOL_SUFFIX + '。已有文件不动，只补登记。',
    parameters: {
      name: { type: 'string', required: true, description: '工具名，<对象>-<操作>-' + TOOL_SUFFIX + '，例：pdf-merge-' + TOOL_SUFFIX },
      scope: { type: 'string', required: true, enum: ['shared', 'project'], description: 'shared=公共；project=只给当前项目' },
      summary: { type: 'string', description: '一句话用途（shared 必填）' },
      usage: { type: 'string', description: '怎么调用，例如 python run.py --in a.pdf（shared 必填）' },
      entry: { type: 'string', description: '入口文件相对工具文件夹的路径，例如 run.py' },
      project: { type: 'string', description: 'scope=project 时指定项目文件夹名；只有一个项目时可省略' },
    },
    output: outText(),
    async execute(args, exec) {
      const tool = String(args.name ?? '').trim()
      const check = validateToolName(tool)
      if (!check.ok) throw new Error('名字不合规：' + check.reason + '。正确写法如 ' + check.example)
      const root = await sessionRoot(ctx, exec)
      if (args.scope === 'shared') {
        if (!args.summary || !args.usage) throw new Error('公共工具必须写 summary 和 usage')
        const dir = path.join(root, TOOLS_DIR, tool)
        fs.mkdirSync(dir, { recursive: true })
        writeManifest(dir, { name: tool, summary: args.summary, usage: args.usage, entry: args.entry, status: 'ok', owner: 'shared' })
        writeRootReadme(root)
        return { text: '已登记公共工具 tools/' + tool + '/\n\n' + writeRootReadme(root) }
      }
      const projects = listProjects(root)
      const target = args.project !== undefined && args.project !== null && String(args.project) !== '' ? String(args.project) : (projects.length === 1 ? projects[0] : '')
      const found = projects.includes(target) ? target : undefined
      if (found === undefined) {
        throw new Error('找不到项目文件夹' + (target ? '：' + target : '') + '。现有项目：' + (projects.join('、') || '无') + '；先用 workspace_project_create 建项目，或在已有项目文件夹里干活')
      }
      const info = parseProject(found)
      const dir = path.join(root, found, info.name + '-tools', tool)
      fs.mkdirSync(dir, { recursive: true })
      writeManifest(dir, { name: tool, summary: args.summary, usage: args.usage, entry: args.entry, status: 'ok', owner: found })
      writeProjectReadme(root, found)
      return { text: '已登记项目工具 ' + found + '/' + info.name + '-tools/' + tool + '/' }
    },
  })

  ctx.tools.register({
    name: 'workspace_project_create',
    description: '建一个项目文件夹 <项目名>_<今天>_<模型名>/，写好 README.md 和 _stat.json。已有同名（同日期同模型）就复用。',
    parameters: {
      name: { type: 'string', required: true, description: '项目名，不含下划线和空格，例如 和服少女' },
      model: { type: 'string', description: '模型名；不填用会话当前模型' },
    },
    output: outText(),
    async execute(args, exec) {
      const proj = String(args.name ?? '').trim()
      if (proj === '' || /[\\/_\\s.]/.test(proj)) throw new Error('项目名不能含下划线、空格、点或路径分隔符：' + proj)
      const root = await sessionRoot(ctx, exec)
      const model = String(args.model ?? '').trim() || modelOf(exec, conf.defaultModel)
      const folder = proj + '_' + today() + '_' + model
      if (!parseProjectFolder(folder)) throw new Error('拼出来的项目文件夹名不合规：' + folder)
      fs.mkdirSync(path.join(root, folder), { recursive: true })
      writeStat(root, folder, { model })
      writeProjectReadme(root, folder)
      writeRootReadme(root)
      return { text: '项目就绪：' + folder + '/\n\n' + writeProjectReadme(root, folder) }
    },
  })

  ctx.tools.register({
    name: 'workspace_tools_list',
    description: '列出公共工具（含登记状态）、项目专用工具、历史工具。',
    parameters: {
      project: { type: 'string', description: '只看某个项目的工具；不填就列全部项目' },
    },
    output: outText(),
    async execute(args, exec) {
      const root = await sessionRoot(ctx, exec)
      const lines = ['公共工具（' + listShared(root).length + '）：']
      const shared = listShared(root)
      if (shared.length === 0) lines.push('  无')
      for (const t of shared) {
        const m = readManifest(root, t)
        lines.push('  - ' + t + '  [' + (m.status || '无登记') + ']  ' + (m.summary || '（缺 tool-manifest.json）'))
      }
      const projects = listProjects(root)
      const only = args.project === undefined ? undefined : String(args.project)
      lines.push('', '项目：')
      if (projects.length === 0) lines.push('  无')
      for (const p of projects) {
        if (only !== undefined && p !== only) continue
        const info = parseProject(p)
        const ts = listProjectTools(root, p)
        lines.push('  - ' + p + '（模型 ' + (readStat(root, p)?.model || info.model) + '）')
        for (const t of ts) {
          const m = readManifest(root, t, path.join(root, p, info.name + '-tools', t))
          lines.push('      · ' + t + '  [' + (m.status || '无登记') + ']  ' + (m.summary || ''))
        }
      }
      const hist = listHistory(root)
      lines.push('', '历史工具（' + hist.length + '）：' + (hist.length === 0 ? '无' : ''))
      for (const h of hist) lines.push('  - ' + h)
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'workspace_tools_archive',
    description: '公共工具不能用了时，把它整个文件夹移进 tools/历史工具/<原名>_<版本>_<状态>/ 并写 why.md，原位置清空。',
    parameters: {
      name: { type: 'string', required: true, description: '要归档的公共工具名' },
      reason: { type: 'string', required: true, description: '为什么不能用了' },
      status: { type: 'string', description: 'broken=跑不起来（默认）；deprecated=被替代' },
    },
    output: outText(),
    async execute(args, exec) {
      const root = await sessionRoot(ctx, exec)
      const r = archiveTool(root, String(args.name), { reason: args.reason, status: args.status, session: exec.agent?.id })
      if (!r.ok) throw new Error(r.reason)
      writeRootReadme(root)
      for (const p of listProjects(root)) writeProjectReadme(root, p)
      return { text: '已归档 → tools/历史工具/' + r.id + '/（' + r.files + ' 个文件）' }
    },
  })

  ctx.tools.register({
    name: 'workspace_readme_build',
    description: '按当前目录重建说明：不填 project 就重建工作区根部 README.md，填了重建该项目的 README.md。',
    parameters: {
      project: { type: 'string', description: '项目文件夹名，例如 和服少女_2026.11.12_deepseek-flash' },
    },
    output: outText(),
    async execute(args, exec) {
      const root = await sessionRoot(ctx, exec)
      if (args.project === undefined || args.project === null || String(args.project) === '') {
        return { text: writeRootReadme(root) }
      }
      const p = String(args.project)
      if (!listProjects(root).includes(p)) throw new Error('没有这个项目文件夹：' + p)
      return { text: writeProjectReadme(root, p) }
    },
  })

  // ── 3. /workspace check ─────────────────────────────────────────────────
  const commands = ctx.get?.('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'workspace',
      description: '检查工作区布局与工具登记：check',
      input: { hint: 'check' },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim()
        if (raw !== '' && raw !== 'check') return { kind: 'success', text: '用法：/workspace check' }
        const root = invocation?.session?.header?.cwd ?? process.cwd()
        const bad = []
        let entries = []
        try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return { kind: 'error', text: '读不到工作区：' + root } }
        for (const e of entries) {
          if (e.isDirectory()) {
            if (e.name !== TOOLS_DIR && e.name !== '.dsh' && !(e.name.startsWith('.') && e.name !== '.dsh') && !parseProjectFolder(e.name)) {
              bad.push(e.name + '/（不是合规的项目文件夹）')
            }
          } else if (e.name !== README_NAME) {
            bad.push(e.name + '（根部只收项目文件夹和 README.md）')
          }
        }
        for (const t of listShared(root)) {
          const m = readManifest(root, t)
          if (m.summary === undefined) bad.push('tools/' + t + '/（缺 tool-manifest.json）')
          if (!validateToolName(t).ok) bad.push('tools/' + t + '/（名字不是 <对象>-<操作>-' + TOOL_SUFFIX + '）')
        }
        const msg = bad.length === 0
          ? '工作区正常：' + listShared(root).length + ' 个公共工具，' + listProjects(root).length + ' 个项目，' + listHistory(root).length + ' 个历史工具。'
          : '发现问题 ' + bad.length + ' 处：\n' + bad.map((b) => '  - ' + b).join('\n')
        return { kind: 'success', text: msg }
      },
    })
  }
}
