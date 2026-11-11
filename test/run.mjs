/**
 * 布局规则 + 登记/归档/项目说明的单元测试。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyWorkspace, parseProjectFolder, parseProject, projectFolderName } from '../lib/layout.js'
import { listShared, listHistory, listProjects, listProjectTools, writeManifest, writeStat, archiveTool, writeProjectReadme, writeRootReadme } from '../lib/manifest.js'

let fail = 0
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail += 1 }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'))
const P = '和服少女_2026.11.12_qwen-image'
fs.mkdirSync(path.join(root, P, '和服少女-tools'), { recursive: true })

// —— 布局 ——
ok(parseProjectFolder(P), '合规项目文件夹名')
ok(!parseProjectFolder('项目名_yyyy.mm.dd_模型名 2'), '占位副本名不合规')
ok(!parseProjectFolder('项目_2026-11-12_x'), '横线日期不合规（清单用点）')
ok(!parseProjectFolder('项目_2026.13.12_x'), '非法月份不合规')
ok(parseProject(projectFolderName('和服少女', '2026.11.12', 'qwen-image')).model === 'qwen-image', '项目名拆分正确')

const opts = { projects: [P] }
const cases = [
  ['tools/bash-executor-tool/run.py', true, '公共工具'],
  ['tools/历史工具/bash-executor_v1_broken/why.md', false, '历史只读'],
  ['tools/历史工具/工具/run.py', false, '历史名不合规'],
  ['tools/x.py', false, '公共工具必须有文件夹'],
  ['' + P + '/README.md', true, '项目 README'],
  ['和服少女-tools 里缺项目名/' + '', false, '无意义路径'],
  [P + '/和服少女-tools/pdf-merge-tool/run.py', true, '项目工具'],
  [P + '/和服少女-tools/run.py', false, '项目工具必须有文件夹'],
  [P + '/角色设定/表情.md', true, '项目自定文件夹'],
  [P + '/x.tmp', false, '项目不收 tmp'],
  ['.dsh/sessions/s1/a.json', true, '暂存区'],
  ['x.py', false, '根部散文件'],
  ['other.md', false, '根部其他 md'],
  ['scripts/a.py', false, '保留名'],
  ['别的项目_2026.01.01_x/a.md', false, '未建项目文件夹'],
  ['random/a.md', false, '未登记文件夹'],
  ['../escape.txt', false, '带 ..'],
  ['C:/Windows/x.txt', false, '绝对路径'],
]
for (const [p, want, label] of cases) {
  if (p === '') continue
  const r = classifyWorkspace(p, opts)
  ok(r.ok === want, label + '：' + p + (r.ok ? '' : ' → ' + r.reason))
}

// —— 登记 / 归档 / 项目说明 ——
const sharedDir = path.join(root, 'tools', 'bash-executor-tool')
fs.mkdirSync(sharedDir, { recursive: true })
fs.writeFileSync(path.join(sharedDir, 'run.ps1'), 'echo hi')
writeManifest(sharedDir, { name: 'bash-executor-tool', summary: '修复 bash 执行器', usage: 'pwsh run.ps1', entry: 'run.ps1' })
ok(listShared(root).includes('bash-executor-tool'), '列出公共工具')
writeStat(root, P, { model: 'qwen-image' })
const projDir = path.join(root, P, '和服少女-tools', 'pdf-merge-tool')
fs.mkdirSync(projDir, { recursive: true })
writeManifest(projDir, { name: 'pdf-merge-tool', summary: '合并 PDF', usage: 'python run.py' })
ok(listProjectTools(root, P).includes('pdf-merge-tool'), '列出项目工具')
const pr = writeProjectReadme(root, P)
ok(pr.includes('bash-executor-tool') && pr.includes('pdf-merge-tool') && pr.includes('qwen-image'), '项目 README 含公共/项目工具与模型')
ok(fs.existsSync(path.join(root, P, 'README.md')), '项目 README 落盘')
ok(writeRootReadme(root).includes(P), '根部 README 列出项目')
const a = await archiveTool(root, 'bash-executor-tool', { reason: '0.5.4 起自带修复', status: 'deprecated' })
ok(a.ok && a.id === 'bash-executor_v1_deprecated', '归档名 原名_版本_状态：' + (a.id ?? a.reason))
ok(!fs.existsSync(sharedDir), '归档后原目录消失')
ok(fs.existsSync(path.join(root, 'tools/历史工具', a.id, 'why.md')), '历史件带 why.md')
const b = await archiveTool(root, 'nope', { reason: 'x' })
ok(b.ok === false, '归档不存在的工具被拒')
fs.mkdirSync(path.join(root, 'tools', 'dup-tool'), { recursive: true })
writeManifest(path.join(root, 'tools', 'dup-tool'), { name: 'dup-tool', summary: 'x', usage: 'y' })
const c1 = await archiveTool(root, 'dup-tool', { reason: 'x', status: 'broken' })
fs.mkdirSync(path.join(root, 'tools', 'dup-tool'), { recursive: true })
writeManifest(path.join(root, 'tools', 'dup-tool'), { name: 'dup-tool', summary: 'x', usage: 'y' })
const c2 = await archiveTool(root, 'dup-tool', { reason: 'x', status: 'broken' })
ok(c1.id === 'dup_v1_broken' && c2.id === 'dup_v2_broken', '撞名版本自增：' + c1.id + ' → ' + c2.id)
ok(listHistory(root).length === 3, '历史列表 3 条')
console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
