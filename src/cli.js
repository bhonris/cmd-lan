#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const { loadConfig, readConfigFile, lanAddresses } = require('./config');
const { createApp } = require('./server');

let config;
try {
  const file = readConfigFile(path.join(__dirname, '..', 'cmd-lan.config.json'));
  config = loadConfig(process.env, process.platform, file);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const app = createApp(config);

app.server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Set CMD_LAN_PORT to a different port.`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

app.server.listen(config.port, config.host, () => {
  const lanOnly = config.host === '127.0.0.1' || config.host === 'localhost';
  const hosts = config.host === '0.0.0.0' ? lanAddresses() : lanOnly ? [] : [config.host];
  console.log(`cmd-lan is sharing ${config.shell} on ${os.hostname()}`);
  const choices = config.startupChoices.map((choice) => choice.name).join(' or ');
  console.log(`Terminals open in ${config.cwd}${choices ? ` and run: ${choices}` : ''}\n`);
  console.log(`  This computer:   http://localhost:${config.port}`);
  for (const host of hosts) console.log(`  Other computers: http://${host}:${config.port}`);
  console.log(`\n  Password: ${config.password}${config.passwordGenerated ? '  (new each start; set CMD_LAN_PASSWORD to keep one)' : ''}`);
  console.log('\nAnyone with this password can run commands on this PC. Press Ctrl+C to stop.');
});

process.on('SIGINT', () => {
  app.close().then(() => process.exit(0));
});
