"use strict";

const os = require("os");
const path = require("path");
const Module = require("module");

const appDir = path.dirname(process.execPath);

function getAppAsarPath() {
  if (process.platform === "darwin") {
    return path.resolve(appDir, "..", "Resources", "app.asar");
  }

  return path.join(appDir, "resources", "app.asar");
}

const appAsarPath = getAppAsarPath();

// dist-electron/mcp.js and selected runtime packages are unpacked for Electron,
// while pure-JS transitive dependencies remain in app.asar. Node normally starts
// resolution from app.asar.unpacked and cannot cross that boundary, so expose the
// packaged node_modules directory as a trusted fallback for every unpacked module.
const appNodeModulesPath = path.join(appAsarPath, "node_modules");
const existingNodePathEntries = String(process.env.NODE_PATH || "")
  .split(path.delimiter)
  .filter(Boolean);
process.env.NODE_PATH = [appNodeModulesPath, ...existingNodePathEntries]
  .filter((entry, index, entries) => entries.indexOf(entry) === index)
  .join(path.delimiter);
Module._initPaths();

function getUserDataPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "ciphertalk");
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "ciphertalk");
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "ciphertalk");
}

function getDocumentsPath() {
  return path.join(os.homedir(), "Documents");
}

const electronShim = {
  app: {
    isPackaged: true,
    getPath(name) {
      switch (name) {
        case "userData":
          return getUserDataPath();
        case "documents":
          return getDocumentsPath();
        case "exe":
          return process.execPath;
        default:
          return process.platform === "darwin" ? path.resolve(appDir, "..") : appDir;
      }
    },
    getAppPath() {
      return appAsarPath;
    },
    getVersion() {
      try {
        return require(path.join(appAsarPath, "package.json")).version || "0.0.0";
      } catch {
        return "0.0.0";
      }
    },
  },
  BrowserWindow: {
    getAllWindows() {
      return [];
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return electronShim;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const entry = String(process.env.CIPHERTALK_MCP_ENTRY || "").trim();
if (!entry) {
  process.stderr.write("[CipherTalk MCP Bootstrap] CIPHERTALK_MCP_ENTRY is not set\n");
  process.exit(1);
}

require(entry);
