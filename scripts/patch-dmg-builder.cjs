const fs = require('fs')
const path = require('path')

const dmgFile = path.join(__dirname, '..', 'node_modules', 'dmg-builder', 'out', 'dmg.js')
const dmgUtilFile = path.join(__dirname, '..', 'node_modules', 'dmg-builder', 'out', 'dmgUtil.js')

if (!fs.existsSync(dmgFile) || !fs.existsSync(dmgUtilFile)) {
  console.warn(`[patch-dmg-builder] skip, dmg-builder files not found: ${dmgFile}, ${dmgUtilFile}`)
  process.exit(0)
}

function replaceRequired(source, oldSnippet, newSnippet, label) {
  if (source.includes(newSnippet)) {
    console.log(`[patch-dmg-builder] already patched: ${label}`)
    return source
  }

  const candidates = Array.isArray(oldSnippet) ? oldSnippet : [oldSnippet]
  const matchedSnippet = candidates.find(candidate => source.includes(candidate))
  if (!matchedSnippet) {
    throw new Error(`[patch-dmg-builder] target snippet not found: ${label}`)
  }

  console.log(`[patch-dmg-builder] patched: ${label}`)
  return source.replace(matchedSnippet, newSnippet)
}

const oldResizeSnippet = `        const expandingFinalSize = finalSize * 0.1 + finalSize;
        await (0, hdiuil_1.hdiUtil)(["resize", "-size", expandingFinalSize.toString(), tempDmg]);`
const newResizeSnippet = `        const expandingFinalSize = Math.ceil(finalSize * 0.1 + finalSize);
        await (0, hdiuil_1.hdiUtil)(["resize", "-size", expandingFinalSize.toString(), tempDmg]);`

const oldCreateStageSnippet = `async function createStageDmg(tempDmg, appPath, volumeName) {
    //noinspection SpellCheckingInspection
    const imageArgs = addLogLevel(["create", "-srcfolder", appPath, "-volname", volumeName, "-anyowners", "-nospotlight", "-format", "UDRW"]);
    if (builder_util_1.log.isDebugEnabled) {
        imageArgs.push("-debug");
    }
    let filesystem = ["HFS+", "-fsargs", "-c c=64,a=16,e=16"];
    if (process.arch === "arm64") {
        // Apple Silicon \`hdiutil\` dropped support for HFS+, so we force the latest type
        // https://github.com/electron-userland/electron-builder/issues/4606
        filesystem = ["APFS"];
        builder_util_1.log.warn(null, "Detected arm64 process, HFS+ is unavailable. Creating dmg with APFS - supports Mac OSX 10.12+");
    }
    imageArgs.push("-fs", ...filesystem);
    imageArgs.push(tempDmg);
    await (0, hdiuil_1.hdiUtil)(imageArgs);
    return tempDmg;
}`
const previousCreateStageSnippet = `async function createStageDmg(tempDmg, appPath, volumeName) {
    // Creating directly from a large .app can copy successfully but fail while hdiutil
    // immediately unmounts its private staging volume (49168 / Resource busy).
    // Split the operation so dmg-builder's normal detach retry can wait for macOS
    // metadata services, and mount with -nobrowse to avoid unnecessary bundle scans.
    let filesystem = ["HFS+", "-fsargs", "-c c=64,a=16,e=16"];
    if (process.arch === "arm64") {
        filesystem = ["APFS"];
        builder_util_1.log.warn(null, "Detected arm64 process, HFS+ is unavailable. Creating dmg with APFS - supports Mac OSX 10.12+");
    }
    const duOutput = await (0, builder_util_1.exec)("du", ["-sk", appPath]);
    const sourceKiB = Number.parseInt(duOutput, 10);
    if (!Number.isFinite(sourceKiB) || sourceKiB <= 0) {
        throw new Error(\`Cannot determine DMG stage size from: \${duOutput}\`);
    }
    const stageSizeMiB = Math.ceil(sourceKiB / 1024 * 1.25 + 128);
    const imageArgs = addLogLevel(["create", "-size", \`\${stageSizeMiB}m\`, "-volname", volumeName, "-nospotlight", "-fs", ...filesystem, tempDmg]);
    await (0, hdiuil_1.hdiUtil)(imageArgs);
    const volumePath = path.join("/Volumes", volumeName);
    await (0, dmgUtil_1.attachAndExecute)(tempDmg, true, () => (0, builder_util_1.exec)("ditto", [appPath, path.join(volumePath, path.basename(appPath))]));
    return tempDmg;
}`
const newCreateStageSnippet = `async function createStageDmg(tempDmg, appPath, volumeName) {
    // Creating directly from a large .app can copy successfully but fail while hdiutil
    // immediately unmounts its private staging volume (49168 / Resource busy).
    // Split the operation so dmg-builder's normal detach retry can wait for macOS
    // metadata services, and mount with -nobrowse to avoid unnecessary bundle scans.
    let filesystem = ["HFS+", "-fsargs", "-c c=64,a=16,e=16"];
    if (process.arch === "arm64") {
        filesystem = ["APFS"];
        builder_util_1.log.warn(null, "Detected arm64 process, HFS+ is unavailable. Creating dmg with APFS - supports Mac OSX 10.12+");
    }
    const duOutput = await (0, builder_util_1.exec)("du", ["-sk", appPath]);
    const sourceKiB = Number.parseInt(duOutput, 10);
    if (!Number.isFinite(sourceKiB) || sourceKiB <= 0) {
        throw new Error(\`Cannot determine DMG stage size from: \${duOutput}\`);
    }
    const stageSizeMiB = Math.ceil(sourceKiB / 1024 * 1.25 + 128);
    const imageArgs = addLogLevel(["create", "-size", \`\${stageSizeMiB}m\`, "-volname", volumeName, "-nospotlight", "-fs", ...filesystem, tempDmg]);
    await (0, hdiuil_1.hdiUtil)(imageArgs);
    const volumePath = path.join("/Volumes", volumeName);
    // A previously opened installer can occupy the same mount path. The stock
    // dmg-builder handles this later, but our explicit staging mount needs it now.
    if (await (0, builder_util_1.exists)(volumePath)) {
        builder_util_1.log.info({ volumePath }, "unmounting previous disk image before staging");
        await (0, dmgUtil_1.detach)(volumePath);
    }
    await (0, dmgUtil_1.attachAndExecute)(tempDmg, true, () => (0, builder_util_1.exec)("ditto", [appPath, path.join(volumePath, path.basename(appPath))]));
    return tempDmg;
}`

const oldAttachSnippet = `    const args = ["attach", "-noverify", "-noautoopen"];`
const newAttachSnippet = `    const args = ["attach", "-noverify", "-noautoopen", "-nobrowse"];`

let dmgSource = fs.readFileSync(dmgFile, 'utf8')
dmgSource = replaceRequired(dmgSource, oldResizeSnippet, newResizeSnippet, 'resize rounding')
dmgSource = replaceRequired(dmgSource, [oldCreateStageSnippet, previousCreateStageSnippet], newCreateStageSnippet, 'resource-busy-safe stage creation')
fs.writeFileSync(dmgFile, dmgSource)

let dmgUtilSource = fs.readFileSync(dmgUtilFile, 'utf8')
dmgUtilSource = replaceRequired(dmgUtilSource, oldAttachSnippet, newAttachSnippet, 'nobrowse DMG attach')
fs.writeFileSync(dmgUtilFile, dmgUtilSource)
