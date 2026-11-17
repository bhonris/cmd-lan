'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, readConfigFile, lanAddresses } = require('../src/config');

test('loadConfig defaults to all interfaces, port 3000 and a generated password', () => {
  const config = loadConfig({}, 'win32');
  assert.equal(config.port, 3000);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.shell, 'powershell.exe');
  assert.equal(config.cwd, os.homedir());
  assert.equal(config.startupCommand, '');
  assert.equal(config.passwordGenerated, true);
  assert.equal(config.password.length, 16);
  assert.notEqual(loadConfig({}, 'win32').password, config.password);
});

test('loadConfig reads overrides from the environment', () => {
  const config = loadConfig(
    {
      CMD_LAN_PORT: '8022',
      CMD_LAN_HOST: '192.168.1.10',
      CMD_LAN_PASSWORD: 'correct horse',
      CMD_LAN_SHELL: 'cmd.exe',
      CMD_LAN_CWD: 'C:\\work',
    },
    'win32'
  );
  assert.deepEqual(config, {
    port: 8022,
    host: '192.168.1.10',
    password: 'correct horse',
    passwordGenerated: false,
    shell: 'cmd.exe',
    cwd: 'C:\\work',
    startupCommand: '',
  });
});

test('loadConfig uses the settings file, and the environment wins over it', () => {
  const file = {
    port: 8080,
    host: '10.0.0.1',
    password: 'from-the-file',
    shell: 'pwsh.exe',
    cwd: 'C:\\repos\\project',
    startupCommand: 'claude',
  };
  assert.deepEqual(loadConfig({}, 'win32', file), { ...file, passwordGenerated: false });

  const overridden = loadConfig(
    {
      CMD_LAN_PORT: '9090',
      CMD_LAN_HOST: '127.0.0.1',
      CMD_LAN_PASSWORD: 'from-the-env',
      CMD_LAN_SHELL: 'cmd.exe',
      CMD_LAN_CWD: 'D:\\',
      CMD_LAN_STARTUP_COMMAND: 'dir',
    },
    'win32',
    file
  );
  assert.deepEqual(overridden, {
    port: 9090,
    host: '127.0.0.1',
    password: 'from-the-env',
    passwordGenerated: false,
    shell: 'cmd.exe',
    cwd: 'D:\\',
    startupCommand: 'dir',
  });

  assert.equal(loadConfig({}, 'win32', { port: '8022' }).port, 8022);
  assert.throws(() => loadConfig({}, 'win32', { port: 0 }), /port must be/);
  assert.throws(() => loadConfig({}, 'win32', { password: 'short' }), /at least 8 characters/);
});

test('readConfigFile returns saved settings, or nothing when the file is absent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-lan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cmd-lan.config.json');

  assert.deepEqual(readConfigFile(file), {});

  fs.writeFileSync(file, '\uFEFF{"cwd": "C:\\\\repos\\\\iso-27001", "startupCommand": "claude", "port": 3001}');
  assert.deepEqual(readConfigFile(file), { cwd: 'C:\\repos\\iso-27001', startupCommand: 'claude', port: 3001 });

  // Anything other than "file not found" is a real error.
  assert.throws(() => readConfigFile(dir), (err) => err.code !== 'ENOENT');
});

test('readConfigFile explains what is wrong with a bad file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-lan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cmd-lan.config.json');
  const read = (text) => {
    fs.writeFileSync(file, text);
    return () => readConfigFile(file);
  };

  assert.throws(read('{ not json'), /is not valid JSON/);
  assert.throws(read('null'), /must contain a JSON object/);
  assert.throws(read('["claude"]'), /must contain a JSON object/);
  assert.throws(read('{"startupComand": "claude"}'), /unknown setting "startupComand"/);
  assert.throws(read('{"startupCommand": ["claude"]}'), /"startupCommand" must be a string$/);
  assert.throws(read('{"cwd": 5}'), /"cwd" must be a string$/);
  assert.throws(read('{"port": true}'), /"port" must be a string or number/);
});

test('loadConfig picks the user shell off Windows', () => {
  assert.equal(loadConfig({ SHELL: '/bin/zsh' }, 'linux').shell, '/bin/zsh');
  assert.equal(loadConfig({}, 'linux').shell, 'bash');
});

test('loadConfig rejects bad ports and short passwords', () => {
  for (const port of ['0', '70000', 'abc', '80.5', '']) {
    assert.throws(() => loadConfig({ CMD_LAN_PORT: port }), /port must be/, `port "${port}"`);
  }
  assert.throws(() => loadConfig({ CMD_LAN_PASSWORD: 'short' }), /at least 8 characters/);
});

test('lanAddresses lists external IPv4 addresses only', () => {
  const addresses = lanAddresses({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth: [
      { family: 'IPv6', internal: false, address: 'fe80::1' },
      { family: 'IPv4', internal: false, address: '192.168.1.20' },
    ],
    wifi: [{ family: 'IPv4', internal: false, address: '10.0.0.7' }],
    gone: undefined,
  });
  assert.deepEqual(addresses, ['192.168.1.20', '10.0.0.7']);
  assert.ok(Array.isArray(lanAddresses()));
});
