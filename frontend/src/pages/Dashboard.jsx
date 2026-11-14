import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { Link } from 'react-router-dom';
import { Bars, Columns, Stat } from '../components/Charts.jsx';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { MetaLine, useOperationMeta } from '../components/QueryInspector.jsx';
import { num, short } from '../format.js';

// Один запрос — данные из трёх подграфов собирает федеративный шлюз
const DASHBOARD = gql`
  query Dashboard {
    repositoryStats {
      totalRepositories
      totalOwners
      totalTopics
      totalStars
      byLanguage(limit: 12) { language repositoryCount avgStars }
      byLicense(limit: 8) { license repositoryCount }
      createdByYear { year count }
    }
    newsStats {
      totalStories
      totalComments
      totalAuthors
      storiesWithRepository
      topDomains(limit: 10) { domain storyCount }
      storiesByYear { year count }
    }
    packageStats {
      totalPackages
      totalMaintainers
      totalDependencies
      totalMonthlyDownloads
      topKeywords(limit: 12) { keyword packageCount }
      mostDependedUpon(limit: 10) { name dependentCount }
    }
    topics(first: 30) { name repositoryCount }
  }
`;

export default function Dashboard() {
  const { data, loading, error } = useQuery(DASHBOARD);
  const meta = useOperationMeta('Dashboard');
  if (!data && loading) return <Loading />;
  const r = data?.repositoryStats;
  const n = data?.newsStats;
  const p = data?.packageStats;
  const totalRecords =
    (r?.totalRepositories ?? 0) +
    (r?.totalOwners ?? 0) +
    (n?.totalStories ?? 0) +
    (n?.totalComments ?? 0) +
    (p?.totalPackages ?? 0) +
    (p?.totalDependencies ?? 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Обзор</h1>
          <div className="muted">GitHub · Hacker News · npm — данные трёх подграфов в одном GraphQL-запросе</div>
        </div>
        <MetaLine meta={meta} />
      </div>
      <ErrorBox error={error} partial={Boolean(data)} />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Всего записей" value={num(totalRecords)} sub="во всех источниках" highlight />
        <Stat label="Репозитории GitHub" value={num(r?.totalRepositories)} sub={`${num(r?.totalOwners)} владельцев · ${num(r?.totalTopics)} топиков`} />
        <Stat label="Hacker News" value={num(n?.totalStories)} sub={`${num(n?.totalComments)} комментариев · ${num(n?.totalAuthors)} авторов`} />
        <Stat label="npm-пакеты" value={num(p?.totalPackages)} sub={`${num(p?.totalDependencies)} зависимостей · ${short(p?.totalMonthlyDownloads)} загрузок/мес`} />
      </div>

      <div className="grid grid-3">
        <div className="panel">
          <h2>Языки программирования</h2>
          {r && (
            <Bars
              items={r.byLanguage.map((l) => ({ label: l.language, value: l.repositoryCount }))}
              format={num}
            />
          )}
        </div>
        <div className="panel">
          <h2>Популярные домены на HN</h2>
          {n && <Bars items={n.topDomains.map((d) => ({ label: d.domain, value: d.storyCount }))} format={num} />}
        </div>
        <div className="panel">
          <h2>Самые используемые npm-зависимости</h2>
          {p && (
            <Bars
              items={p.mostDependedUpon.map((d) => ({ label: d.name, value: d.dependentCount, to: `/packages/${d.name}` }))}
              format={num}
            />
          )}
        </div>
        <div className="panel">
          <h2>Репозитории по году создания</h2>
          <Columns items={r?.createdByYear} />
        </div>
        <div className="panel">
          <h2>Публикации HN по годам</h2>
          <Columns items={n?.storiesByYear} />
          <p className="small muted">
            Со ссылкой на GitHub: <strong>{num(n?.storiesWithRepository)}</strong>
          </p>
        </div>
        <div className="panel">
          <h2>Ключевые слова npm</h2>
          {p && <Bars items={p.topKeywords.map((k) => ({ label: k.keyword, value: k.packageCount, to: `/topics/${k.keyword}` }))} format={num} />}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h2>Популярные топики</h2>
        <div className="chips">
          {data?.topics.map((t) => (
            <Link key={t.name} className="chip" to={`/topics/${t.name}`}>
              {t.name} · {t.repositoryCount}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
