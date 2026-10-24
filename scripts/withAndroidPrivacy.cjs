// Prebuild source of truth. The generated debug manifest keeps its own cleartext
// override for Metro; release must pass the compiled-manifest packaging checks.
function applyPrivacyManifest(manifest) {
  const applications = manifest.manifest.application;
  if (!applications || applications.length !== 1 || !applications[0].$) throw new Error('privacy-application-missing');
  applications[0].$['android:allowBackup'] = 'false';
  applications[0].$['android:usesCleartextTraffic'] = 'false';
  return manifest;
}

module.exports = function withAndroidPrivacy(config) {
  const { withAndroidManifest } = require('@expo/config-plugins');
  return withAndroidManifest(config, mod => {
    mod.modResults = applyPrivacyManifest(mod.modResults);
    return mod;
  });
};
module.exports.applyPrivacyManifest = applyPrivacyManifest;
