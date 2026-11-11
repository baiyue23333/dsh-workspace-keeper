import { validateToolName, historyName, parseHistoryName, baseName } from '../lib/naming.js'
const cases = [
  ['bash-executor-tool', true],
  ['dsh-bash-repair-tool', true],
  ['bash_repair', false],
  ['Bash-repair-tool', false],
  ['bash-repair', false],
  ['bash--repair-tool', false],
  ['-bash-repair-tool', false],
]
let fail = 0
for (const [n, want] of cases) {
  const r = validateToolName(n)
  const got = r.ok === true
  console.log((got === want ? 'PASS  ' : 'FAIL  ') + n + ' → ' + (got ? '合法' : '拒绝：' + r.reason))
  if (got !== want) fail += 1
}
const hist = [
  ['bash-executor-tool', 'broken', [], 'bash-executor_v1_broken'],
  ['bash-executor-tool', 'broken', ['bash-executor_v1_broken'], 'bash-executor_v2_broken'],
  ['pdf-merge-tool', 'deprecated', [], 'pdf-merge_v1_deprecated'],
]
for (const [n, s, taken, want] of hist) {
  const got = historyName(n, s, taken)
  console.log((got === want ? 'PASS  ' : 'FAIL  ') + n + ' → ' + got)
  if (got !== want) fail += 1
}
const p = parseHistoryName('bash-executor_v3_broken')
console.log((p && p.base === 'bash-executor' && p.version === 'v3' && p.status === 'broken' ? 'PASS  ' : 'FAIL  ') + '解析历史名 ' + JSON.stringify(p))
console.log('baseName:', baseName('bash-executor-tool'))
console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
