/** 用 DSH 自己的校验函数检查每个工具的 schema，防止"能跑但加载不了"。 */
import fs from 'node:fs'
import path from 'node:path'
const sdk = 'A:/workflow/dsh/_attic/_misc/dsh-sdk/sdk/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
if (!fs.existsSync(sdk)) { console.log('SKIP  没找到 DSH SDK（_attic/_misc/dsh-sdk），跳过') ; process.exit(0) }
const { assertSupportedJsonSchema } = await import('file:///' + sdk)
const { apply } = await import('../index.js')
const tools = new Map()
const ctx = { workingDirectory: { ensure: async () => 'A:/workflow/dsh' }, systemPrompt: { section: () => {}, getSectionOrder: () => 1 }, tools: { register: (d) => tools.set(d.name, d), get: (n) => tools.get(n) }, get: () => undefined, on: () => {} }
apply(ctx, {})
let fail = 0
for (const [n, d] of tools) {
  try {
    assertSupportedJsonSchema(d.parameters)
    assertSupportedJsonSchema(d.output.schema)
    console.log('PASS  ' + n)
  } catch (e) { fail += 1; console.log('FAIL  ' + n + ' : ' + e.message.slice(0, 140)) }
}
console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)