import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
let fail = 0
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail += 1 }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-r-'))
const ws = path.join(root, 'workflow')
fs.mkdirSync(ws, { recursive: true })
fs.mkdirSync(path.join(root, 'plugins', 'dsh-x'), { recursive: true })
fs.mkdirSync(path.join(root, 'comfy'), { recursive: true })
fs.writeFileSync(path.join(root, 'roots.json'), JSON.stringify({ version: 1, workspace: 'workflow', entries: {
  workflow: { kind: 'workspace', access: 'rw', note: '项目与工具' },
  plugins: { kind: 'plugin', access: 'rw', note: 'DSH 插件' },
  comfy: { kind: 'external', access: 'ro', note: 'ComfyUI' },
} }, null, 2))
const tools = new Map()
let gate
const agent = { id: 'a1', session: { requestHeader: () => ({ config: { model: 'deepseek/vl 2' } }) } }
const ctx = {
  workingDirectory: { ensure: async () => root },
  systemPrompt: { section: () => {}, getSectionOrder: () => 1 },
  tools: { register: (d) => tools.set(d.name, d) },
  get: () => undefined,
  on: (ev, fn) => { if (ev === 'tools/pre-execute') gate = fn },
}
apply(ctx, {})
ok(tools.size === 6, '六个工具：' + [...tools.keys()].join(','))
const p = async (f) => gate({ name: 'write', arguments: { file_path: f }, agent }, async () => ({ kind: 'allow' }))
ok((await p('x.py')).kind === 'deny', '根部散文件被拒')
ok((await p('plugins/dsh-x/index.js')).kind === 'allow', '插件可写')
ok((await p('comfy/ComfyUI/main.py')).kind === 'deny', 'comfy 只读')
ok((await p('workarea/a')).kind === 'deny', '未登记顶层被拒')
ok((await p('workflow/tools/a-tool/run.py')).kind === 'allow', '工作区工具放行')
const r = await tools.get('workspace_project_create').execute({ name: '测试项目' }, { agent })
ok(r.text.includes('测试项目_'), '建项目')
ok(/测试项目_[0-9.]+_deepseek-vl-2/.test(r.text), '模型名清洗成 deepseek-vl-2：' + r.text.split('\n')[0])
const rl = await tools.get('workspace_roots_list').execute({}, { agent })
ok(rl.text.includes('plugins') && rl.text.includes('可写') && rl.text.includes('external'), 'roots_list 列出登记：\n' + rl.text)
console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)