// The release gate that keeps a red localnet suite from reaching npm (F24). Run through its CLI, the
// way the publish workflow runs it: JSON on stdin, TAG_SHA in the environment, exit code as verdict.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../.github/localnet-gate.mjs', import.meta.url))
const TAG = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

interface Run {
  conclusion: string
  headSha: string
  createdAt: string
  url: string
  event: string
}
const run = (conclusion: string, headSha: string, h: number): Run => ({
  conclusion,
  headSha,
  createdAt: hoursAgo(h),
  url: `https://example.test/runs/${conclusion}-${h}`,
  event: 'schedule',
})

function gate(runs: unknown, env: Record<string, string> = {}, stdin?: string) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: stdin ?? JSON.stringify(runs),
    env: { PATH: process.env.PATH ?? '', TAG_SHA: TAG, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('localnet release gate', () => {
  it('passes on a recent green run on main, and says it is not for the tagged commit', () => {
    const r = gate([run('success', OTHER, 5)])
    expect(r.code).toBe(0)
    expect(r.out).toContain('no run exists for the tagged commit')
  })

  it('blocks when the newest conclusive run on main is red, even if an older one was green', () => {
    const r = gate([run('failure', OTHER, 2), run('success', OTHER, 30)])
    expect(r.code).toBe(1)
    expect(r.err).toContain('RED')
  })

  it('ignores cancelled and skipped runs', () => {
    expect(gate([run('cancelled', OTHER, 1), run('skipped', OTHER, 2), run('success', OTHER, 6)]).code).toBe(0)
    const none = gate([run('cancelled', OTHER, 1)])
    expect(none.code).toBe(1)
    expect(none.err).toContain('no completed localnet run')
  })

  it('blocks when there is no run at all', () => {
    expect(gate([]).code).toBe(1)
  })

  it('blocks a green run older than the limit (a paused schedule must not vouch forever)', () => {
    const r = gate([run('success', OTHER, 100)])
    expect(r.code).toBe(1)
    expect(r.err).toContain('old')
    expect(gate([run('success', OTHER, 100)], { MAX_AGE_HOURS: '200' }).code).toBe(0)
  })

  it('judges the tagged commit by its own run when one exists', () => {
    const red = gate([run('failure', TAG, 1), run('success', OTHER, 2)])
    expect(red.code).toBe(1)
    expect(red.err).toContain('tagged commit')
    // an old green run for the exact commit is still that commit's verdict (age matters only for main)
    const green = gate([run('success', TAG, 200), run('failure', OTHER, 1)])
    expect(green.code).toBe(0)
    expect(green.out).toContain('green for the tagged commit')
  })

  it('refuses malformed input', () => {
    expect(gate(null, {}, 'not json').code).toBe(1)
    expect(gate({ not: 'an array' }).code).toBe(1)
  })
})
