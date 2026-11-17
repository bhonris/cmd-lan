'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');

const MIN_PASSWORD_LENGTH = 8;
const FILE_KEYS = ['port', 'host', 'password', 'shell', 'cwd', 'startupCommand'];

// Reads the optional settings file. A missing file means "no saved settings".
function readConfigFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!FILE_KEYS.includes(key)) {
      throw new Error(`${filePath}: unknown setting "${key}" (allowed: ${FILE_KEYS.join(', ')})`);
    }
    if (typeof value !== 'string' && !(key === 'port' && typeof value === 'number')) {
      throw new Error(`${filePath}: "${key}" must be a string${key === 'port' ? ' or number' : ''}`);
    }
  }
  return parsed;
}

// Environment variables win over the settings file, which wins over the defaults.
function loadConfig(env = process.env, platform = process.platform, file = {}) {
  const rawPort = env.CMD_LAN_PORT ?? file.port ?? 3000;
  const port = Number(rawPort);
  if (rawPort === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`The port must be a number between 1 and 65535, got "${rawPort}"`);
  }

  let password = env.CMD_LAN_PASSWORD || file.password;
  const passwordGenerated = !password;
  if (passwordGenerated) {
    password = crypto.randomBytes(12).toString('base64url');
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const defaultShell = platform === 'win32' ? 'powershell.exe' : env.SHELL || 'bash';

  return {
    port,
    host: env.CMD_LAN_HOST || file.host || '0.0.0.0',
    password,
    passwordGenerated,
    shell: env.CMD_LAN_SHELL || file.shell || defaultShell,
    cwd: env.CMD_LAN_CWD || file.cwd || os.homedir(),
    startupCommand: env.CMD_LAN_STARTUP_COMMAND || file.startupCommand || '',
  };
}

function lanAddresses(interfaces = os.networkInterfaces()) {
  const addresses = [];
  for (const list of Object.values(interfaces)) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  return addresses;
}

module.exports = { loadConfig, readConfigFile, lanAddresses, MIN_PASSWORD_LENGTH };
