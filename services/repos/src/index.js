'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { startSubgraph, commonTypeDefs, logger } = require('@devpulse/common');
const { resolvers } = require('./resolvers');
const { createLoaders } = require('./loaders');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

startSubgraph({
  source: 'repos',
  typeDefs: read('schema.graphql') + commonTypeDefs,
  resolvers,
  migrations: read('migrations.sql'),
  createLoaders,
}).catch((err) => {
  logger.fatal({ err }, 'repos subgraph failed to start');
  process.exit(1);
});
