'use strict';

/**
 * Проверка без запуска инфраструктуры: каждый подграф собирается
 * buildSubgraphSchema, затем выполняется композиция супер-графа
 * (те же правила, что применяет шлюз). Запуск: node scripts/check-schema.js
 */
process.env.OTEL_SDK_DISABLED = 'true';

const fs = require('node:fs');
const path = require('node:path');
const gql = require('graphql-tag');
const { buildSubgraphSchema } = require('@apollo/subgraph');
const { composeServices } = require('@apollo/composition');
const { printSchema } = require('graphql');
const { commonTypeDefs } = require('@devpulse/common');

const services = ['repos', 'news', 'packages'].map((name) => {
  const dir = path.join(__dirname, '..', 'services', name, 'src');
  const typeDefs = gql(fs.readFileSync(path.join(dir, 'schema.graphql'), 'utf8') + commonTypeDefs);
  const { resolvers } = require(path.join(dir, 'resolvers.js'));
  buildSubgraphSchema([{ typeDefs, resolvers }]);
  console.log(`✔ subgraph "${name}" builds`);
  return { name, url: `http://${name}/graphql`, typeDefs };
});

const result = composeServices(services);
if (result.errors?.length) {
  console.error('✘ composition failed:');
  for (const e of result.errors) console.error('  -', e.message);
  process.exit(1);
}
for (const h of result.hints || []) console.log('  hint:', h.message?.split('\n')[0]);
const out = path.join(__dirname, '..', 'supergraph-api.graphql');
fs.writeFileSync(out, printSchema(result.schema.toAPISchema().toGraphQLJSSchema()));
console.log(`✔ supergraph composed, API schema written to ${path.relative(process.cwd(), out)}`);
