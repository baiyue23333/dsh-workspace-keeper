/**
 * 受管资产登记表：根部（A:\workflow\dsh）与工作区内部各顶层条目各一条。
 *
 * - 登记过的路径按 kind + access 放行或拒绝；没登记的一律拒绝；
 * - 根部允许 doc 类单文件（AGENTS.md / WORKSPACE.md / README_目录.md / roots.json）；
 * - 工作区内部用 workspaceEntries 登记常驻资产（sunloom、外部支持、tools、.dsh）；
 * - 项目文件夹不登记，由命名规则 <项目名>_<yyyy.mm.dd>_<模型名> 隐式识别。
 *
 * kind：workspace / asset / project / tools / sessions / plugin / doc / external / archive
 */
import fs from 'node:fs'
import path from 'node:path'

export const REGISTRY_NAME = 'roots.json'
export const KINDS = ['workspace', 'asset', 'project', 'tools', 'sessions', 'plugin', 'doc', 'external', 'archive']
export const ACCESS = ['rw', 'ro']
/** 只描述单个文件、不描述目录的类别。 */
export const FILE_KINDS = ['doc']

export const KIND_HINT = {
  workspace: '工作区里的项目放 <项目名>_<yyyy.mm.dd>_<模型名>/',
  asset: '常驻资产需在登记表里声明后才能写',
  project: '项目放 <项目名>_<yyyy.mm.dd>_<模型名>/',
  tools: '公共工具放 workflow/tools/<对象>-<操作>-tool/',
  sessions: '一次性产物放 workflow/.dsh/sessions/<会话>/',
  plugin: '插件放 plugins/<插件名>/',
  doc: '根部文档直接写',
  external: '外部依赖只能读',
  archive: '归档区只能读',
}

export function registryPath(root) {
  return path.join(root, REGISTRY_NAME)
}

/** 读登记表；不存在返回 undefined；坏文件抛错（调用方必须拒绝，不能静默放行）。 */
export function readRegistry(root) {
  const p = registryPath(root)
  let text
  try { text = fs.readFileSync(p, 'utf8') } catch { return undefined }
  let data
  try { data = JSON.parse(text) } catch (e) { throw new Error(REGISTRY_NAME + ' 不是合法 JSON：' + e.message) }
  return validateRegistry(data)
}

function checkEntries(where, entries) {
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error(REGISTRY_NAME + ' 的 ' + where + ' 必须是对象')
  }
  const out = {}
  for (const [name, e] of Object.entries(entries)) {
    if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw new Error(REGISTRY_NAME + ' 里 ' + name + ' 不是合法的名字')
    }
    if (e === null || typeof e !== 'object') throw new Error(REGISTRY_NAME + ' 里 ' + name + ' 的登记必须是对象')
    if (!KINDS.includes(e.kind)) throw new Error(REGISTRY_NAME + ' 里 ' + name + ' 的 kind 必须是 ' + KINDS.join('/'))
    const access = e.access === undefined ? (e.kind === 'external' || e.kind === 'archive' ? 'ro' : 'rw') : e.access
    if (!ACCESS.includes(access)) throw new Error(REGISTRY_NAME + ' 里 ' + name + ' 的 access 必须是 rw/ro')
    out[name] = { kind: e.kind, access, note: String(e.note ?? '') }
  }
  return out
}

export function validateRegistry(data) {
  if (data === null || typeof data !== 'object') throw new Error(REGISTRY_NAME + ' 顶层必须是对象')
  const entries = checkEntries('entries', data.entries)
  const workspaceEntries = data.workspaceEntries === undefined
    ? {}
    : checkEntries('workspaceEntries', data.workspaceEntries)
  return {
    version: Number(data.version ?? 1),
    workspace: String(data.workspace ?? 'workflow'),
    entries,
    workspaceEntries,
  }
}

export function writeRegistry(root, registry) {
  const body = {
    version: registry.version ?? 1,
    workspace: registry.workspace ?? 'workflow',
    entries: registry.entries,
    workspaceEntries: registry.workspaceEntries ?? {},
  }
  fs.writeFileSync(registryPath(root), JSON.stringify(body, null, 2) + '\n')
  return body
}

function deny(reason, hint) {
  return { ok: false, reason, hint }
}

/**
 * 把相对根部的路径落到登记表（只管根部这一层，工作区内部交给 layout）。
 */
export function resolve(registry, relParts) {
  const top = relParts[0]
  const entry = registry === undefined ? undefined : registry.entries[top]
  if (entry === undefined) {
    if (relParts.length === 1) {
      return deny('根部不收未登记的文件：' + top, '根部只留登记过的文件；新文件先在 ' + REGISTRY_NAME + ' 里登记')
    }
    return deny('未登记的位置：' + top, '先在 ' + REGISTRY_NAME + ' 里登记（kind/access），或改用已登记的目录')
  }
  if (entry.access === 'ro') return deny(top + ' 是只读区（' + entry.kind + '）', KIND_HINT[entry.kind] ?? '换个可写位置')
  const rest = relParts.slice(1)
  if (FILE_KINDS.includes(entry.kind)) {
    if (rest.length > 0) return deny(top + ' 是文件，不是目录', '别在它下面建东西')
    return { ok: true, name: top, entry, rest }
  }
  if (rest.length === 0) return deny(top + ' 是目录，必须写到目录里', '改为 ' + top + '/<文件>')
  return { ok: true, name: top, entry, rest }
}
