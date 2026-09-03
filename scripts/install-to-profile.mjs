#!/usr/bin/env node
/**
 * dsh-pwa-notify · install this package into a DSH web profile as a PACKED
 * copy (tarball), not a link.
 *
 * Why: the project directory is the DEV tree — the live DSH must not run
 * off it. This script packs the current source (npm pack, files-whitelisted,
 * node_modules never included), stages the tarball at a STABLE path under
 * $DSH_HOME (plugins-packages/dsh-pwa-notify-current.tgz — a fixed filename
 * so the profile's package.json dependency never rots between versions),
 * and runs `pnpm add` in the profile. pnpm copies real files into its store:
 * after this, deleting or editing the project directory changes nothing for
 * the running DSH until the next install.
 *
 *   node scripts/install-to-profile.mjs            # pack + install + hint
 *   node scripts/install-to-profile.mjs --restart  # … and restart the service
 *
 * The profile keeps `"dsh-pwa-notify": "file:<relative>/dsh-pwa-notify-current.tgz"`.
 * Run tests first — whatever is packed is what the live DSH will run.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'web')
const PKG_DIR = join(DSH_HOME, 'plugins-packages')
const STABLE_TGZ = join(PKG_DIR, 'dsh-pwa-notify-current.tgz')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const doRestart = process.argv.includes('--restart')

function run(cmd, args, cwd, extraEnv = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}${cwd ? `  (in ${cwd})` : ''}`)
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } })
}

// 1. tests must pass — the tarball is the formal artifact
run('npm', ['test'], ROOT)

// 2. pack (cache/tmp pinned under the project so read-only HOMEs still work)
const cacheDir = join(ROOT, '.npm-cache')
const tmpDir = join(ROOT, '.npm-tmp')
mkdirSync(cacheDir, { recursive: true })
mkdirSync(tmpDir, { recursive: true })
run('npm', ['pack'], ROOT, { npm_config_cache: cacheDir, npm_config_tmp: tmpDir })
const tarball = join(ROOT, `dsh-pwa-notify-${pkg.version}.tgz`)

// 3. stage at the stable path and install into the profile.
// ALWAYS remove-then-add: pnpm does not refresh an already-installed file:
// tarball when the specifier is unchanged (same path, same version number —
// it skips re-extraction and the old copy stays). Removing first forces a
// clean materialization every time.
mkdirSync(PKG_DIR, { recursive: true })
copyFileSync(tarball, STABLE_TGZ)
const rel = relative(PROFILE, STABLE_TGZ)
try {
  run('pnpm', ['remove', 'dsh-pwa-notify'], PROFILE)
} catch {
  /* not installed yet — fine */
}
run('pnpm', ['add', `file:${rel}`], PROFILE)

console.log(`\n[install-to-profile] dsh-pwa-notify@${pkg.version} installed as a packed copy.`)
if (doRestart) {
  try {
    run('systemctl', ['restart', 'dsh.service'])
    console.log('[install-to-profile] dsh.service restarted.')
  } catch {
    console.warn('[install-to-profile] systemctl restart failed — restart dsh web yourself.')
  }
} else {
  console.log('[install-to-profile] restart dsh web to activate (systemctl restart dsh.service).')
}
