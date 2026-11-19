import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDxgiProbe } from '../src/main/displays.ts'

test('DXGI monitor probe compiles and returns a JSON array', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const res = await runDxgiProbe()
  assert.ok(res.ok, res.stderr)
  const line = res.stdout.trim().split(/\r?\n/).pop() ?? ''
  assert.ok(Array.isArray(JSON.parse(line)), res.stdout)
})
