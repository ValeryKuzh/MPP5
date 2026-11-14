'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { startWorker, logger } = require('@devpulse/common');
const { collect, isEmpty } = require('./collector');

startWorker({
  source: 'repos',
  migrations: fs.readFileSync(path.join(__dirname, 'migrations.sql'), 'utf8'),
  collect,
  isEmpty,
}).catch((err) => {
  logger.fatal({ err }, 'repos worker failed to start');
  process.exit(1);
});
