// Packaging contract (F18): declarations ship for every entry point like the sibling SDK packages,
// the security policy is in the tarball, and the engine floor is the fleet's Node 24 LTS.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const pkg = JSON.parse(readFileSync(root('package.json'), 'utf8')) as {
  files: string[]
  engines: { node: string }
  exports: Record<string, { types: string; default: string }>
  scripts: Record<string, string>
}

describe('package.json', () => {
  it('ships a types condition and the source for every entry point', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './flow', './http', './node'])
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const name = subpath === '.' ? 'index' : subpath.slice(2)
      expect(target).toEqual({ types: `./dist/${name}.d.ts`, default: `./src/${name}.ts` })
      expect(existsSync(root(`src/${name}.ts`))).toBe(true)
    }
  })

  it('lists declarations, source and the security policy in the tarball', () => {
    for (const entry of ['src', 'dist', 'CHANGELOG.md', 'SECURITY.md']) {
      expect(pkg.files).toContain(entry)
      if (entry !== 'dist') expect(existsSync(root(entry))).toBe(true)
    }
  })

  it('builds declarations only, before every publish', () => {
    expect(pkg.scripts.build).toBe('rm -rf dist && tsc -p tsconfig.build.json')
    expect(pkg.scripts.prepublishOnly).toBe('npm run build')
    const build = JSON.parse(readFileSync(root('tsconfig.build.json'), 'utf8')) as {
      compilerOptions: Record<string, unknown>
      include: string[]
    }
    expect(build.compilerOptions).toMatchObject({ declaration: true, emitDeclarationOnly: true, noEmit: false })
    expect(build.include).toEqual(['src/**/*.ts'])
  })

  it('requires Node 24 LTS or newer', () => {
    expect(pkg.engines).toEqual({ node: '>=24' })
  })
})
