// CodedException derives its JS code from javaClass. Keep this class intact so
// a cancelled folder picker stays ERR_PICKER_CANCELLED in R8 release builds.
const rule = '-keep class expo.modules.filesystem.PickerCancelledException { *; }';
function applyPickerCancellationRules(contents) {
  if (contents.split(/\r?\n/).some(line => line.trim() === rule)) return contents;
  return `${contents}${contents.endsWith('\n') ? '' : '\n'}\n# Stable folder-picker cancellation code\n${rule}\n`;
}
module.exports = function withAndroidPickerCancellation(config) {
  const { withDangerousMod } = require('@expo/config-plugins');
  return withDangerousMod(config, ['android', async mod => {
    const { readFile, writeFile } = require('node:fs/promises');
    const { join } = require('node:path');
    const path = join(mod.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
    const before = await readFile(path, 'utf8');
    const after = applyPickerCancellationRules(before);
    if (before !== after) await writeFile(path, after);
    return mod;
  }]);
};
module.exports.applyPickerCancellationRules = applyPickerCancellationRules;
