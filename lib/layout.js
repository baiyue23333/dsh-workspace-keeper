/**
 * 布局规则：Agent 能在工作区的哪些位置写文件。
 *
 * 工作区契约（对应用户列的清单）：
 *
 *   tools/<工具名>/                             公共工具：其他对话也能用
 *   tools/历史工具/<原名>_<版本>_<状态>/         停用的公共工具（只读）
 *   <项目名>_<yyyy.mm.dd>_<模型名>/              项目文件夹
 *     ├── <项目名>-tools/<工具名>/               只给这个项目用的工具
 *     ├── <其他文件夹>/                          名字由 AI 自己定
 *     ├── README.md                              结构说明（插件生成维护）
 *     └── _stat.json                             模型名、创建时间（插件读写）
 *   .dsh/sessions/<会话>/                        插件暂存区（一次性产物）
 *
 * 工具命名（lib/naming.js）：<对象>-<操作>-tool；历史条目：<原名>_<版本>_<状态>。
 * 其余位置一律拒绝：根部散文件、scripts/ tmp/ 这类保留名、.tmp/.bak/.log 后缀、
 * 带 .. 的路径、工作区外的绝对路径、不按格式命名的项目文件夹。
 */
import { parseHistoryName } from './naming.js'

export const TOOLS_DIR = 'tools'
export const HISTORY_DIR = TOOLS_DIR + '/历史工具'
export const DEFAULT_STASH = '.dsh/sessions'
export const MANIFEST_NAME = 'tool-manifest.json'
export const STAT_NAME = '_stat.json'
export const README_NAME = 'README.md'

/** 保留的顶层名字：以前最容易被拿来堆垃圾的地方。 */
export const ROOT_RESERVED = [
  'src/', 'app/', 'lib/', 'scripts/', 'temp/', 'tmp/', 'misc/', 'other/', 'notes/', 'docs/', 'out/', 'output/', 'test/', 'tests/',
]

/** 不收的后缀。 */
export const BANNED_EXT = ['.tmp', '.bak', '.old', '.orig', '.log', '.pyc', '.swp', '.lock']

/** 项目文件夹：<项目名>_<yyyy.mm.dd>_<模型名>，下划线分段。 */
export const PROJECT_RE = /^(.+)_(\d{4}\.\d{2}\.\d{2})_([^_]+)$/

/** 抹平反斜杠和开头的 ./，方便按 / 分段。 */
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

/** 日期段是否是合法的 yyyy.mm.dd。 */
function validDate(date) {
  const bits = date.split('.').map(Number)
  const y = bits[0]
  const mo = bits[1]
  const d = bits[2]
  return y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31
}

/** 是不是合法的项目文件夹名。 */
export function parseProjectFolder(name) {
  const m = PROJECT_RE.exec(String(name == null ? '' : name))
  if (m === null) return false
  if (/[\/\s]/.test(m[1]) || /[\/\s]/.test(m[3])) return false
  return validDate(m[2])
}

/**
 * 判断一个目标路径能不能写。
 * @param {string} raw 相对工作区根部的路径
 * @param {{allow?: string[], projects?: string[]}} opts
 *   allow：额外放行的相对前缀；projects：已存在的项目文件夹名
 * @returns {{ok: boolean, kind?: string, rel?: string, project?: string, tool?: string, reason?: string, hint?: string}}
 */
export function classify(raw, opts = {}) {
  const rel = normalize(raw)
  if (rel === '') return deny('空路径', '给 write/edit 一个文件路径')
  if (/^[A-Za-z]:\//.test(rel) || rel.startsWith('/')) {
    return deny('不能写工作区之外的绝对路径', '请写工作区内路径，如 tools/bash-executor-tool/run.py')
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
    if (ext === '') return deny('工作区根部不允许新建文件夹', '公共工具放 tools/<工具名>/，一次性文件放 .dsh/sessions/<会话>/')
    return deny('工作区根部不收散文件', '公共工具放 tools/<工具名>/，一次性文件放 .dsh/sessions/<会话>/')
  }
  if (ROOT_RESERVED.includes(top + '/') || top === '.git') {
    return deny('这个文件夹是保留名，不收新文件', '公共工具放 tools/<工具名>/，一次性文件放 .dsh/sessions/<会话>/')
  }

  if (top === TOOLS_DIR) {
    if (parts.length < 2) return deny('tools/ 下面要落到具体工具文件夹', '改为 tools/<工具名>/<文件>')
    if (parts[1] === '历史工具') {
      if (parts.length < 3) return deny('历史工具里要落到具体条目', '由 workspace_tools_archive 生成')
      if (parseHistoryName(parts[2]) === undefined) {
        return deny('历史条目要按 <原名>_<版本>_<状态> 命名：' + parts[2], '例如 bash-executor_v1_broken')
      }
      return deny('历史条目只读', '要复活就复制回 tools/<工具名>/，不要直接改历史件')
    }
    if (parts.length === 2) return deny('公共工具必须有自己的文件夹', '改为 tools/<工具名>/<文件>')
    if (BANNED_EXT.includes(ext)) return deny('工具目录不收临时或日志文件', '清理后再放进来')
    return { ok: true, kind: 'shared', rel, tool: parts[1] }
  }

  if (top === '.dsh') {
    if (parts.length < 3) return deny('.dsh/ 下面要落到具体会话文件夹', '一次性文件放 .dsh/sessions/<会话>/')
    if (parts[1] !== 'sessions') return deny('.dsh/ 只收 sessions/', '一次性文件放 .dsh/sessions/<会话>/')
    if (BANNED_EXT.includes(ext)) return deny('暂存区只放临时产物', '日志和备份别留')
    return { ok: true, kind: 'stash', rel }
  }

  const projects = opts.projects == null ? [] : opts.projects
  if (!projects.includes(top)) {
    if (parseProjectFolder(top)) return deny('项目文件夹还没建', '先建文件夹 ' + top + '/，或在已有项目文件夹里干活')
    return deny('文件夹不允许：' + top, '公共工具放 tools/<工具名>/；项目文件放 <项目名>_<yyyy.mm.dd>_<模型名>/；一次性文件放 .dsh/sessions/<会话>/')
  }

  if (parts.length === 2) {
    if (BANNED_EXT.includes(ext)) return deny('项目文件夹不收临时或日志文件', '临时文件放 .dsh/sessions/<会话>/')
    return { ok: true, kind: 'project-pass', rel, project: top }
  }
  const projName = top.replace(/_\d{4}\.\d{2}\.\d{2}_[^_]+$/, '')
  if (parts[1] === projName + '-tools') {
    if (parts.length === 3) return deny('项目工具也要有自己的文件夹', '改为 <项目名>-tools/<工具名>/<文件>')
    if (BANNED_EXT.includes(ext)) return deny('工具目录不收临时或日志文件', '清理后再放进来')
    return { ok: true, kind: 'project-tool', rel, project: top, tool: parts[2] }
  }
  if (BANNED_EXT.includes(ext)) return deny('项目文件夹不收临时或日志文件', '临时文件放 .dsh/sessions/<会话>/')
  return { ok: true, kind: 'project-nested', rel, project: top }
}

/** 从项目文件夹名拆出项目名、日期、模型名。 */
export function parseProject(name) {
  const m = PROJECT_RE.exec(String(name == null ? '' : name))
  return m === null ? undefined : { name: m[1], date: m[2], model: m[3] }
}

/** 项目文件夹名。 */
export function projectFolderName(name, date, model) {
  return name + '_' + date + '_' + model
}

/** 今天日期串 yyyy.mm.dd。 */
export function today() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate())
}
