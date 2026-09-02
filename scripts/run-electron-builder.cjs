const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const pkg = require('../package.json')

const target = process.argv[2]

if (!target || !['win', 'mac'].includes(target)) {
  console.error('Usage: node scripts/run-electron-builder.cjs <win|mac>')
  process.exit(1)
}

const cliPath = require.resolve('electron-builder/cli.js')
const configPath = path.join(__dirname, 'electron-builder.config.cjs')
const env = {
  ...process.env,
  CIPHERTALK_BUILD_TARGET: target,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
}

if (env.GITHUB_ACTIONS) {
  for (const key of Object.keys(env)) {
    const normalized = key.toLowerCase()
    if (
      normalized === 'electron_mirror' ||
      normalized === 'electron_builder_binaries_mirror' ||
      normalized === 'npm_config_electron_mirror' ||
      normalized === 'npm_config_electron_builder_binaries_mirror'
    ) {
      delete env[key]
    }
  }
}

const result = spawnSync(
  process.execPath,
  [cliPath, `--${target}`, '--publish', 'never', '--config', configPath],
  {
    stdio: 'inherit',
    env
  }
)

if (result.error) {
  console.error(`electron-builder 启动失败: ${result.error.message}`)
  process.exit(1)
}

// 必须先传递本次 builder 的真实结果。仅检查产物会让上一次遗留的 DMG/EXE
// 掩盖当前打包失败，导致 build:mac 看似成功却仍是旧包。
if (result.status !== 0) {
  console.error(`electron-builder 打包失败（退出码 ${result.status ?? '未知'}）`)
  process.exit(typeof result.status === 'number' && result.status > 0 ? result.status : 1)
}

// 构建阶段只要求安装包产物存在，自动更新元数据交给后续发布阶段校验。
const artifactNames = target === 'mac'
  ? [`release/CipherTalk-${pkg.version}-Setup.dmg`]
  : [`release/CipherTalk-${pkg.version}-Setup.exe`]
const missingArtifacts = artifactNames.filter((artifactName) => !fs.existsSync(path.join(__dirname, '..', artifactName)))
if (missingArtifacts.length > 0) {
  console.error(`缺少构建产物: ${missingArtifacts.join(', ')}`)
  process.exit(result.status || 1)
}
