'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');

const MIN_PASSWORD_LENGTH = 8;
const FILE_KEYS = ['port', 'host', 'password', 'shell', 'cwd', 'startupCommand', 'startupCommands'];
const MAX_CHOICE_NAME_LENGTH = 40;

// `startupCommands` maps a name shown in the browser to the command run for it.
function validateStartupCommands(filePath, value) {
  const fail = (problem) => {
    throw new Error(`${filePath}: "startupCommands" ${problem}`);
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('must be an object like {"Claude": "claude", "Codex": "codex"}');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) fail('must list at least one command');
  for (const [name, command] of entries) {
    if (name.trim() === '' || name.length > MAX_CHOICE_NAME_LENGTH) {
      fail(`has a bad name "${name}" (names need 1 to ${MAX_CHOICE_NAME_LENGTH} characters)`);
    }
    if (typeof command !== 'string') fail(`needs a text command for "${name}"`);
  }
}

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
    if (key === 'startupCommands') {
      validateStartupCommands(filePath, value);
    } else if (typeof value !== 'string' && !(key === 'port' && typeof value === 'number')) {
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

  // What a new terminal can run, in the order offered; the first is the default.
  let startupChoices = [];
  const single = env.CMD_LAN_STARTUP_COMMAND || (file.startupCommands ? '' : file.startupCommand);
  if (single) {
    startupChoices = [{ name: single, command: single }];
  } else if (file.startupCommands) {
    startupChoices = Object.entries(file.startupCommands).map(([name, command]) => ({ name, command }));
  }

  return {
    port,
    host: env.CMD_LAN_HOST || file.host || '0.0.0.0',
    password,
    passwordGenerated,
    shell: env.CMD_LAN_SHELL || file.shell || defaultShell,
    cwd: env.CMD_LAN_CWD || file.cwd || os.homedir(),
    startupChoices,
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
