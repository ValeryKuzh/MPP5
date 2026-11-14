/**
 * Нагрузочный тест шлюза (k6, https://k6.io).
 *
 *   docker run --rm -i --network devpulse_default -e TARGET=http://gateway:4000/graphql grafana/k6 run - < loadtest/k6.js
 *
 * Сценарии: смешанное чтение (списки, детали, поиск) с ростом до 50 виртуальных пользователей
 * + отдельный сценарий "злоупотребления" — слишком сложные запросы, которые должны отклоняться.
 * Во время теста смотрите дашборд Grafana (http://localhost:3000).
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const TARGET = __ENV.TARGET || 'http://localhost:8080/graphql';
const rejected = new Counter('rejected_by_load_control');

export const options = {
  scenarios: {
    readers: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 50 },
        { duration: '30s', target: 0 },
      ],
      exec: 'readers',
    },
    abusers: {
      executor: 'constant-vus',
      vus: 2,
      duration: '1m',
      startTime: '30s',
      exec: 'abusers',
    },
  },
  thresholds: {
    'http_req_duration{scenario:readers}': ['p(95)<800'],
    'checks{scenario:readers}': ['rate>0.98'],
  },
};

const QUERIES = [
  {
    operationName: 'LoadRepoList',
    query: `query LoadRepoList($after: String, $lang: String) {
      repositories(first: 20, after: $after, filter: { language: { eq: $lang }, stars: { gte: 500 } }, sort: [{ field: STARS }]) {
        totalCount pageInfo { endCursor } nodes { fullName stars owner { login } topics { name } }
      }
    }`,
    variables: () => ({ lang: ['Go', 'Rust', 'TypeScript', 'Python', 'Java'][Math.floor(Math.random() * 5)] }),
  },
  {
    operationName: 'LoadSearch',
    query: `query LoadSearch($q: String!) {
      repositories(first: 10, search: $q) { nodes { fullName stars hnMentions } }
      stories(first: 10, search: $q) { nodes { id title points } }
      packages(first: 10, search: $q) { nodes { name monthlyDownloads } }
    }`,
    variables: () => ({ q: ['database', 'react', 'compiler', 'graphql', 'machine learning', 'terminal'][Math.floor(Math.random() * 6)] }),
  },
  {
    operationName: 'LoadTopic',
    query: `query LoadTopic($name: String!) {
      topic(name: $name) { name repositoryCount packageCount
        repositories(first: 5) { nodes { fullName } } stories(first: 5) { title } packages(first: 5) { name } }
    }`,
    variables: () => ({ name: ['javascript', 'python', 'rust', 'react', 'cli', 'database'][Math.floor(Math.random() * 6)] }),
  },
  {
    operationName: 'LoadStats',
    query: `query LoadStats {
      repositoryStats { totalRepositories byLanguage(limit: 10) { language repositoryCount } }
      newsStats { totalStories topDomains(limit: 5) { domain storyCount } }
      packageStats { totalPackages topKeywords(limit: 10) { keyword packageCount } }
    }`,
    variables: () => ({}),
  },
];

const headers = { 'Content-Type': 'application/json' };

export function readers() {
  const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const res = http.post(TARGET, JSON.stringify({ operationName: q.operationName, query: q.query, variables: q.variables() }), {
    headers,
    tags: { operation: q.operationName },
  });
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'no errors': (r) => !r.json('errors'),
  });
  if (!ok && (res.status === 429 || res.status === 503)) rejected.add(1);
  sleep(Math.random() * 0.5);
}

export function abusers() {
  const res = http.post(
    TARGET,
    JSON.stringify({
      query: `{ repositories(first: 100) { nodes { owner { repositories(first: 100) { nodes { topics { repositories(first: 100) { nodes { fullName } } } } } } } } }`,
    }),
    { headers },
  );
  const rejectedOk = check(res, {
    'complex query rejected': (r) => r.status === 400 || (r.json('errors.0.extensions.code') || '') === 'QUERY_TOO_COMPLEX',
  });
  if (rejectedOk) rejected.add(1);
  sleep(0.2);
}
