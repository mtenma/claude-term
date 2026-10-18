const {createHash} = require('node:crypto')
const {execFileSync} = require('node:child_process')
const {readFileSync, readdirSync, writeFileSync} = require('node:fs')
const path = require('node:path')

function readPlist(file) {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], {encoding: 'utf8'}))
}

// macOS の LAN 権限は main executable の UUID でもアプリを識別する。
// Electron の共通 UUID を残さず、署名前に bundle ID ごとの値へ変える (Apple TN3178)。
function scopeExecutableUuid(file, bundleId) {
  const data = readFileSync(file)
  if (data.length < 32 || data.readUInt32LE(0) !== 0xfeedfacf || data.readUInt32LE(12) !== 2) {
    throw new Error(`Expected a thin 64-bit Mach-O executable: ${file}`)
  }
  const commandsEnd = 32 + data.readUInt32LE(20)
  if (commandsEnd > data.length) throw new Error(`Truncated Mach-O load commands: ${file}`)

  let offset = 32
  let uuidOffset = null
  for (let i = 0; i < data.readUInt32LE(16); i++) {
    if (offset + 8 > commandsEnd) throw new Error(`Missing Mach-O load command: ${file}`)
    const command = data.readUInt32LE(offset)
    const size = data.readUInt32LE(offset + 4)
    if (size < 8 || offset + size > commandsEnd) throw new Error(`Invalid Mach-O load command: ${file}`)
    if (command === 0x1b) {
      if (size !== 24 || uuidOffset !== null) throw new Error(`Invalid LC_UUID: ${file}`)
      uuidOffset = offset + 8
    }
    offset += size
  }
  if (uuidOffset === null || offset !== commandsEnd) throw new Error(`Invalid Mach-O UUID layout: ${file}`)

  // 元の Electron UUID と bundle ID が同じなら、再ビルドしても同じ UUID になる。
  const uuid = createHash('sha256')
    .update(bundleId)
    .update('\0')
    .update(data.subarray(uuidOffset, uuidOffset + 16))
    .digest().subarray(0, 16)
  uuid[6] = (uuid[6] & 0x0f) | 0x80
  uuid[8] = (uuid[8] & 0x3f) | 0x80
  uuid.copy(data, uuidOffset)
  writeFileSync(file, data)
}

module.exports = async function prepareMacPackage(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (context.packager.platformSpecificBuildOptions.identity === null) {
    throw new Error('macOS packaging requires signing after preparing executable UUIDs')
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const mainInfo = readPlist(path.join(app, 'Contents/Info.plist'))
  const description = mainInfo.NSLocalNetworkUsageDescription
  if (!description) throw new Error('NSLocalNetworkUsageDescription is required')
  const frameworks = path.join(app, 'Contents/Frameworks')
  const bundles = [app, ...readdirSync(frameworks)
    .filter((name) => name.endsWith('.app'))
    .map((name) => path.join(frameworks, name))]
  for (const bundle of bundles) {
    const plistFile = path.join(bundle, 'Contents/Info.plist')
    const info = readPlist(plistFile)
    execFileSync('/usr/bin/plutil', [
      info.NSLocalNetworkUsageDescription === undefined ? '-insert' : '-replace',
      'NSLocalNetworkUsageDescription', '-string', description, plistFile,
    ])
    scopeExecutableUuid(path.join(bundle, 'Contents/MacOS', info.CFBundleExecutable), info.CFBundleIdentifier)
  }
}
