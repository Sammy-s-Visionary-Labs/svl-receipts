const { withXcodeProject } = require("expo/config-plugins");

// Expo's generated bundling phase executes an unquoted command substitution.
// Quote it so native builds work when the checkout path contains spaces.
module.exports = function withIosPathQuoting(config) {
  return withXcodeProject(config, (updatedConfig) => {
    const phases = updatedConfig.modResults.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    for (const phase of Object.values(phases)) {
      if (typeof phase !== "object" || typeof phase.shellScript !== "string") continue;
      if (phase.name !== '"Bundle React Native code and images"') continue;
      const script = JSON.parse(phase.shellScript);
      const quoted = script.replace(/^(`.*react-native-xcode\.sh.*`)$/m, '"$1"');
      if (quoted !== script) phase.shellScript = JSON.stringify(quoted);
    }
    return updatedConfig;
  });
};
