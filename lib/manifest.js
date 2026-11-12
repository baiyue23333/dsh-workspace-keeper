/**
 * 工作区里的工具登记、历史归档、项目说明。
 *
 * 登记值放在工具文件夹里的 tool-manifest.json：
 *   { name, summary, usage, entry, status, owner, created, updated }
 * 项目文件夹里放 README.md（结构说明 + 项目工具清单 + 历史）和 _stat.json（模型名、时间）。
 * 历史归档：tools/<名>/ → tools/历史工具/<原名>_<版本>_<状态>/，附 why.md。
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import fsx from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  TOOLS_DIR, HISTORY_DIR, MANIFEST_NAME, STAT_NAME, README_NAME,
  parseProject, parseProjectFolder, normalize,
} from './layout.js'
import { historyName, parseHistoryName } from './naming.js'


/** 目标路径在 git 仓库里是否干净（无未提交改动）。不是仓库则视为干净。 */
function hasUncommitted(root, relPath) {
  try {
    const r = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', relPath], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    if (r.status !== 0) return true
    return (r.stdout || '').trim() === ''
  } catch { return true }
}
/** 删除目录：rmSync 在 Windows 上偶发"假成功"（目录还在），用异步 rm 兜底。 */
async function removeDir(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* 下一轮 */ }
    if (!fs.existsSync(dir)) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  try {
    const r = spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true })
    if (r.status === 0 && !fs.existsSync(dir)) return true
  } catch { /* 没有 cmd */ }
  return !fs.existsSync(dir)
}

export const STATUS = ['ok', 'broken', 'draft']

function manifestPath(root, name) {
  return path.join(root, TOOLS_DIR, name, MANIFEST_NAME)
}

export function readManifest(root, name, dir) {
  const p = dir === undefined ? manifestPath(root, name) : path.join(dir, MANIFEST_NAME)
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'))
    return m !== null && typeof m === 'object' ? m : {}
  } catch {
    return {}
  }
}

export function writeManifest(dir, fields) {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, MANIFEST_NAME)
  let old = {}
  try { old = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* 新建 */ }
  const body = {
    name: fields.name,
    summary: String(fields.summary == null ? old.summary ?? '' : fields.summary),
    usage: String(fields.usage == null ? old.usage ?? '' : fields.usage),
    entry: String(fields.entry == null ? old.entry ?? '' : fields.entry),
    status: STATUS.includes(fields.status) ? fields.status : old.status ?? 'ok',
    owner: String(fields.owner == null ? old.owner ?? '' : fields.owner),
    created: old.created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
  }
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n')
  return body
}

/** tools/ 下所有公共工具文件夹（不含 历史工具、_ 开头）。 */
export function listShared(root) {
  let names = []
  try {
    names = fs.readdirSync(path.join(root, TOOLS_DIR), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { return [] }
  return names.filter((n) => n !== '历史工具' && !n.startsWith('.') && !n.startsWith('_')).sort()
}

export function listHistory(root) {
  try {
    return fs.readdirSync(path.join(root, HISTORY_DIR), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch { return [] }
}

/** 工作区根下的项目文件夹（只认合规名字）。 */
export function listProjects(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && parseProjectFolder(d.name))
      .map((d) => d.name)
      .sort()
  } catch { return [] }
}

/** 项目文件夹里的专用工具（<项目名>-tools/<工具名>）。 */
export function listProjectTools(root, project) {
  const info = parseProject(project)
  if (info === undefined) return []
  try {
    return fs.readdirSync(path.join(root, project, info.name + '-tools'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch { return [] }
}

export function readStat(root, project) {
  try { return JSON.parse(fs.readFileSync(path.join(root, project, STAT_NAME), 'utf8')) } catch { return undefined }
}

export function writeStat(root, project, fields) {
  const info = parseProject(project)
  const dir = path.join(root, project)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, STAT_NAME)
  let old = {}
  try { old = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* 新建 */ }
  const body = {
    name: info === undefined ? project : info.name,
    date: info === undefined ? '' : info.date,
    model: fields.model ?? (info === undefined ? '' : info.model),
    created: old.created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
  }
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n')
  return body
}

/** 复制目录树（不跟符号链接），返回文件数。 */
export function copyTree(from, to) {
  let n = 0
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) n += copyTree(src, dst)
    else if (entry.isFile()) { fs.copyFileSync(src, dst); n += 1 }
  }
  return n
}

/**
 * 把公共工具移进 tools/历史工具/<原名>_<版本>_<状态>/。
 * 名字按 naming.historyName 生成，已占用的版本号自动跳过，绝不覆盖。
 * @returns {{ok: true, id: string, files: number} | {ok: false, reason: string}}
 */
export async function archiveTool(root, name, opts = {}) {
  const status = opts.status === 'deprecated' ? 'deprecated' : 'broken'
  if (name === '历史工具') return { ok: false, reason: '历史工具本身不能归档' }
  const src = path.join(root, TOOLS_DIR, name)
  let st
  try { st = fs.statSync(src) } catch { return { ok: false, reason: '没有这个公共工具：' + name } }
  if (!st.isDirectory()) return { ok: false, reason: '不是文件夹：' + name }
  const id = historyName(name, status, listHistory(root))
  const dst = path.join(root, HISTORY_DIR, id)
  let files = 0
  try { files = copyTree(src, dst) } catch (e) { return { ok: false, reason: '复制失败：' + e.message } }
  const parsed = parseHistoryName(id)
  const why = [
    '# ' + name + ' 的历史件 ' + id,
    '',
    '- 归档时间：' + new Date().toISOString(),
    '- 状态：' + (parsed === undefined ? status : parsed.status),
    '- 归档原因：' + String(opts.reason == null ? '不可用' : opts.reason),
    '- 会话：' + String(opts.session == null ? '-' : opts.session),
    '- 文件数：' + files,
    '',
    '要复活：复制回 tools/' + name + '/，再把 tool-manifest.json 的 status 改回 ok。',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dst, 'why.md'), why)
  // 历史交给 git：未提交就不许删，否则真丢东西
  if (!hasUncommitted(root, path.join(TOOLS_DIR, name))) {
    return { ok: false, reason: '这个工具还有未提交的改动，先 git commit 再归档（历史交给 git，不靠复制）' }
  }

  const removed = await removeDir(src)
  if (!removed) return { ok: false, reason: '已复制到历史，但原目录删不掉（多半被杀软/句柄占用）：' + name + '，稍后重试 workspace_tools_archive 或手动删 tools/' + name }
  return { ok: true, id, files }
}

function whyOf(root, id) {
  try {
    const t = fs.readFileSync(path.join(root, HISTORY_DIR, id, 'why.md'), 'utf8')
    const m = /- 归档原因：(.+)/.exec(t)
    return m === null ? '' : m[1].trim()
  } catch { return '' }
}

function toolLine(dir, m) {
  return '- \x60' + m.name + '\x60 · ' + (m.summary || '（缺 tool-manifest.json 的 summary）') + '｜用法：' + (m.usage || '-') + '｜状态：' + (m.status || '-')
}

/** 项目文件夹的 README.md 文本。 */
export function renderProjectReadme(root, project) {
  const info = parseProject(project)
  const stat = readStat(root, project)
  const projTools = listProjectTools(root, project)
  const lines = [
    '# ' + (info === undefined ? project : info.name),
    '',
    '> 由 dsh-workspace-keeper 生成维护；手改会在下次重建时被覆盖。',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    '| 项目 | ' + (info === undefined ? project : info.name) + ' |',
    '| 日期 | ' + (info === undefined ? '-' : info.date) + ' |',
    '| 模型 | ' + (stat?.model || (info === undefined ? '-' : info.model)) + ' |',
    '| 文件夹 | ' + project + '/ |',
    '',
    '## 结构',
    '',
    '| 路径 | 放什么 |',
    '| --- | --- |',
    '| ' + (info === undefined ? '<项目名>' : info.name) + '-tools/<工具名>/ | 只给这个项目用的工具（命名 <对象>-<操作>-tool，带 tool-manifest.json） |',
    '| 其他文件夹 | 项目资料，名字由 AI 按内容自己定 |',
    '| README.md | 本文件 |',
    '| _stat.json | 模型名与时间，插件读写 |',
    '',
    '## 项目工具（' + projTools.length + '）',
    '',
  ]
  if (projTools.length === 0) lines.push('（还没有）')
  for (const t of projTools) {
    const m = readManifest(root, t, path.join(root, project, (info?.name ?? project) + '-tools', t))
    lines.push(toolLine(t, m))
  }
  lines.push('', '## 公共工具（全局，' + listShared(root).length + '）', '')
  for (const t of listShared(root)) lines.push(toolLine(t, readManifest(root, t)))
  if (listShared(root).length === 0) lines.push('（还没有）')
  lines.push('', '## 历史工具（' + listHistory(root).length + '）', '')
  for (const h of listHistory(root)) lines.push('- \x60tools/历史工具/' + h + '/\x60 ' + whyOf(root, h))
  if (listHistory(root).length === 0) lines.push('（还没有）')
  lines.push('')
  return lines.join('\n')
}

/** 覆盖写项目 README.md，返回文本。 */
export function writeProjectReadme(root, project) {
  const text = renderProjectReadme(root, project)
  fs.writeFileSync(path.join(root, project, README_NAME), text)
  return text
}

/** 工作区根部的 README.md：说明整体结构。 */
export function writeRootReadme(root) {
  const projects = listProjects(root)
  const lines = [
    '# 工作区',
    '',
    '> 由 dsh-workspace-keeper 生成维护。',
    '',
    '| 路径 | 放什么 |',
    '| --- | --- |',
    '| \x60tools/<工具名>/\x60 | 公共工具，其他对话也能用；命名 <对象>-<操作>-tool |',
    '| \x60tools/历史工具/<原名>_<版本>_<状态>/\x60 | 停用的公共工具，只读，带 why.md |',
    '| \x60<项目名>_<yyyy.mm.dd>_<模型名>/\x60 | 项目文件夹，里面放 <项目名>-tools/ 与其他资料 |',
    '| \x60.dsh/sessions/<会话>/\x60 | 插件暂存区，放一次性产物 |',
    '',
    '## 项目（' + projects.length + '）',
    '',
  ]
  if (projects.length === 0) lines.push('（还没有）')
  for (const p of projects) {
    const info = parseProject(p)
    lines.push('- ' + p + '/ · 模型 ' + (readStat(root, p)?.model || info?.model || '-') + ' · 项目工具 ' + listProjectTools(root, p).length + ' 个')
  }
  lines.push('')
  const text = lines.join('\n')
  fs.writeFileSync(path.join(root, README_NAME), text)
  return text
}

/** 路径相对工作区根的规范形式。 */
export function rel(root, abs) {
  return normalize(path.relative(root, path.resolve(root, abs)))
}
