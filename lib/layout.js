/**
 * 布局规则：Agent 能在哪些位置写文件。
 *
 * 工作区契约（根部见 roots.json，工作区内部见 workspaceEntries）：
 *
 *   <根部>/<doc>                      根部文档（登记为 kind: doc）
 *   <根部>/plugins/<插件>/             插件
 *   <工作区>/外部支持/<组件>/          共享外部组件（ComfyUI、Git…）
 *   <工作区>/sunloom/                 常驻资产：长寿命工程
 *   <工作区>/tools/<对象>-<操作>-tool/ 公共工具
 *   <工作区>/<项目名>_<日期>_<模型名>/  一次性项目
 *   <工作区>/.dsh/sessions/<会话>/     会话暂存区
 *
 * 所有"能写的位置"都必须先在 roots.json 登记（项目文件夹靠命名规则隐式识别）。
 * 没登记的顶层条目一律拒绝——所以新东西要能写，先登记。
 */
import { parseHistoryName } from './naming.js'
import { resolve, REGISTRY_NAME, FILE_KINDS } from './roots.js'

export const TOOLS_DIR = 'tools'
export const HISTORY_DIR = TOOLS_DIR + '/历史工具'
export const SESSIONS_DIR = '.dsh/sessions'
export const MANIFEST_NAME = 'tool-manifest.json'
export const STAT_NAME = '_stat.json'
export const README_NAME = 'README.md'

/** 项目里禁止的分类名：这些名字等于「我不知道归哪」，会变成黑洞。 */
export const FORBIDDEN_DIRS = ['其它', '其他', '杂项', '临时', 'temp', 'tmp', 'misc', 'other', 'stuff', '新建文件夹']

/** 不收的后缀。 */
export const BANNED_EXT = ['.tmp', '.bak', '.old', '.orig', '.log', '.pyc', '.swp', '.lock']

/** Windows 保留设备名（不区分大小写）。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export const PROJECT_RE = /^(.+)_(\d{4}\.\d{2}\.\d{2})_([^_]+)$/

export function normalize(rel) {
  return String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/')
}

export function extOf(p) {
  const base = p.slice(p.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

export function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1)
}

function deny(reason, hint) {
  return { ok: false, reason, hint }
}

function validDate(date) {
  const [y, mo, d] = date.split('.').map(Number)
  if (y < 2000 || y > 2100) return false
  if (mo < 1 || mo > 12) return false
  const days = new Date(y, mo, 0).getDate()
  return d >= 1 && d <= days
}

/** 是不是合法的项目文件夹名 <项目名>_<yyyy.mm.dd>_<模型名>。 */
export function parseProjectFolder(name) {
  const m = PROJECT_RE.exec(String(name == null ? '' : name))
  if (m === null) return false
  if (/[\\/\s]/.test(m[1]) || /[\\/\s]/.test(m[3])) return false
  return validDate(m[2])
}

/** 名字能不能当文件夹/文件的一段：Windows 非法字符、保留名、结尾点或空格都不行。 */
export function segmentProblem(name) {
  const s = String(name == null ? '' : name)
  if (s === '') return '名字不能为空'
  if (/[<>:"/\\|?*]/.test(s)) return '含 Windows 非法字符 <>:"/\\|?*'
  if (RESERVED_NAMES.test(s)) return '是 Windows 保留设备名'
  if (/[. ]$/.test(s)) return '不能以点或空格结尾'
  if (s.length > 64) return '太长（>64 字符）'
  return undefined
}

/** 把任意文本折成可用的一段（用于模型名等）。 */
export function safeSegment(text) {
  const t = String(text == null ? '' : text).trim()
    .replace(/[<>:"/\\|?*\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (t === '' || RESERVED_NAMES.test(t)) return '未标注'
  return t.slice(0, 64)
}

/**
 * 工作区内部的判断。
 * @param {string} raw 相对工作区的路径
 * @param {{workspaceEntries?: object, projects?: string[], allow?: string[], sessionId?: string}} opts
 */
export function classifyWorkspace(raw, opts = {}) {
  const rel = normalize(raw)
  if (rel === '') return deny('空路径', '给 write/edit 一个文件路径')
  if (/^[A-Za-z]:\//.test(rel) || rel.startsWith('/')) {
    return deny('不能写工作区之外的绝对路径', '请写工作区内路径')
  }
  if (rel.split('/').includes('..')) return deny('路径里不能有 ..', '请写工作区内路径')
  for (const a of opts.allow == null ? [] : opts.allow) {
    const n = normalize(a)
    if (rel === n || rel.startsWith(n + '/')) return { ok: true, kind: 'allowlisted', rel }
  }

  const parts = rel.split('/')
  const top = parts[0]
  const ext = extOf(rel)
  if (parts.length === 1) {
    if (BANNED_EXT.includes(ext) || ext === '') return deny('工作区根部不收散文件', '放进项目或在 roots.json 登记')
    return deny('工作区根部不收散文件', '放进项目文件夹，或在 roots.json 的 workspaceEntries 里登记')
  }
  if (BANNED_EXT.includes(ext)) return deny('不收临时或日志文件（' + ext + '）', '清理后再放，或用 .dsh/sessions')

  const entries = opts.workspaceEntries == null ? {} : opts.workspaceEntries
  const entry = entries[top]

  // 1) 登记过的常驻资产
  if (entry !== undefined) {
    if (entry.access === 'ro') return deny(top + ' 是只读区', '换个可写位置')
    if (entry.kind === 'tools') return classifyTools(rel, parts)
    if (entry.kind === 'sessions') return classifySessions(rel, parts, opts.sessionId)
    if (entry.kind === 'asset' || entry.kind === 'workspace') {
      if (parts.length < 2) return deny(top + ' 是目录，必须写到目录里', '改为 ' + top + '/<文件>')
      return { ok: true, kind: entry.kind, rel, top }
    }
    return { ok: true, kind: entry.kind, rel, top }
  }

  // 2) 项目文件夹（按名字识别）
  if (parseProjectFolder(top)) {
    return classifyProject(rel, parts)
  }

  return deny('未登记的文件夹：' + top, '项目用 <项目名>_<yyyy.mm.dd>_<模型名> 命名；常驻资产先在 roots.json 的 workspaceEntries 登记')
}

function classifyTools(rel, parts) {
  if (parts.length < 2) return deny('tools/ 下面要落到具体工具文件夹', '改为 tools/<工具名>/<文件>')
  if (parts[1] === '历史工具') {
    if (parts.length < 3) return deny('历史工具里要落到具体条目', '由 workspace_tools_archive 生成')
    if (parseHistoryName(parts[2]) === undefined) {
      return deny('历史条目要按 <原名>_<版本>_<状态> 命名：' + parts[2], '例如 bash-executor_v1_broken')
    }
    return deny('历史条目只读', '要复活就复制回 tools/<工具名>/')
  }
  if (parts.length === 2) return deny('公共工具必须有自己的文件夹', '改为 tools/<工具名>/<文件>')
  return { ok: true, kind: 'tools', rel, top: 'tools', tool: parts[1] }
}

function classifySessions(rel, parts, sessionId) {
  // parts: ['.dsh', 'sessions', '<会话>', ...]
  if (parts.length < 3) return deny('.dsh/sessions 下面要落到具体会话文件夹', '用当前会话 id 建目录')
  if (parts[1] !== 'sessions') return deny('.dsh/ 只收 sessions/', '一次性产物放 .dsh/sessions/<会话>/')
  if (parts.length < 4) return deny('会话目录里要放具体文件', '改为 .dsh/sessions/<会话>/<文件>')
  const who = parts[2]
  if (sessionId !== undefined && sessionId !== '' && who !== sessionId) {
    return deny('这是别的会话的目录（' + who + '）', '用你自己的会话 id：' + sessionId)
  }
  return { ok: true, kind: 'sessions', rel, top: '.dsh', session: who }
}

function classifyProject(rel, parts) {
  const top = parts[0]
  const projName = top.replace(/_\d{4}\.\d{2}\.\d{2}_[^_]+$/, '')
  if (parts.length === 2) return { ok: true, kind: 'project-root', rel, project: top }
  const sub = parts[1]
  if (FORBIDDEN_DIRS.includes(sub.toLowerCase()) || FORBIDDEN_DIRS.includes(sub)) {
    return deny('项目里不许建「' + sub + '」这种万能抽屉', '按内容起名，或放进 .dsh/sessions/<会话>/')
  }
  if (sub === projName + '-tools') {
    if (parts.length === 3) return deny('项目工具也要有自己的文件夹', '改为 <项目名>-tools/<工具名>/<文件>')
    return { ok: true, kind: 'project-tools', rel, project: top, tool: parts[2] }
  }
  if (segmentProblem(sub) !== undefined) return deny('文件夹名不合规：' + segmentProblem(sub), '换一个名字')
  return { ok: true, kind: 'project', rel, project: top }
}

/**
 * 顶层入口：先把相对根部的路径落到登记表，再交给工作区内部规则。
 * @param {string} raw 相对根部路径
 * @param {{registry?: object, allow?: string[], projects?: string[], sessionId?: string}} opts
 */
export function classifyEntry(raw, opts = {}) {
  const rel = normalize(raw)
  if (rel === '') return deny('空路径', '给 write/edit 一个文件路径')
  if (/^[A-Za-z]:\//.test(rel) || rel.startsWith('/')) {
    return deny('不能写根部之外的绝对路径', '请写相对根部的路径，如 workflow/tools/<工具名>/run.py')
  }
  const parts = rel.split('/')
  if (parts.includes('..')) return deny('路径里不能有 ..', '请写相对根部的路径')

  const hit = resolve(opts.registry, parts)
  if (!hit.ok) return deny(hit.reason, hit.hint)

  if (hit.entry.kind === 'workspace') {
    const inner = classifyWorkspace(hit.rest.join('/'), {
      workspaceEntries: opts.registry === undefined ? {} : opts.registry.workspaceEntries,
      allow: opts.allow,
      projects: opts.projects,
      sessionId: opts.sessionId,
    })
    return { ...inner, top: hit.name }
  }
  if (FILE_KINDS.includes(hit.entry.kind)) {
    return { ok: true, kind: hit.entry.kind, rel, top: hit.name }
  }
  if (hit.entry.kind === 'plugin' || hit.entry.kind === 'asset' || hit.entry.kind === 'external' || hit.entry.kind === 'project') {
    if (BANNED_EXT.includes(extOf(rel))) return deny('这下面不收临时或日志文件', '临时文件放 workflow/.dsh/sessions/<会话>/')
    return { ok: true, kind: hit.entry.kind, rel, top: hit.name }
  }
  return { ok: true, kind: hit.entry.kind, rel, top: hit.name }
}

export function parseProject(name) {
  const m = PROJECT_RE.exec(String(name == null ? '' : name))
  return m === null ? undefined : { name: m[1], date: m[2], model: m[3] }
}

export function projectFolderName(name, date, model) {
  return name + '_' + date + '_' + model
}

export function today() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate())
}
