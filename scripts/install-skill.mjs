import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const skillRoot = path.resolve(scriptDir, '..', 'skill')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const destIndex = args.indexOf('--dest')
const customDest = destIndex !== -1 ? args[destIndex + 1] : undefined
const skillsDir =
  customDest ?? process.env.KILO_SKILLS_DIR ?? path.join(homedir(), '.kilocode', 'skills')

function skillDirs() {
  return readdirSync(skillRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(path.join(skillRoot, entry.name, 'SKILL.md')),
    )
    .map((entry) => entry.name)
}

function listFiles(root) {
  const entries = readdirSync(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      for (const nested of listFiles(fullPath)) files.push(path.join(entry.name, nested))
    } else {
      files.push(entry.name)
    }
  }
  return files.sort()
}

function difference(source, target) {
  const sourceFiles = listFiles(source)
  const targetFiles = existsSync(target) ? listFiles(target) : []
  const targetSet = new Set(targetFiles)
  const problems = sourceFiles.filter((file) => {
    if (!targetSet.has(file)) return true
    const sourceBytes = readFileSync(path.join(source, file))
    const targetBytes = readFileSync(path.join(target, file))
    return !sourceBytes.equals(targetBytes)
  })
  const sourceSet = new Set(sourceFiles)
  const stale = targetFiles.filter((file) => !sourceSet.has(file))
  return { inSync: problems.length === 0 && stale.length === 0, problems, stale }
}

function installSkill(name) {
  const source = path.join(skillRoot, name)
  const target = path.join(skillsDir, name)
  if (existsSync(target)) {
    const stat = statSync(target)
    if (!stat.isDirectory()) rmSync(target)
  }
  mkdirSync(skillsDir, { recursive: true })
  cpSync(source, target, { recursive: true })
  const verdict = difference(source, target)
  if (!verdict.inSync) {
    console.error(`[FAIL] ${name} installed incompletely at ${target}`)
    process.exit(1)
  }
  console.log(`[OK] ${name} → ${target} (${listFiles(target).length} files)`)
}

const names = skillDirs()
if (names.length === 0) {
  console.log(`no skills found in ${skillRoot}`)
  process.exit(0)
}

if (checkOnly) {
  let inSync = true
  for (const name of names) {
    const verdict = difference(path.join(skillRoot, name), path.join(skillsDir, name))
    console.log(
      `${verdict.inSync ? '[OK] in sync' : '[NEEDS INSTALL]'} ${name} → ${path.join(skillsDir, name)}`,
    )
    if (verdict.problems.length > 0)
      console.log(`  differing/missing: ${verdict.problems.join(', ')}`)
    if (verdict.stale.length > 0) console.log(`  stale in target: ${verdict.stale.join(', ')}`)
    inSync = inSync && verdict.inSync
  }
  process.exit(inSync ? 0 : 1)
}

for (const name of names) installSkill(name)
