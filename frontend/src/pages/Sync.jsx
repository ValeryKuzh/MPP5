import { useState } from 'react';
import { gql } from '@apollo/client';
import { useMutation, useQuery, useSubscription } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { dateTime, num } from '../format.js';

const RUN_FIELDS = 'id source status processed message error createdAt startedAt finishedAt';

const RUNS = gql`
  query SyncRuns {
    repositorySyncRuns(limit: 5) { ${RUN_FIELDS} }
    newsSyncRuns(limit: 5) { ${RUN_FIELDS} }
    packageSyncRuns(limit: 5) { ${RUN_FIELDS} }
    repositoryStats { totalRepositories totalOwners }
    newsStats { totalStories totalComments }
    packageStats { totalPackages totalDependencies }
  }
`;

const SYNC = {
  repos: gql`mutation SyncRepositories { syncRepositories { ${RUN_FIELDS} } }`,
  news: gql`mutation SyncNews { syncNews { ${RUN_FIELDS} } }`,
  packages: gql`mutation SyncPackages { syncPackages { ${RUN_FIELDS} } }`,
};

// Подписка по WebSocket: события публикуют воркеры через Redis Pub/Sub
const PROGRESS = gql`
  subscription SyncProgress($source: String) {
    syncProgress(source: $source) { source runId status processed message error at }
  }
`;

const SOURCES = [
  { key: 'repos', title: 'GitHub', runsField: 'repositorySyncRuns', api: 'api.github.com/search/repositories' },
  { key: 'news', title: 'Hacker News', runsField: 'newsSyncRuns', api: 'hn.algolia.com/api/v1' },
  { key: 'packages', title: 'npm', runsField: 'packageSyncRuns', api: 'registry.npmjs.org' },
];

const STATUS_CLASS = { COMPLETED: 'ok', FAILED: 'err', RUNNING: 'run', QUEUED: 'warn' };

function SourceCard({ source, runs, live, counts, onRefetch }) {
  const [sync, state] = useMutation(SYNC[source.key]);
  const current = live ?? runs?.[0];
  return (
    <div className="panel">
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{source.title}</h2>
        <button
          className="primary"
          disabled={state.loading || current?.status === 'RUNNING' || current?.status === 'QUEUED'}
          onClick={async () => {
            await sync().catch(() => {});
            onRefetch();
          }}
        >
          ⟳ Запустить сбор
        </button>
      </div>
      <p className="small muted">{source.api}</p>
      <p className="small">{counts}</p>
      <ErrorBox error={state.error} />
      {current && (
        <div style={{ marginBottom: 12 }}>
          <span className={`badge ${STATUS_CLASS[current.status]}`}>{current.status}</span>{' '}
          <span className="small">обработано: {num(current.processed)}</span>
          {current.message && <div className="small muted">{current.message}</div>}
          {current.error && <div className="small" style={{ color: 'var(--err)' }}>{current.error}</div>}
          {current.status === 'RUNNING' && (
            <div className="progress" style={{ marginTop: 6 }}>
              <div style={{ width: '100%', opacity: 0.5 }} />
            </div>
          )}
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Статус</th>
            <th className="num">Записей</th>
            <th>Начало</th>
            <th>Окончание</th>
          </tr>
        </thead>
        <tbody>
          {runs?.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td><span className={`badge ${STATUS_CLASS[r.status]}`}>{r.status}</span></td>
              <td className="num">{num(r.processed)}</td>
              <td className="small">{dateTime(r.startedAt ?? r.createdAt)}</td>
              <td className="small">{dateTime(r.finishedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Sync() {
  const { data, loading, error, refetch } = useQuery(RUNS, { pollInterval: 15000 });
  const [events, setEvents] = useState([]);
  const [live, setLive] = useState({});

  const { error: subError } = useSubscription(PROGRESS, {
    onData: ({ data: { data: d } }) => {
      const e = d?.syncProgress;
      if (!e) return;
      setLive((l) => ({ ...l, [e.source]: { ...e, id: e.runId } }));
      setEvents((list) => [e, ...list].slice(0, 200));
      if (e.status === 'COMPLETED' || e.status === 'FAILED') refetch();
    },
  });

  if (!data && loading) return <Loading />;
  const counts = {
    repos: data && `${num(data.repositoryStats?.totalRepositories)} репозиториев, ${num(data.repositoryStats?.totalOwners)} владельцев`,
    news: data && `${num(data.newsStats?.totalStories)} публикаций, ${num(data.newsStats?.totalComments)} комментариев`,
    packages: data && `${num(data.packageStats?.totalPackages)} пакетов, ${num(data.packageStats?.totalDependencies)} зависимостей`,
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Автоматический сбор данных</h1>
          <div className="muted">
            Воркеры BullMQ: запуск по расписанию (cron), при первом старте и по мутации. Прогресс — GraphQL-подпиской в реальном времени.
          </div>
        </div>
      </div>
      <ErrorBox error={error} partial={Boolean(data)} />
      <div className="grid grid-3">
        {SOURCES.map((s) => (
          <SourceCard key={s.key} source={s} runs={data?.[s.runsField]} live={live[s.key]} counts={counts[s.key]} onRefetch={refetch} />
        ))}
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <h2>
          События подписки <code>syncProgress</code> {subError ? <span className="badge err">WebSocket: {subError.message}</span> : <span className="badge ok">online</span>}
        </h2>
        <div className="event-log">
          {events.length === 0 && <div className="muted">Ожидание событий… запустите сбор любого источника</div>}
          {events.map((e, i) => (
            <div key={i}>
              {new Date(e.at).toLocaleTimeString()} [{e.source}] #{e.runId} {e.status} {num(e.processed)} {e.message ?? ''}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
