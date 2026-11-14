import { ApolloClient, ApolloLink, HttpLink, InMemoryCache, split } from '@apollo/client';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { PersistedQueryLink } from '@apollo/client/link/persisted-queries';
import { RetryLink } from '@apollo/client/link/retry';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';
import { map } from 'rxjs';

/**
 * Единственный канал связи frontend <-> backend — GraphQL:
 *   query / mutation -> HTTP POST /graphql (Automatic Persisted Queries + повторы при сбоях)
 *   subscription     -> WebSocket /graphql (протокол graphql-transport-ws)
 */

const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/graphql`;

const wsLink = new GraphQLWsLink(
  createClient({
    url: wsUrl,
    lazy: true,
    retryAttempts: Infinity,
    shouldRetry: () => true,
  }),
);

/** Публикует метаданные каждого ответа (длительность, стоимость запроса) для инспектора запросов. */
const metaLink = new ApolloLink((operation, forward) => {
  const started = performance.now();
  return forward(operation).pipe(
    map((result) => {
      window.dispatchEvent(
        new CustomEvent('graphql-meta', {
          detail: {
            operationName: operation.operationName,
            durationMs: Math.round(performance.now() - started),
            cost: result.extensions?.cost ?? null,
            errors: result.errors?.map((e) => e.extensions?.code || e.message) ?? [],
            at: Date.now(),
          },
        }),
      );
      return result;
    }),
  );
});

/** Повтор при сетевых сбоях и перегрузке (503) с экспоненциальной задержкой. Мутации не повторяем. */
const retryLink = new RetryLink({
  delay: { initial: 400, max: 5000, jitter: true },
  attempts: {
    max: 4,
    retryIf: (error, operation) => {
      const def = getMainDefinition(operation.query);
      if (def.kind === 'OperationDefinition' && def.operation === 'mutation') return false;
      const status = error?.statusCode;
      return !status || status === 503 || status === 502 || status === 504;
    },
  },
});

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const httpChain = ApolloLink.from([
  retryLink,
  metaLink,
  // APQ: вместо текста запроса отправляется его хэш — экономия трафика на больших запросах
  ...(globalThis.crypto?.subtle ? [new PersistedQueryLink({ sha256 })] : []),
  new HttpLink({ uri: '/graphql' }),
]);

const link = split(
  ({ query }) => {
    const def = getMainDefinition(query);
    return def.kind === 'OperationDefinition' && def.operation === 'subscription';
  },
  wsLink,
  httpChain,
);

export const client = new ApolloClient({
  link,
  cache: new InMemoryCache({
    // Нормализация по естественным ключам сущностей федерации
    typePolicies: {
      Repository: { keyFields: ['fullName'] },
      Owner: { keyFields: ['login'] },
      Topic: { keyFields: ['name'] },
      Author: { keyFields: ['name'] },
      Package: { keyFields: ['name'] },
      Maintainer: { keyFields: ['name'] },
      Story: { keyFields: ['id'] },
      Comment: { keyFields: ['id'] },
      Collection: { keyFields: ['id'] },
      RepositoryStats: { keyFields: [] },
      NewsStats: { keyFields: [] },
      PackageStats: { keyFields: [] },
      Dependency: { keyFields: false },
    },
  }),
  defaultOptions: {
    // частичные данные + ошибки: если один подграф недоступен, страница всё равно отображается
    watchQuery: { errorPolicy: 'all', fetchPolicy: 'cache-and-network' },
    query: { errorPolicy: 'all' },
  },
});
