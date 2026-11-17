/**
 * 安全阀测试：插件绝不能拦住 ~/.dsh 配置，也绝不能管工作区之外的路径。
 * 这是上一次把 DSH 锁死的回归防线。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let fail = 0
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail += 1 }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-safe-'))
const ws = path.join(root, 'workflow')
fs.mkdirSync(ws, { recursive: true })
fs.mkdirSync(path.join(root, 'plugins'), { recursive: true })
fs.writeFileSync(path.join(root, 'roots.json'), JSON.stringify({ version: 2, workspace: 'workflow', entries: {
  workflow: { kind: 'workspace', access: 'rw', note: '' },
  plugins: { kind: 'plugin', access: 'rw', note: '' },
  }, workspaceEntries: { tools: { kind: 'tools', access: 'rw', note: '' }, '.dsh': { kind: 'sessions', access: 'rw', note: '' } } }))

const tools = new Map()
let gate
let cmdHandler
const agent = { id: 'a1' }
const ctx = {
  workingDirectory: { ensure: async () => root },
  systemPrompt: { section: () => {}, getSectionOrder: () => 1 },
  tools: { register: (d) => tools.set(d.name, d) },
  get: (s) => s === 'commands' ? { register: (c) => { cmdHandler = c.handler } } : undefined,
  on: (ev, fn) => { if (ev === 'tools/pre-execute') gate = fn },
}
await apply(ctx, { workspaceRoot: root })
const run = async (f) => gate({ name: 'write', arguments: { file_path: f }, agent }, async () => ({ kind: 'allow' }))

// 1) DSH 配置目录永远放行
const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
ok((await run(path.join(dshHome, 'profiles', 'work', 'package.json'))).kind === 'allow', '~/.dsh 配置文件放行（防自锁）')
ok((await run(path.join(dshHome, 'logs', 'x.log'))).kind === 'allow', '~/.dsh 下任意文件放行')

// 2) 工作区外一律拒绝（这是本次改动的重点）
const outside = await run(path.join(os.tmpdir(), 'free.txt'))
ok(outside.kind === 'deny', '工作区之外的绝对路径被拒')
ok(String(outside.reason).includes('只能在工作区里写文件'), '拒绝理由说明「只能在工作区里写」')
const escape = await run(path.join(root, '..', 'escape.txt'))
ok(escape.kind === 'deny', '用 .. 逃出工作区被拒')

// 3) 工作区内部照拦
ok((await run(path.join(ws, 'stray.py'))).kind === 'deny', '工作区根部散文件仍被拦')
ok((await run(path.join(ws, 'tools', 'x-tool', 'run.py'))).kind === 'allow', '合规工具路径放行')

// 4) 紧急开关
const off = await cmdHandler({ rawInput: 'off', session: { header: { cwd: root } } })
ok(String(off.text).includes('关闭'), '/workspace off 可用')
ok((await run(path.join(ws, 'stray.py'))).kind === 'allow', 'off 之后不再拦')
const on = await cmdHandler({ rawInput: 'on', session: { header: { cwd: root } } })
ok(String(on.text).includes('开启'), '/workspace on 可恢复')
ok((await run(path.join(ws, 'stray.py'))).kind === 'deny', 'on 之后恢复拦截')

console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
