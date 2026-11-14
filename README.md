# DevPulse — обозреватель IT-экосистемы на GraphQL Federation

Лабораторная работа №5 (СПП). Клиент-серверное приложение, которое автоматически собирает данные
из **GitHub**, **Hacker News** и **npm**, связывает их между собой и отдаёт клиенту **только через GraphQL**.

## Быстрый старт

```bash
cp .env.example .env          # по желанию: указать GITHUB_TOKEN — сбор GitHub станет в 3 раза быстрее
docker compose up -d --build
```

| Что | Адрес |
|---|---|
| Приложение (React) | http://localhost:8080 |
| GraphQL (Apollo Sandbox) | http://localhost:8080/graphql |
| Grafana (дашборд «DevPulse — обзор системы») | http://localhost:3000 |
| Jaeger (распределённые трейсы) | http://localhost:16686 |
| Prometheus | http://localhost:9090 |

При первом запуске воркеры видят пустые БД и **автоматически** начинают сбор.
Ход сбора виден в реальном времени на странице «Сбор данных» (GraphQL Subscription).
Ориентировочное время: npm ≈ 5–10 мин, Hacker News ≈ 5–10 мин, GitHub ≈ 5 мин с токеном и ≈ 15 мин без него.

Проверка схемы без Docker: `npm install && node scripts/check-schema.js`
(собирает подграфы и выполняет композицию супер-графа, результат пишется в `supergraph-api.graphql`).

## Архитектура

```
                 ┌──────────── Browser (React + Apollo Client) ────────────┐
                 │  HTTP POST /graphql (query, mutation, APQ)   WS /graphql (subscription)
                 └───────────────────────────┬─────────────────────────────┘
                                   nginx (статика + балансировка)
                                ┌────────────┴────────────┐
                           gateway #1                gateway #2        Apollo Gateway (Federation 2)
                    rate limit · depth/complexity · cost budget · load shedding · WS-подписки
                                └────────────┬────────────┘
             ┌───────────────────────────────┼───────────────────────────────┐
        repos subgraph               news subgraph                  packages subgraph
   Repository, Owner, Topic,      Story, Comment, Author,        Package, Maintainer, Dependency
   Collection (+ мутации)         + Repository.relatedStories    + Repository.packages
                                  + Topic.stories                + Topic.packages
             │                               │                               │
        PostgreSQL: repos             PostgreSQL: news              PostgreSQL: packages
             │                               │                               │
        repos-worker                  news-worker                   packages-worker
        GitHub Search API             HN Algolia API                npm registry API
             └────────────── Redis: BullMQ-очереди · кэш · Pub/Sub · rate limit ──────────────┘

        OpenTelemetry → Jaeger (трейсы)        prom-client → Prometheus → Grafana (метрики, алерты)
```

- **database-per-service**: каждый подграф владеет своей базой и ничего не знает о других;
  связи между источниками строятся только на уровне графа (ключи федерации).
- **Сущности федерации**: `Repository @key(fields: "fullName")` и `Topic @key(fields: "name")`
  определены в `repos` и расширяются подграфами `news` и `packages`. `Story.repository` и
  `Package.repository` возвращают ссылку на сущность, шлюз дорезолвливает её в `repos`.
- **Горизонтальное масштабирование**: шлюз запущен в 2 репликах (`GATEWAY_REPLICAS`), подграфы
  масштабируются `SUBGRAPH_REPLICAS`; состояние вынесено в PostgreSQL и Redis.

### Структура репозитория

```
packages/common      общий код: БД, кэш, HTTP-клиент с circuit breaker, SQL-фильтры и keyset-пагинация,
                     метрики, трассировка, запуск подграфа и воркера
services/repos       подграф и сборщик GitHub
services/news        подграф и сборщик Hacker News
services/packages    подграф и сборщик npm
gateway              Apollo Gateway: композиция, контроль нагрузки, WebSocket-подписки
frontend             React SPA (Vite, Apollo Client 4)
infra                Postgres, Prometheus (+ алерты), Grafana (провижининг дашборда)
loadtest/k6.js       нагрузочный тест
scripts              проверка композиции, генерация дашборда
```

## Соответствие требованиям

### 1. Взаимодействие backend и frontend только через GraphQL
Клиент использует единственную точку `/graphql`: запросы и мутации — HTTP POST,
подписки — WebSocket (`graphql-transport-ws`). REST-эндпоинтов для клиента нет
(`/health` и `/metrics` — служебные, для Docker и Prometheus).

### 2. Автоматизированный сбор данных из 3 источников, ≥ 10 000 записей
| Источник | API | Что собирается | Объём по умолчанию |
|---|---|---|---|
| GitHub | Search API | репозитории, владельцы, топики | ~12 000 репозиториев, ~8 000 владельцев, ~10 000 топиков |
| Hacker News | Algolia HN API | публикации, деревья комментариев, авторы | ~13 000 публикаций, ~50 000+ комментариев |
| npm | registry search + манифесты | пакеты, мейнтейнеры, граф зависимостей | ~12 000 пакетов, ~40 000+ зависимостей |

Сбор выполняют отдельные процессы-воркеры (BullMQ). Они запускаются по расписанию (cron),
при первом старте, если БД пустая, и по мутациям `syncRepositories / syncNews / syncPackages`.
Обходятся ограничения API: GitHub отдаёт не больше 1000 результатов на запрос, поэтому выборка
нарезается срезами «язык × диапазон звёзд»; Algolia обходится скользящим окном по времени.
Все записи пишутся через UPSERT, поэтому повторный запуск безопасен.

Данные разнородные: числовые метрики, тексты, даты, массивы, деревья (комментарии) и графы
(зависимости пакетов, «похожие» репозитории, совместная встречаемость топиков).

### 3. Различные типы операций, несколько уровней вложенности, динамическое формирование
- **Query**: списки, детали, агрегаты (`repositoryStats`, `newsStats`, `packageStats`).
- **Mutation**: CRUD коллекций (`create/update/deleteCollection`, `add/removeFromCollection`)
  и запуск сбора данных.
- **Subscription**: `syncProgress` — прогресс сбора в реальном времени.
- **Вложенность**: например, `repository → relatedStories → comments → replies → replies → author → stories`
  или `package → dependencies → package → dependencies → package`; уровни берутся из разных подграфов.
- **Динамическое формирование**:
  - на клиенте текст запроса собирается во время работы: выбранные колонки превращаются в набор
    полей, в том числе из других подграфов; `totalCount` включается директивой `@include`;
    глубина дерева комментариев задаётся пользователем (рекурсивных фрагментов в GraphQL нет,
    поэтому выборка генерируется); в «Конструкторе» запрос строится из дерева полей по интроспекции;
  - на сервере входной фильтр с логическими `AND / OR / NOT` произвольной вложенности
    рекурсивно транслируется в параметризованный SQL (`packages/common/src/sql.js`).

### 4. Фильтрация, сортировка, поиск и пагинация
- **Фильтрация**: типизированные операторы `IntFilter / FloatFilter / StringFilter / DateFilter`
  (`eq, ne, gt, gte, lt, lte, in, contains, startsWith`), фильтры по связям
  (`topics`, `anyTopic`, `owner`, `dependsOn`, `hasRepository`, `maintainer`).
- **Сортировка**: до трёх ключей одновременно, плюс `RELEVANCE` при поиске.
- **Поиск**: полнотекстовый поиск PostgreSQL (`tsvector`, `websearch_to_tsquery`, ранжирование
  `ts_rank`) и триграммы `pg_trgm` для поиска по подстроке в именах.
- **Пагинация**: Relay Cursor Connections (`first/after`, `last/before`, `pageInfo`, `totalCount`),
  реализована как **keyset (seek)**: стоимость любой страницы — O(log n), без `OFFSET`.

### 5. Производительность и отказоустойчивость
**Производительность**
- DataLoader в каждом подграфе: батчинг связей и `__resolveReference`, проблема N+1 снята.
- Keyset-пагинация, индексы под каждую сортировку, GIN-индексы для FTS, триграмм и массивов.
- Кэш Redis для агрегатов и `totalCount`; сбрасывается автоматически после синхронизации.
- `totalCount` и поля статистики вычисляются лениво, только если их запросили.
- Automatic Persisted Queries: клиент отправляет хэш запроса вместо текста.
- Денормализованные агрегаты (число репозиториев и звёзд владельца, статистика авторов и мейнтейнеров).

**Отказоустойчивость**
- **Частичные ответы федерации**: при падении подграфа шлюз возвращает данные остальных
  (`data` + `errors`), а клиент показывает предупреждение вместо пустой страницы.
- Circuit breaker (opossum), ретраи с exponential backoff + jitter, таймауты и учёт rate limit
  (`Retry-After`, `X-RateLimit-Reset`) при обращении к внешним API.
- Повтор заданий сбора (BullMQ attempts + backoff), идемпотентные UPSERT, восстановление
  после рестарта воркера.
- Таймауты запросов шлюза к подграфам, `statement_timeout` в PostgreSQL.
- Graceful degradation: если Redis недоступен, кэш и rate limit просто пропускаются.
- Healthchecks, `restart: unless-stopped`, graceful shutdown, несколько реплик шлюза за nginx.
- На клиенте RetryLink повторяет запросы при сетевых ошибках и ответах 502/503/504.

### Дополнительно 1: контроль нагрузки, мониторинг и трассировка
**Контроль нагрузки (шлюз)**
| Механизм | Параметр | По умолчанию |
|---|---|---|
| Ограничение глубины запроса | `MAX_QUERY_DEPTH` | 12 |
| Ограничение сложности (стоимость = Σ размер страницы × стоимость потомков) | `MAX_QUERY_COMPLEXITY` | 5000 |
| Поминутный бюджет стоимости на клиента (Redis) | `COST_BUDGET_PER_MIN` | 100 000 |
| Rate limit запросов на IP (Redis, общий для реплик) | `RATE_LIMIT_PER_MIN` | 600 |
| Load shedding: максимум одновременных запросов, сверх — 503 | `MAX_INFLIGHT_REQUESTS` | 200 |
| Лимиты размера тела, страницы (≤100), вложенности фильтра (≤6) | — | — |

Стоимость каждого запроса возвращается клиенту в `extensions.cost` и выводится в интерфейсе.

**Мониторинг**: все сервисы отдают метрики Prometheus: латентность и ошибки GraphQL по операциям,
сложность запросов, отказы контроля нагрузки, SQL, попадания в кэш, запросы к внешним API,
состояние circuit breaker, ход сбора данных, метрики Node.js. Grafana поднимается с готовым
дашбордом, в Prometheus настроены алерты (`infra/prometheus/alerts.yml`).

**Трассировка**: OpenTelemetry с автоинструментацией (http, express, graphql, pg, ioredis, fetch).
Трейс запроса проходит nginx → шлюз → подграфы → PostgreSQL/Redis и виден в Jaeger;
`trace_id` пишется в каждую строку JSON-логов.

**Нагрузочный тест** (k6):
```bash
docker run --rm -i --network devpulse_default -e TARGET=http://gateway:4000/graphql grafana/k6 run - < loadtest/k6.js
```

### Дополнительно 2: GraphQL Federation и распределённая архитектура
Apollo Federation 2: три независимых подграфа со своими БД; шлюз собирает супер-граф
интроспекцией (`IntrospectAndCompose`) и перечитывает его каждые 30 с. Обмен между сервисами
идёт асинхронно через очереди BullMQ и Redis Pub/Sub. API, воркеры и шлюз масштабируются
независимо.

## Примеры запросов

```graphql
# Динамический фильтр с логикой AND / OR / NOT, сортировка по 2 ключам, курсорная пагинация
query {
  repositories(
    first: 10
    filter: {
      AND: [
        { stars: { gte: 5000 } }
        { OR: [{ language: { eq: "Rust" } }, { language: { eq: "Go" } }] }
        { NOT: { archived: true } }
      ]
    }
    sort: [{ field: PUSHED_AT, direction: DESC }, { field: STARS }]
  ) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      fullName stars language
      relatedStories(first: 2) { title points }   # подграф news
      packages { name monthlyDownloads }          # подграф packages
    }
  }
}

# Одна сущность — три подграфа
query { topic(name: "graphql") { repositoryCount packageCount stories(first: 3) { title } } }

# Мутация и подписка
mutation { syncNews { id status } }
subscription { syncProgress { source status processed message } }
```

## Демонстрация отказоустойчивости

```bash
docker compose stop news       # остановить подграф
# в UI страницы репозиториев и топиков продолжают работать; блок HN показывает предупреждение,
# в ответе GraphQL есть и data, и errors
docker compose start news      # шлюз восстанавливается сам
```
