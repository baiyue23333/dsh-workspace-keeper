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
import z from '@deepseek-ai/schemastery'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import {
  classifyEntry, normalize, FORBIDDEN_DIRS, BANNED_EXT, TOOLS_DIR, HISTORY_DIR, README_NAME,
  parseProject, parseProjectFolder, today, segmentProblem, safeSegment,
} from './lib/layout.js'
import { validateToolName, toKebab, TOOL_SUFFIX } from './lib/naming.js'
import { readRegistry, writeRegistry, KIND_HINT } from './lib/roots.js'
import {
  readManifest, writeManifest, listShared, listHistory, listProjects, listProjectTools,
  readStat, writeStat, archiveTool, writeProjectReadme, writeRootReadme, rel,
} from './lib/manifest.js'

export const name = 'dsh-workspace-keeper'

/** workingDirectory：解析会话 cwd 与项目；systemPrompt：挂规则段；tools：注册四个工具。 */
export const inject = ['workingDirectory', 'systemPrompt', 'tools']

export const Config = z.object({
  enabled: z.boolean().default(true),
  allow: z.array(z.string()).default([]),
  promptRules: z.boolean().default(true),
  defaultModel: z.string().default('未标注'),
  /** 固定工作区根（含 roots.json 的目录）。不填则从会话 cwd 向上找，再查记忆文件。 */
  workspaceRoot: z.string().default(''),
})

/** 用户配置目录（$DSH_HOME 或 ~/.dsh）：永远放行，防止插件把自己锁死。 */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env)
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  return path.resolve(home, '.dsh')
}

function isInDshHome(raw) {
  try {
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw)
    const home = dshHome()
    const rel = path.relative(home, abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  } catch { return false }
}

/** child 是否在 parent 目录内（含相等）。 */
function isInside(parent, child) {
  try {
    const rel = path.relative(path.resolve(parent), path.resolve(child))
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  } catch { return false }
}

/** 记忆文件：记录本机的工作区根，保证在外部目录开会话也能定位。 */
function rootPointerFile() {
  return path.join(dshHome(), 'workspace-keeper.root')
}

function readRootPointer() {
  try {
    const t = fs.readFileSync(rootPointerFile(), 'utf8').trim()
    return t === '' ? undefined : t
  } catch { return undefined }
}

function writeRootPointer(root) {
  try { fs.writeFileSync(rootPointerFile(), root) } catch { /* 只读环境就算了 */ }
}

/** 从某个目录往上找含 roots.json 的目录。 */
function findRootUpward(start, maxDepth = 8) {
  let dir = path.resolve(start)
  for (let i = 0; i <= maxDepth; i += 1) {
    if (fs.existsSync(path.join(dir, 'roots.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return undefined
}

/**
 * 解析工作区根（含 roots.json 的目录）。优先级：
 *   1. 插件配置 workspaceRoot
 *   2. 从会话 cwd 向上找 roots.json
 *   3. 记忆文件 ~/.dsh/workspace-keeper.root
 * 找到 2 或 3 以外的结果会写回记忆文件。
 */
async function resolveRoot(ctx, exec, conf) {
  const configured = typeof conf?.workspaceRoot === 'string' ? conf.workspaceRoot.trim() : ''
  if (configured !== '') {
    const abs = path.resolve(configured)
    if (fs.existsSync(path.join(abs, 'roots.json'))) return abs
  }
  const cwd = await sessionRoot(ctx, exec)
  const found = findRootUpward(cwd)
  if (found !== undefined) { writeRootPointer(found); return found }
  const remembered = readRootPointer()
  if (typeof remembered === 'string' && fs.existsSync(path.join(remembered, 'roots.json'))) return remembered
  return undefined
}

async function workspaceRoot(root, created) {
  let registry
  try { registry = readRegistry(root) } catch { registry = undefined }
  const ws = path.join(root, registry === undefined ? 'workflow' : registry.workspace)
  if (created) fs.mkdirSync(ws, { recursive: true })
  return ws
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
    if (typeof m === 'string' && m !== '') return safeSegment(m)
  } catch { /* 取不到就用默认 */ }
  return fallback
}

/** 当前会话的稳定 id（用于 .dsh/sessions/<id>/ 隔离）。 */
function sessionKeyOf(exec) {
  const id = exec?.agent?.session?.id ?? exec?.agent?.id
  if (typeof id !== 'string' || id === '') return undefined
  return id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64)
}

function outText() {
  return {
    schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', description: '结果说明' } } },
    render: (_a, v) => [{ type: 'text', text: String(v.text) }],
  }
}

function rulesText(root) {
  const where = root === undefined ? '工作区' : root
  return [
    '## 工作区规矩（dsh-workspace-keeper 在落盘前强制执行）',
    '',
    '**你只能在 ' + where + ' 里面写文件。**',
    '工作区之外的任何路径（别的磁盘、桌面、下载目录、别人给的文件夹）**一律只读**：',
    '需要那里的内容，就用相对路径或绝对路径去**读**，然后把结果写到工作区里，不要往外写。',
    '',
    '工作区里能写的位置（都在 roots.json 登记过）：',
    '- 外部支持/<组件>/ —— 共享外部组件（ComfyUI、Git）；',
    '- sunloom/ —— 常驻工程，保留原名；',
    '- tools/<对象>-<操作>-tool/ —— 公共工具；tools/历史工具/<原名>_<版本>_<状态>/ 只读；',
    '- <项目名>_<yyyy.mm.dd>_<模型名>/ —— 一次性项目，里面放 <项目名>-tools/ 与按内容命名的目录；',
    '- .dsh/sessions/<你自己的会话 id>/ —— 一次性产物，别写进别人的会话目录。',
    '',
    '工具命名：<对象>-<操作>-tool，小写 kebab，三段，例如 bash-executor-tool。',
    '登记公共工具用 workspace_tools_register（scope=shared / project）；',
    '公共工具不能用了用 workspace_tools_archive（原目录未提交 git 会被拒）。',
    '',
    '项目里禁止：' + FORBIDDEN_DIRS.join('、') + ' 这类万能抽屉；' + BANNED_EXT.join(' ') + ' 后缀；带 .. 的路径。',
    '遇到故障先翻 tools/ 里现成的工具，别从零写；修完还复发说明根因没找到，把结论写回那个工具的 README。',
  ].join('\n')
}



function assertSupportedSchema(schema, path = 'schema') {
  if (schema === null || typeof schema !== 'object') throw new Error('[workspace-keeper] ' + path + ' 不是 schema 对象')
  const type = schema.type
  if (Object.hasOwn(schema, 'required') && type !== undefined && type !== 'object') {
    throw new Error('[workspace-keeper] ' + path + '.required 只能放在对象上；' + type + ' 类型要用对象级 required 数组')
  }
  const props = schema.properties
  if (props && typeof props === 'object') {
    for (const [k, v] of Object.entries(props)) assertSupportedSchema(v, path + '.properties.' + k)
  }
  if (schema.items) assertSupportedSchema(schema.items, path + '.items')
  for (const k of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[k])) schema[k].forEach((v, i) => assertSupportedSchema(v, path + '.' + k + '[' + i + ']'))
  }
}

export async function apply(ctx, config = {}) {
  const conf = { enabled: true, allow: [], promptRules: true, defaultModel: '未标注', workspaceRoot: '', ...(config ?? {}) }
  if (!conf.enabled) return

  if (conf.promptRules) {
    ctx.systemPrompt.section({
      name: 'workspace-keeper',
      order: ctx.systemPrompt.getSectionOrder('FILE_REFERENCE'),
      text: rulesText(await resolveRoot(ctx, undefined, conf)),
    })
  }

  // ── 1. 写入闸门 ─────────────────────────────────────────────────────────
  // 约束：
  //   a) 用户配置目录 ~/.dsh/** 永远放行（代码写死，不读配置）——防止把 DSH 锁死；
  //   b) 只拦「会话 cwd」之内的路径，工作区外一律不管；
  //   c) /workspace off 可以一句命令停用；
  //   d) 登记表读不出来时**拒绝**并报错，不静默放行。
  const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch'])
  let gateEnabled = conf.enabled !== false
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (!gateEnabled) return decision
    if (decision?.kind !== 'allow') return decision
    if (!WRITE_TOOLS.has(exec.name)) return decision
    const raw = exec.arguments?.file_path ?? exec.arguments?.path
    // apply_patch 用补丁文本，拿不到单一路径 -> 直接要求改用 write/edit
    if (typeof raw !== 'string' || raw.trim() === '') {
      if (exec.name === 'apply_patch') {
        return { kind: 'deny', reason: '[workspace-keeper] apply_patch 不做路径校验，请改用 write / edit。', info: { source: 'dsh-workspace-keeper' } }
      }
      return decision
    }

    // 安全阀：DSH 配置目录永远放行，插件不能把 DSH 锁死
    if (isInDshHome(raw)) return decision

    const root = await resolveRoot(ctx, exec, conf)
    // 定位不到工作区就不拦（否则换台机器直接全拒）
    if (root === undefined) return decision

    const abs = path.isAbsolute(raw) ? raw : path.resolve(root, raw)
    // 只能在工作区里写：外部目录一律拒绝，并告诉它该怎么引用
    if (!isInside(root, abs)) {
      return {
        kind: 'deny',
        reason: '[workspace-keeper] 只能在工作区里写文件。工作区是 ' + root
          + '，你要写的位置在它之外：' + abs
          + '。需要引用外部内容就**用相对路径去读**（例如 ../外部支持/... 或绝对路径读），不要往外写。',
        info: { source: 'dsh-workspace-keeper', root, attempted: abs },
      }
    }
    const target = normalize(path.relative(root, abs))
    if (target === '' || target === '.') return decision

    let registry
    try { registry = readRegistry(root) } catch (e) {
      return { kind: 'deny', reason: '[workspace-keeper] roots.json 损坏，拒绝落盘：' + e.message, info: { source: 'dsh-workspace-keeper', rel: target } }
    }
    if (registry === undefined) {
      return { kind: 'deny', reason: '[workspace-keeper] 找不到 roots.json，无法判断位置是否合规', info: { source: 'dsh-workspace-keeper', rel: target } }
    }
    const wsRoot = path.join(root, registry.workspace)
    const v = classifyEntry(target, {
      registry,
      allow: conf.allow,
      projects: listProjects(wsRoot),
      sessionId: sessionKeyOf(exec),
    })
    if (v.ok) return decision
    return {
      kind: 'deny',
      reason: '[workspace-keeper] 位置不允许：' + v.reason + '。' + v.hint,
      info: { source: 'dsh-workspace-keeper', rel: target, reason: v.reason, hint: v.hint },
    }
  })

  // ── 2. 工具分家 ─────────────────────────────────────────────────────────
  // 只校验本插件注册的工具；不要改写共享的 ctx.tools.register，否则会破坏
  // Agent preset 的作用域，把后续工具错误地转发到全局注册器。
  const registerTool = (definition, options) => {
    assertSupportedSchema(definition.parameters)
    if (definition.output && definition.output.schema !== undefined) assertSupportedSchema(definition.output.schema)
    return ctx.tools.register(definition, options)
  }

  registerTool({
    name: 'workspace_tools_register',
    description: '登记对话里造出来的工具。scope=shared → tools/<name>/ 并写 tool-manifest.json（公共）；scope=project → 当前项目文件夹的 <项目名>-tools/<name>/（只给这个项目用）。名字必须是 <对象>-<操作>-' + TOOL_SUFFIX + '。已有文件不动，只补登记。',
    parameters: { type: 'object', additionalProperties: false, required: ['name', 'scope'], properties: {
      name: { type: 'string', description: '工具名，<对象>-<操作>-' + TOOL_SUFFIX + '，例：pdf-merge-' + TOOL_SUFFIX },
      scope: { type: 'string', enum: ['shared', 'project'], description: 'shared=公共；project=只给当前项目' },
      summary: { type: 'string', description: '一句话用途（shared 必填）' },
      usage: { type: 'string', description: '怎么调用，例如 python run.py --in a.pdf（shared 必填）' },
      entry: { type: 'string', description: '入口文件相对工具文件夹的路径，例如 run.py' },
      project: { type: 'string', description: 'scope=project 时指定项目文件夹名；只有一个项目时可省略' }, } },
    output: outText(),
    async execute(args, exec) {
      const tool = String(args.name ?? '').trim()
      const check = validateToolName(tool)
      if (!check.ok) throw new Error('名字不合规：' + check.reason + '。正确写法如 ' + check.example)
      const base = await resolveRoot(ctx, exec, conf)
      if (base === undefined) throw new Error('找不到工作区（含 roots.json 的目录）。请把会话开在工作区内，或在插件配置里设 workspaceRoot')
      const root = await workspaceRoot(base, true)
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

  registerTool({
    name: 'workspace_project_create',
    description: '建一个项目文件夹 <项目名>_<今天>_<模型名>/，写好 README.md 和 _stat.json。已有同名（同日期同模型）就复用。',
    parameters: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string', description: '项目名，不含下划线和空格，例如 和服少女' },
      model: { type: 'string', description: '模型名；不填用会话当前模型' }, } },
    output: outText(),
    async execute(args, exec) {
      const proj = String(args.name ?? '').trim()
      const bad = segmentProblem(proj) ?? (/[_\s.]/.test(proj) ? '不能含下划线、空格或点' : undefined)
      if (bad !== undefined) throw new Error('项目名不合规（' + bad + '）：' + proj)
      const baseC = await resolveRoot(ctx, exec, conf)
      if (baseC === undefined) throw new Error('找不到工作区（含 roots.json 的目录）')
      const root = await workspaceRoot(baseC, true)
      const model = safeSegment(String(args.model ?? '').trim() || modelOf(exec, conf.defaultModel))
      const folder = proj + '_' + today() + '_' + model
      if (!parseProjectFolder(folder)) throw new Error('拼出来的项目文件夹名不合规：' + folder)
      fs.mkdirSync(path.join(root, folder), { recursive: true })
      writeStat(root, folder, { model })
      writeProjectReadme(root, folder)
      writeRootReadme(root)
      return { text: '项目就绪：' + folder + '/\n\n' + writeProjectReadme(root, folder) }
    },
  })

  registerTool({
    name: 'workspace_tools_list',
    description: '列出公共工具（含登记状态）、项目专用工具、历史工具。',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {
      project: { type: 'string', description: '只看某个项目的工具；不填就列全部项目' }, } },
    output: outText(),
    async execute(args, exec) {
      const raw = await resolveRoot(ctx, exec, conf)
      if (raw === undefined) throw new Error('找不到工作区（含 roots.json 的目录）')
      const root = await workspaceRoot(raw, false)
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

  registerTool({
    name: 'workspace_tools_archive',
    description: '公共工具不能用了时，把它整个文件夹移进 tools/历史工具/<原名>_<版本>_<状态>/ 并写 why.md，原位置清空。',
    parameters: { type: 'object', additionalProperties: false, required: ['name', 'reason'], properties: {
      name: { type: 'string', description: '要归档的公共工具名' },
      reason: { type: 'string', description: '为什么不能用了' },
      status: { type: 'string', description: 'broken=跑不起来（默认）；deprecated=被替代' }, } },
    output: outText(),
    async execute(args, exec) {
      const baseD = await resolveRoot(ctx, exec, conf)
      if (baseD === undefined) throw new Error('找不到工作区（含 roots.json 的目录）')
      const root = await workspaceRoot(baseD, true)
      const name = String(args.name)
      // 先重建说明：重建时会读工具目录（Windows 上目录句柄未释放会导致随后的删除失败）
      writeRootReadme(root)
      for (const p of listProjects(root)) writeProjectReadme(root, p)
      const r = await archiveTool(root, name, { reason: args.reason, status: args.status, session: exec.agent?.id })
      if (!r.ok) throw new Error(r.reason)
      // 归档后再重建一遍说明，让项目 README 也记上这条历史
      writeRootReadme(root)
      for (const p of listProjects(root)) writeProjectReadme(root, p)
      return { text: '已归档 → tools/历史工具/' + r.id + '/（' + r.files + ' 个文件）' }
    },
  })

  registerTool({
    name: 'workspace_roots_list',
    description: '列出根部登记表 roots.json 的内容：每个顶层目录的类别（workspace/project/tool/plugin/external/archive）与可写性。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: outText(),
    async execute(_args, exec) {
      const base = await resolveRoot(ctx, exec, conf)
      if (base === undefined) throw new Error('找不到工作区（含 roots.json 的目录）')
      const root = await workspaceRoot(base, false)
      let registry
      try { registry = readRegistry(base) } catch (e) { throw new Error('roots.json 解析失败：' + e.message) }
      if (registry === undefined) return { text: '根部还没有 roots.json。' + base }
      const rows = Object.entries(registry.entries).sort((a, b) => a[0].localeCompare(b[0]))
      const lines = ['根部：' + root, '工作区：' + registry.workspace, '', '| 目录 | 类别 | 可写 | 说明 |', '| --- | --- | --- | --- |']
      for (const [name, e] of rows) lines.push('| ' + name + ' | ' + e.kind + ' | ' + (e.access === 'rw' ? '可写' : '只读') + ' | ' + (e.note || '') + ' |')
      return { text: lines.join('\n') }
    },
  })

  registerTool({
    name: 'workspace_readme_build',
    description: '按当前目录重建说明：不填 project 就重建工作区根部 README.md，填了重建该项目的 README.md。',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {
      project: { type: 'string', description: '项目文件夹名，例如 和服少女_2026.11.12_deepseek-flash' }, } },
    output: outText(),
    async execute(args, exec) {
      const baseB = await resolveRoot(ctx, exec, conf)
      if (baseB === undefined) throw new Error('找不到工作区（含 roots.json 的目录）')
      const root = await workspaceRoot(baseB, true)
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
      description: '工作区：check 检查布局 / off 关闭闸门 / on 恢复闸门',
      input: { hint: 'check | off | on' },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim()
        // 紧急开关：拦错东西时一句命令停掉自己，不依赖改文件
        if (raw === 'off') {
          gateEnabled = false
          return { kind: 'success', text: '工作区闸门已关闭（本次运行有效）。要恢复：/workspace on' }
        }
        if (raw === 'on') {
          gateEnabled = true
          return { kind: 'success', text: '工作区闸门已开启。' }
        }
        if (raw !== '' && raw !== 'check') return { kind: 'success', text: '用法：/workspace check | off | on' }
        const root = invocation?.session?.header?.cwd ?? process.cwd()
        const bad = []
        let registry
        try { registry = readRegistry(root) } catch (e) { return { kind: 'error', text: 'roots.json 解析失败：' + e.message } }
        if (registry === undefined) {
          bad.push('缺 roots.json（根部登记表），所有顶层目录都视为未登记')
        } else {
          let entries = []
          try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return { kind: 'error', text: '读不到根部：' + root } }
          for (const e of entries) {
            if (e.name.startsWith('.')) continue
            if (registry.entries[e.name] === undefined) bad.push(e.name + (e.isDirectory() ? '/' : '') + '（根部未登记，登记到 roots.json 或移进工作区）')
          }
        }
        const ws = registry === undefined ? path.join(root, 'workflow') : path.join(root, registry.workspace)
        let wsEntries = []
        try { wsEntries = fs.readdirSync(ws, { withFileTypes: true }) } catch { /* 工作区还没建 */ }
        for (const e of wsEntries) {
          if (e.isDirectory()) {
            if (e.name !== TOOLS_DIR && e.name !== '.dsh' && !e.name.startsWith('.') && !parseProjectFolder(e.name)) bad.push(registry.workspace + '/' + e.name + '/（不是合规的项目文件夹）')
          } else if (e.name !== README_NAME) {
            bad.push(registry.workspace + '/' + e.name + '（工作区根部只收项目文件夹和 README.md）')
          }
        }
        for (const t of listShared(ws)) {
          const m = readManifest(ws, t)
          if (m.summary === undefined) bad.push(registry.workspace + '/tools/' + t + '/（缺 tool-manifest.json）')
          if (!validateToolName(t).ok) bad.push(registry.workspace + '/tools/' + t + '/（名字不是 <对象>-<操作>-' + TOOL_SUFFIX + '）')
        }
        const msg = bad.length === 0
          ? '正常：' + (registry === undefined ? 0 : Object.keys(registry.entries).length) + ' 条根部登记，' + listShared(ws).length + ' 个公共工具，' + listProjects(ws).length + ' 个项目，' + listHistory(ws).length + ' 个历史工具。'
          : '发现问题 ' + bad.length + ' 处：\n' + bad.map((b) => '  - ' + b).join('\n')
        return { kind: 'success', text: msg }
      },
    })
  }
}
