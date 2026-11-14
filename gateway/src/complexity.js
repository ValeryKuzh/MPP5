'use strict';

const { GraphQLError, getNamedType, getNullableType, isListType } = require('graphql');
const { getComplexity } = require('graphql-query-complexity');
const { metrics, int, logger } = require('@devpulse/common');

const MAX_COMPLEXITY = int('MAX_QUERY_COMPLEXITY', 5000);
const COST_BUDGET_PER_MIN = int('COST_BUDGET_PER_MIN', 100000);
const DEFAULT_LIST_SIZE = 5;
const DEFAULT_PAGE_SIZE = 20;

/**
 * Оценка стоимости поля:
 *   стоимость = 1 + множитель * стоимость_потомков,
 * где множитель — запрошенный размер страницы (first/last/limit) для списков
 * и Connection, либо значение по умолчанию. Так запрос
 * repositories(first: 100) { nodes { owner { repositories(first: 100) {...} } } }
 * получает стоимость ~10^4 и отклоняется ещё до выполнения.
 */
function estimator({ args, childComplexity, field, type }) {
  const named = getNamedType(field.type);
  const isConnection = /Connection$/.test(named.name);
  const isList = isListType(getNullableType(field.type));
  const requested = args.first ?? args.last ?? args.limit;
  let multiplier = 1;
  if (isConnection) multiplier = requested ?? DEFAULT_PAGE_SIZE;
  else if (isList && !/Connection$/.test(type.name)) multiplier = requested ?? DEFAULT_LIST_SIZE;
  return 1 + Math.max(1, multiplier) * childComplexity;
}

/**
 * Плагин Apollo Server:
 *  1) вычисляет сложность операции и отклоняет слишком "дорогие" запросы;
 *  2) списывает сложность из поминутного бюджета клиента (Redis) — защита от
 *     множества дешёвых, но частых запросов; при недоступности Redis — пропускаем;
 *  3) возвращает информацию о стоимости в extensions.cost ответа.
 */
function complexityPlugin({ redis }) {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ request, document, schema, contextValue }) {
          const complexity = getComplexity({
            schema,
            query: document,
            variables: request.variables || {},
            operationName: request.operationName,
            estimators: [estimator],
          });
          metrics.gqlComplexity.observe(complexity);
          contextValue.cost = { complexity, maxComplexity: MAX_COMPLEXITY };

          if (complexity > MAX_COMPLEXITY) {
            metrics.rateLimited.inc({ reason: 'complexity' });
            throw new GraphQLError(`Query is too complex: ${complexity}. Maximum allowed complexity: ${MAX_COMPLEXITY}`, {
              extensions: { code: 'QUERY_TOO_COMPLEX', complexity, maxComplexity: MAX_COMPLEXITY, http: { status: 400 } },
            });
          }

          const key = `ratelimit:cost:${contextValue.clientId}:${Math.floor(Date.now() / 60000)}`;
          let used;
          try {
            used = await redis.incrby(key, complexity);
            if (used === complexity) await redis.expire(key, 70);
          } catch (err) {
            logger.debug({ err: err.message }, 'cost budget unavailable (redis), skipping');
            return;
          }
          contextValue.cost.budget = COST_BUDGET_PER_MIN;
          contextValue.cost.remaining = Math.max(0, COST_BUDGET_PER_MIN - used);
          if (used > COST_BUDGET_PER_MIN) {
            metrics.rateLimited.inc({ reason: 'cost_budget' });
            throw new GraphQLError('Query cost budget exceeded, retry in a minute', {
              extensions: { code: 'RATE_LIMITED', budget: COST_BUDGET_PER_MIN, http: { status: 429 } },
            });
          }
        },
        async willSendResponse({ response, contextValue }) {
          if (response.body.kind === 'single' && contextValue.cost) {
            const result = response.body.singleResult;
            result.extensions = { ...(result.extensions || {}), cost: contextValue.cost };
          }
        },
      };
    },
  };
}

module.exports = { complexityPlugin, estimator, MAX_COMPLEXITY };
