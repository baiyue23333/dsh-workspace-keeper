/**
 * 真实清单测试：拿 A:\workflow\dsh 的**实际目录**跑分类器，
 * 断言「每一个应当可写的真实路径都必须放行，每一个已知的坏位置都必须拒绝」。
 *
 * 这防的是上一版整类错误：夹具照着代码写，代码错则夹具跟着错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { classifyEntry, parseProjectFolder } from '../lib/layout.js'
import { readRegistry } from '../lib/roots.js'
import { listShared, listProjects } from '../lib/manifest.js'

const ROOT = 'A:/workflow/dsh'
let fail = 0
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail += 1 }

const registry = readRegistry(ROOT)
ok(registry !== undefined, '读到 roots.json')
if (registry === undefined) { console.log('中止：没有登记表'); process.exit(1) }
ok(Array.isArray(Object.keys(registry.workspaceEntries)) || typeof registry.workspaceEntries === 'object', '有 workspaceEntries')

const wsRoot = path.join(ROOT, registry.workspace)
const projects = listProjects(wsRoot)
const sessionId = 'real-inventory-session'

// 1) 工作区里每一个真实存在的常驻资产，都必须可写
for (const name of Object.keys(registry.workspaceEntries)) {
  const abs = path.join(wsRoot, name)
  if (!fs.existsSync(abs)) { console.log('SKIP  ' + name + '（不存在）'); continue }
  const isDir = fs.statSync(abs).isDirectory()
  const probe = name === '.dsh'
    ? 'workflow/.dsh/sessions/' + sessionId + '/x.txt'
    : 'workflow/' + name + (isDir ? '/__probe__/x.txt' : '')
  const r = classifyEntry(probe, { registry, projects, sessionId })
  ok(r.ok === true, '常驻资产可写：' + name + (r.ok ? '' : ' ← ' + r.reason))
}

// 2) 根部每一个登记过的 doc 文件，都必须可写
for (const [name, e] of Object.entries(registry.entries)) {
  if (e.kind !== 'doc') continue
  const r = classifyEntry(name, { registry, projects, sessionId })
  ok(r.ok === true, '根部文档可写：' + name + (r.ok ? '' : ' ← ' + r.reason))
}

// 3) 真实项目里的正常位置可写
for (const p of projects) {
  const base = p.replace(/_\d{4}\.\d{2}\.\d{2}_[^_]+$/, '')
  for (const rel of [p + '/README.md', p + '/' + base + '-tools/x-tool/a.py']) {
    const r = classifyEntry('workflow/' + rel, { registry, projects, sessionId })
    ok(r.ok === true, '项目内可写：' + rel + (r.ok ? '' : ' ← ' + r.reason))
  }
}

// 4) 已知坏位置必须拒绝
const bad = [
  ['workflow/__stray__.py', '工作区根部散文件'],
  ['__, 不合法', '保留'],
]
for (const p of projects) {
  bad.push(['workflow/' + p + '/其它/x.txt', '项目里的万能抽屉 其它/'])
  bad.push(['workflow/' + p + '/临时/x.txt', '项目里的万能抽屉 临时/'])
}
bad.push(['_archive/x.txt', '归档区只读'])
bad.push(['random/a.txt', '未登记顶层'])
bad.push(['workflow/.dsh/sessions/别人的会话/x.txt', '别的会话目录'])
for (const [rel, label] of bad) {
  if (rel.includes('不合法')) continue
  const r = classifyEntry(rel, { registry, projects, sessionId })
  ok(r.ok === false, '应拒绝：' + label + (r.ok ? ' ← 竟然放行' : ''))
}

console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
