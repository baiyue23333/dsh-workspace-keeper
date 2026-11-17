/**
 * 外部工作场景：会话 cwd 不在工作区内时，插件仍然只允许写工作区。
 * 这防的是「给个外部文件夹，agent 就在那里乱塞」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 隔离：本测试会写「工作区指针」，必须写到临时 DSH_HOME，别污染真实环境
const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-home-'))
process.env.DSH_HOME = isoHome

const { apply } = await import('../index.js')

let fail = 0
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail += 1 }

// 工作区（带 roots.json）与一个完全无关的外部目录
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-ws-'))
fs.mkdirSync(path.join(ws, 'workflow', 'tools'), { recursive: true })
fs.writeFileSync(path.join(ws, 'roots.json'), JSON.stringify({
  version: 3, workspace: 'workflow',
  entries: { workflow: { kind: 'workspace', access: 'rw', note: '' } },
  workspaceEntries: { tools: { kind: 'tools', access: 'rw', note: '' }, '.dsh': { kind: 'sessions', access: 'rw', note: '' } },
}))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-outside-'))

async function makeKeeper(cwd, extra = {}) {
  const tools = new Map()
  let gate
  const ctx = {
    workingDirectory: { ensure: async () => cwd },
    systemPrompt: { section: () => {}, getSectionOrder: () => 1 },
    tools: { register: (d) => tools.set(d.name, d) },
    get: () => undefined,
    on: (ev, fn) => { if (ev === 'tools/pre-execute') gate = fn },
  }
  await apply(ctx, { workspaceRoot: ws, ...extra })
  const run = (f) => gate({ name: 'write', arguments: { file_path: f }, agent: { id: 'a', session: { id: 's1' } } }, async () => ({ kind: 'allow' }))
  return { tools, run }
}

// 会话开在外部目录，但有记忆文件/配置指向工作区 -> 仍然只能写工作区
const k1 = await makeKeeper(outside)
ok((await k1.run(path.join(outside, '乱塞.txt'))).kind === 'deny', '会话在外部目录时，往外部写被拒')
ok((await k1.run(path.join(ws, 'workflow', 'tools', 'x-tool', 'a.py'))).kind === 'allow', '同一会话往工作区写放行')
ok((await k1.run(path.join(ws, '.civitai_token'))).kind === 'deny', '往工作区根部未登记文件写被拒')

// 没配置 workspaceRoot 时，靠向上查找 roots.json 也能定位
const deep = path.join(ws, 'workflow', 'tools')
const k2 = await makeKeeper(deep, { workspaceRoot: '' })
ok((await k2.run(path.join(ws, 'workflow', 'tools', 'y-tool', 'b.py'))).kind === 'allow', '向上找到 roots.json，工作区内可写')
ok((await k2.run(path.join(outside, '还是乱塞.txt'))).kind === 'deny', '向上定位的根同样拦住外部写入')

// 完全定位不到工作区时不拦（避免把用户锁死）
const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-orphan-'))
const k3 = await makeKeeper(orphan, { workspaceRoot: '' })
const r3 = await k3.run(path.join(orphan, 'x.txt'))
console.log('SKIP  定位不到工作区时的行为：' + (r3.kind === 'allow' ? '放行（不锁死）' : '拒绝'))

const pointer = path.join(isoHome, 'workspace-keeper.root')
ok(fs.existsSync(pointer), '工作区指针写在隔离的 DSH_HOME 里')
const pointerValue = fs.readFileSync(pointer, 'utf8').trim()
ok(fs.existsSync(path.join(pointerValue, 'roots.json')), '指针指向的目录确实含 roots.json：' + pointerValue)

console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
