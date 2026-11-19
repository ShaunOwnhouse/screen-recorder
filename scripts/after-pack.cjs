// Ad-hoc signs the macOS app. Apple Silicon refuses to run unsigned code, and without a paid
// Developer ID certificate an ad-hoc signature is what lets users open it via "Open Anyway".
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  // With a real Developer ID certificate, electron-builder signs (and notarises) after this hook.
  if (context.electronPlatformName !== 'darwin' || process.env.CSC_LINK) return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
