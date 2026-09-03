// Assemble the folder Azure App Service runs: the bundled API, the built
// client under public/, the SQL migrations, and a package.json whose
// production dependencies are installed with `npm ci --omit=dev`.
//
//   deploy/
//     dist/index.js        the API bundle (+ source map)
//     public/              the client (index.html + hashed assets)
//     migrations/          applied by the API on start
//     package.json         production dependencies only
//     package-lock.json    so `npm ci` is reproducible
//     node_modules/        installed here, shipped with the package
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'deploy')

function must(p, what) {
  if (!existsSync(p)) {
    console.error(`Missing ${what}: ${p}. Run the build first.`)
    process.exit(1)
  }
}

must(path.join(root, 'server/dist/index.js'), 'API bundle')
must(path.join(root, 'client/dist/index.html'), 'client build')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(path.join(root, 'server/dist'), path.join(out, 'dist'), { recursive: true })
cpSync(path.join(root, 'client/dist'), path.join(out, 'public'), { recursive: true })
cpSync(path.join(root, 'server/migrations'), path.join(out, 'migrations'), { recursive: true })

const serverPkg = JSON.parse(readFileSync(path.join(root, 'server/package.json'), 'utf8'))
const deps = { ...serverPkg.dependencies }
delete deps['@qc/shared'] // bundled into dist/index.js
writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'qc-system-app',
      version: serverPkg.version,
      private: true,
      type: 'module',
      engines: serverPkg.engines ?? { node: '>=20.11' },
      scripts: { start: 'node dist/index.js' },
      dependencies: deps,
    },
    null,
    2,
  ),
)

// A standalone lockfile keeps the install reproducible on the build agent.
execSync('npm install --omit=dev --package-lock-only --ignore-scripts --no-audit --no-fund', { cwd: out, stdio: 'inherit' })
execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: out, stdio: 'inherit' })

console.log(`Packaged to ${out}`)
