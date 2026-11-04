// The wire types live in ../packages/companion-protocol (linked, not published),
// so Metro has to watch that folder too.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../packages/companion-protocol')];
module.exports = config;
