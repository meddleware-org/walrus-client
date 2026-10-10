// Release gate: refuse to publish while the localnet integration suite is red.
//
// Reads the JSON that
//   gh run list --workflow integration.yml --branch main --status completed --json conclusion,headSha,url,createdAt,event
// prints, on stdin. Only completed runs that passed or failed count (a cancelled or skipped run says
// nothing about the code). The verdict is taken from
//   1. the newest run for the tagged commit (TAG_SHA), when there is one: dispatch the workflow on
//      the commit you are about to tag for the strict, exact-commit check; otherwise from
//   2. the newest run on main, which must be green and no older than MAX_AGE_HOURS (default 72): the
//      nightly cadence plus a weekend of slack. A schedule GitHub paused would otherwise leave an
//      old green run vouching for new code forever.
// Exit 0 = may publish; exit 1 = blocked, with the reason on stderr.

const MAX_AGE_HOURS_DEFAULT = 72

/** Newest-first by createdAt, counting only runs that passed or failed. */
function conclusive(runs) {
  return runs
    .filter((r) => r && (r.conclusion === 'success' || r.conclusion === 'failure') && typeof r.createdAt === 'string')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

/**
 * @param {unknown} input parsed `gh run list` output
 * @param {{ tagSha?: string, now?: number, maxAgeHours?: number }} opts
 * @returns {{ ok: boolean, message: string }}
 */
export function decide(input, opts = {}) {
  const { tagSha = '', now = Date.now(), maxAgeHours = MAX_AGE_HOURS_DEFAULT } = opts
  if (!Array.isArray(input)) return { ok: false, message: 'no run list to judge (expected a JSON array)' }
  const runs = conclusive(input)

  const exact = tagSha ? runs.find((r) => r.headSha === tagSha) : undefined
  if (exact) {
    return exact.conclusion === 'success'
      ? { ok: true, message: `localnet suite is green for the tagged commit ${tagSha.slice(0, 7)} (${exact.url})` }
      : { ok: false, message: `localnet suite is RED for the tagged commit ${tagSha.slice(0, 7)} (${exact.url})` }
  }

  const latest = runs[0]
  if (!latest) {
    return {
      ok: false,
      message: 'no completed localnet run found on main: dispatch "Integration (localnet)" on main and wait for it to pass',
    }
  }
  if (latest.conclusion !== 'success') {
    return { ok: false, message: `the latest localnet run on main is RED (${latest.url}); fix it or re-run it green before releasing` }
  }
  const ageHours = (now - Date.parse(latest.createdAt)) / 3_600_000
  if (!(ageHours <= maxAgeHours)) {
    return {
      ok: false,
      message: `the latest green localnet run is ${Math.round(ageHours)} h old (limit ${maxAgeHours} h; ${latest.url}): dispatch "Integration (localnet)" on main and wait for it to pass`,
    }
  }
  const sameCommit = latest.headSha === tagSha
  return {
    ok: true,
    message: sameCommit
      ? `localnet suite is green for the tagged commit (${latest.url})`
      : `localnet suite is green on main (${latest.url}, commit ${String(latest.headSha).slice(0, 7)}); no run exists for the tagged commit ${tagSha.slice(0, 7)}`,
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input
  try {
    input = JSON.parse(await readStdin())
  } catch {
    console.error('::error::localnet gate: stdin is not JSON')
    process.exit(1)
  }
  const maxAgeHours = Number(process.env.MAX_AGE_HOURS ?? MAX_AGE_HOURS_DEFAULT)
  const verdict = decide(input, { tagSha: process.env.TAG_SHA ?? '', maxAgeHours })
  if (verdict.ok) {
    console.log(`::notice::${verdict.message}`)
  } else {
    console.error(`::error::${verdict.message}`)
    process.exit(1)
  }
}
