const os = require("node:os");

const { syncBuiltinESMExports } = require("node:module");

os.loadavg = () => [0, 0, 0];

syncBuiltinESMExports();
