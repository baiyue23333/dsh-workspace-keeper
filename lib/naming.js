/**
 * 工具命名：公共/项目工具 <对象>-<操作>-tool，历史条目 <原名>_<版本>_<状态>。
 *
 * 这套是从 dsh-bash-executor-repair 的「对象 + 动作」推出来的：
 *   - 第一段说这个工具处理什么（bash / pdf / image）
 *   - 第二段说它做什么（executor / merge / crop）
 *   - 第三段固定 tool，让检索时一眼认出是工具
 * 历史条目换下划线分段，一眼能看出是哪个工具的哪一版、为什么退下去。
 */

/** 公共/项目工具的后缀段。 */
export const TOOL_SUFFIX = 'tool'

/** 历史状态。 */
export const HISTORY_STATUS = ['broken', 'deprecated']

const SEG = /^[a-z0-9][a-z0-9]*$/
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
const VERSION = /^v\d+$/

/**
 * 校验工具名。
 * @returns {{ok: true} | {ok: false, reason: string, example: string}}
 */
export function validateToolName(name) {
  const n = String(name == null ? '' : name)
  const example = 'bash-executor-tool'
  if (!KEBAB.test(n)) return { ok: false, reason: '只能用小写字母、数字和 -：' + n, example }
  const parts = n.split('-')
  if (parts.length < 3) return { ok: false, reason: '名字至少三段：对象-操作-tool', example }
  if (parts[parts.length - 1] !== TOOL_SUFFIX) return { ok: false, reason: '最后一段必须是 ' + TOOL_SUFFIX + '：' + n, example }
  for (const p of parts) if (!SEG.test(p)) return { ok: false, reason: '每段只能是字母数字：' + p, example }
  return { ok: true }
}

/** 从公共工具名里拆出「原名」，历史归档用。 */
export function baseName(name) {
  return String(name).replace(new RegExp('-' + TOOL_SUFFIX + '$'), '')
}

/**
 * 生成历史条目名：<原名>_<版本>_<状态>。
 * 原名末尾已经有 vN 就沿用，否则从 v1 起；taken 里已占用的版本号自动往上加。
 * @returns {string}
 */
export function historyName(name, status, taken = []) {
  const used = new Set(taken)
  let base = baseName(name)
  const m = base.match(/^(.*)-v(\d+)$/)
  let n = 1
  if (m !== null) { base = m[1]; n = Number(m[2]) }
  let candidate = base + '_v' + n + '_' + status
  while (used.has(candidate)) { n += 1; candidate = base + '_v' + n + '_' + status }
  return candidate
}

/** 解析历史条目名，解析不了返回 undefined。 */
export function parseHistoryName(id) {
  const m = /^(.*)_(v\d+)_(broken|deprecated)$/.exec(String(id))
  return m === null ? undefined : { base: m[1], version: m[2], status: m[3] }
}

/** 把任意写法折成 kebab，用于提示用户正确名字。 */
export function toKebab(text) {
  return String(text == null ? '' : text)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
