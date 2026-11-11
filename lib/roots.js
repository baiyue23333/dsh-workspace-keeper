/**
 * 受管资产登记表：工作区根部（A:\workflow\dsh）里每个顶层条目一条。
 *
 * 设计要点：规则不再把"一个空壳"当成整个机器，而是先看登记表——
 *   - 登记过的目录按它的 access 放行或拒绝；
 *   - 没登记的顶层条目一律拒绝（等于"新东西必须登记才能用"）；
 *   - 根部散文件永远拒绝（README.md / 登记表本身除外）。
 *
 * 类别：project（项目，可写）/ tool（公共工具，可写）/ plugin（插件，可写）/
 *       external（外部依赖，只读）/ archive（归档区，只读）。
 */
import fs from 'node:fs'
import path from 'node:path'

export const REGISTRY_NAME = 'roots.json'
export const KINDS = ['workspace', 'project', 'tool', 'plugin', 'external', 'archive']
export const ACCESS = ['rw', 'ro']

/** 没有登记时的兜底说明（只用于报错提示）。 */
export const KIND_HINT = {
  workspace: '工作区里的项目放 <项目名>_<yyyy.mm.dd>_<模型名>/',
  project: '项目放 <项目名>_<yyyy.mm.dd>_<模型名>/',
  tool: '公共工具放 tools/<对象>-<操作>-tool/',
  plugin: '插件放 plugins/<插件名>/',
  external: '外部依赖只能读',
  archive: '归档区只能读',
}

export function registryPath(root) {
  return path.join(root, REGISTRY_NAME)
}

/** 读登记表；不存在返回 undefined。坏文件抛错，不要静默当成"全放行"。 */
export function readRegistry(root) {
  const p = registryPath(root)
  let text
  try { text = fs.readFileSync(p, 'utf8') } catch { return undefined }
  let data
  try { data = JSON.parse(text) } catch (e) { throw new Error('roots.json 不是合法 JSON：' + e.message) }
  return validateRegistry(data)
}

export function validateRegistry(data) {
  if (data === null || typeof data !== 'object') throw new Error('roots.json 顶层必须是对象')
  const entries = data.entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('roots.json 缺 entries 对象')
  const out = {}
  for (const [name, e] of Object.entries(entries)) {
    if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw new Error('roots.json 里 ' + name + ' 不是合法的顶层名字')
    }
    if (e === null || typeof e !== 'object') throw new Error('roots.json 里 ' + name + ' 的登记必须是对象')
    if (!KINDS.includes(e.kind)) throw new Error('roots.json 里 ' + name + ' 的 kind 必须是 ' + KINDS.join('/'))
    const access = e.access === undefined ? (e.kind === 'external' || e.kind === 'archive' ? 'ro' : 'rw') : e.access
    if (!ACCESS.includes(access)) throw new Error('roots.json 里 ' + name + ' 的 access 必须是 rw/ro')
    out[name] = { kind: e.kind, access, note: String(e.note ?? '') }
  }
  return { version: Number(data.version ?? 1), workspace: String(data.workspace ?? '工作区'), entries: out }
}

/** 写回登记表（保持原顺序，新条目追加）。 */
export function writeRegistry(root, registry) {
  const body = { version: registry.version ?? 1, workspace: registry.workspace ?? '工作区', entries: registry.entries }
  fs.writeFileSync(registryPath(root), JSON.stringify(body, null, 2) + '\n')
  return body
}

/**
 * 把相对路径落到登记表：返回命中的顶层条目，或 why 说明为什么不行。
 * @returns {{ok: true, name: string, entry: {kind: string, access: string, note: string}, rest: string[], workspace?: string}
 *          | {ok: false, reason: string, hint: string}}
 */
export function resolve(registry, relParts, registryFile) {
  const top = relParts[0]
  if (relParts.length === 1) {
    if (top === registryFile) return { ok: true, name: top, entry: { kind: 'external', access: 'rw', note: '登记表本身' }, rest: [] }
    return { ok: false, reason: '根部不收散文件：' + top, hint: '根部只留 ' + registryFile + '；其他东西登记到 roots.json 里对应目录下' }
  }
  const entry = registry === undefined ? undefined : registry.entries[top]
  if (entry === undefined) {
    return { ok: false, reason: '未登记的位置：' + top, hint: '先在 roots.json 里登记这个目录（kind/access），或改用已登记的目录' }
  }
  if (entry.access === 'ro') {
    return { ok: false, reason: top + ' 是只读区（' + entry.kind + '）', hint: KIND_HINT[entry.kind] ?? '换个可写位置' }
  }
  const rest = relParts.slice(1)
  // 工作区：进去之后按内部规则（项目文件夹名、tools/、历史工具/、.dsh/sessions/）
  if (entry.kind === 'workspace') return { ok: true, name: top, entry, rest, workspace: top }
  if (entry.kind === 'tool') {
    if (rest.length === 0) return { ok: false, reason: '工具必须有自己的文件夹', hint: '改为 tools/<工具名>/<文件>' }
    return { ok: true, name: top, entry, rest }
  }
  if (entry.kind === 'plugin') {
    if (rest.length < 2) return { ok: false, reason: '插件必须放在自己的文件夹里', hint: '改为 plugins/<插件名>/<文件>' }
    return { ok: true, name: top, entry, rest }
  }
  return { ok: true, name: top, entry, rest }
}
