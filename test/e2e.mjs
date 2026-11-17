/**
 * 端到端：拿插件自己的 apply() 组装最小 ctx 跑完整流程，
 * 并用真实名字 dsh-bash-executor-repair 验证「不合规名字被拒、改成规范名才能登记」。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let fail = 0
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) { fail += 1 } }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-e2e-'))
const tools = new Map()
const commandsSeen = []
let gate
const agent = { id: 'sess-e2e-1', session: { requestHeader: () => ({ config: { model: 'qwen-image' } }) } }
const ctx = {
  workingDirectory: { ensure: async () => root },
  systemPrompt: { section: () => {}, getSectionOrder: () => 900 },
  tools: { register: (d) => { tools.set(d.name, d) } },
  get: (svc) => svc === 'commands' ? { register: (c) => commandsSeen.push(c) } : undefined,
  on: (ev, fn) => { if (ev === 'tools/pre-execute') gate = fn },
}
const ws = path.join(root, 'workflow')
fs.mkdirSync(ws, { recursive: true })
fs.writeFileSync(path.join(root, 'roots.json'), JSON.stringify({ version: 1, workspace: 'workflow', entries: { workflow: { kind: 'workspace', access: 'rw', note: '项目与工具' } }, workspaceEntries: { tools: { kind: 'tools', access: 'rw', note: '' }, '.dsh': { kind: 'sessions', access: 'rw', note: '' }, sunloom: { kind: 'asset', access: 'rw', note: '' }, '外部支持': { kind: 'asset', access: 'rw', note: '' } } }, null, 2))
await apply(ctx, { workspaceRoot: root })
const call = (n, args) => tools.get(n).execute(args, { agent })
const expectThrow = async (p, label, needle) => {
  try { await p; ok(false, label + '（应报错）') } catch (e) { ok(needle === undefined || e.message.includes(needle), label + '：' + e.message) }
}

ok(tools.size === 6 && tools.has('workspace_roots_list'), '六个工具就位')

// 闸门
const d1 = await gate({ name: 'write', arguments: { file_path: 'notes.py' }, agent }, async () => ({ kind: 'allow' }))
ok(d1.kind === 'deny', '闸门拦住根部 notes.py')
const d2 = await gate({ name: 'write', arguments: { file_path: 'workflow/tools/bash-executor-tool/fix.ps1' }, agent }, async () => ({ kind: 'allow' }))
ok(d2.kind === 'allow', '闸门放行公共工具路径')

// 项目
const pr = await call('workspace_project_create', { name: '和服少女' })
const now = new Date()
const P = '和服少女_' + now.getFullYear() + '.' + String(now.getMonth() + 1).padStart(2, '0') + '.' + String(now.getDate()).padStart(2, '0') + '_qwen-image'
ok(pr.text.includes(P), '项目文件夹按 项目名_日期_模型 生成：' + P)
ok(fs.existsSync(path.join(ws, P, '_stat.json')) && fs.existsSync(path.join(ws, P, 'README.md')), '项目有 _stat.json 与 README')
const d3 = await gate({ name: 'write', arguments: { file_path: 'workflow/' + P + '/角色设定/表情.md' }, agent }, async () => ({ kind: 'allow' }))
ok(d3.kind === 'allow', '项目自定文件夹放行')

// 命名闸门：真实旧名必须被拒
await expectThrow(call('workspace_tools_register', { name: 'dsh-bash-executor-repair', scope: 'shared', summary: 'x', usage: 'y' }), '旧名 dsh-bash-executor-repair 被拒', '名字不合规')
await expectThrow(call('workspace_tools_register', { name: 'bash_repair', scope: 'shared', summary: 'x', usage: 'y' }), '下划线名被拒')
const r1 = await call('workspace_tools_register', { name: 'bash-executor-tool', scope: 'shared', summary: '修复 DSH bash 执行器', usage: 'pwsh fix-dsh-bash.ps1', entry: 'fix-dsh-bash.ps1' })
ok(fs.existsSync(path.join(ws, 'tools/bash-executor-tool/tool-manifest.json')), '公共工具登记落盘')
const rootReadme = fs.readFileSync(path.join(ws, 'README.md'), 'utf8')
ok(rootReadme.includes('公共工具') && rootReadme.includes(P), '根部 README 说明结构与项目')
const r2 = await call('workspace_tools_register', { name: 'pdf-merge-tool', scope: 'project', summary: '合并 PDF', usage: 'python run.py' })
ok(fs.existsSync(path.join(ws, P, '和服少女-tools/pdf-merge-tool/tool-manifest.json')), '项目工具落到 <项目名>-tools')
ok(fs.readFileSync(path.join(ws, P, 'README.md'), 'utf8').includes('pdf-merge-tool'), '项目 README 列出项目工具')
const r3 = await call('workspace_tools_list', {})
ok(r3.text.includes('bash-executor-tool') && r3.text.includes('pdf-merge-tool'), 'tools_list 两类都列')

// 归档
const beforeArchive = fs.readdirSync(path.join(ws, 'tools'))
ok(beforeArchive.includes('bash-executor-tool'), '归档前工具目录在')
const ar = await call('workspace_tools_archive', { name: 'bash-executor-tool', reason: 'dsh-ops 0.5.4 起自带修复', status: 'deprecated' })
ok(ar.text.includes('tools/历史工具/bash-executor_v1_deprecated'), '归档到 原名_版本_状态：' + ar.text)
const afterArchive = fs.readdirSync(path.join(ws, 'tools'))
ok(!afterArchive.includes('bash-executor-tool'), '归档后原工具目录消失')
ok(fs.readFileSync(path.join(ws, P, 'README.md'), 'utf8').includes('bash-executor_v1_deprecated'), '项目 README 同步历史')

// 命令
fs.writeFileSync(path.join(ws, 'stray.py'), 'x')
const cmd = commandsSeen.find((c) => c.name === 'workspace')
const res = await cmd.handler({ rawInput: 'check', session: { header: { cwd: root } } })
ok(String(res.text).includes('stray.py'), '/workspace check 抓到工作区根部散文件')
ok(String(res.text).includes('public') === false, '/workspace check 不需要额外参数')
console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
