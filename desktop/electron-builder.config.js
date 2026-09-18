// electron-builder configuration for the Wyre Windows desktop app.
// Loaded explicitly via `--config electron-builder.config.js` in npm scripts.
// Runtime dependencies (the optional nut-js module for OS remote control) are
// packaged by electron-builder defaults; no custom file whitelist is needed.
module.exports = {
  appId: 'wyre.messenger.desktop',
  productName: 'Wyre',
  directories: {
    output: 'dist-app',
    buildResources: 'build',
  },
  // The tray/window icon must live outside app.asar: native image loading
  // inside the archive is unreliable on Windows.
  extraResources: [{ from: 'build/icon.png', to: 'icon.png' }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Wyre',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico',
    artifactName: 'Wyre-Setup-${version}.exe',
  },
};
