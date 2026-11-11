/**
 * 用桩上下文单独验证闸门与工具注册（不依赖临时目录之外的任何东西）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let fail = 0
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail += 1 }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-apply-'))
const tools = new Map()
const sections = []
let gate
const agent = { id: 'a1' }
const ctx = {
  workingDirectory: { ensure: async () => root },
  systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 900 },
  tools: { register: (d) => tools.set(d.name, d) },
  get: () => undefined,
  on: (ev, fn) => { if (ev === 'tools/pre-execute') gate = fn },
}
apply(ctx, {})
ok(tools.size === 5, '注册 5 个工具')
ok(sections[0]?.text.includes('tools/<工具名>'), '系统提示写明公共工具位置')
ok(sections[0]?.text.includes('<对象>-<操作>-tool'), '系统提示写明命名规则')
const p = (f) => gate({ name: 'write', arguments: { file_path: f }, agent }, async () => ({ kind: 'allow' }))
ok((await p('tmp/a.py')).kind === 'deny', 'tmp/ 被拒')
ok((await p('.dsh/sessions/s1/x.json')).kind === 'allow', '暂存区放行')
ok((await p('tools/x.py')).kind === 'deny', 'tools/ 根下散文件被拒')
console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
