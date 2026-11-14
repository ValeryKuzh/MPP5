import { Link, useParams } from 'react-router-dom';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { MetaLine, useOperationMeta } from '../components/QueryInspector.jsx';
import { date, num, repoPath, short } from '../format.js';

// Одна сущность Topic, поля которой резолвят три разных подграфа
const TOPIC = gql`
  query TopicDetail($name: String!) {
    topic(name: $name) {
      name
      repositoryCount
      related(first: 15) { count topic { name } }
      repositories(first: 10) {
        totalCount
        nodes { fullName description stars language owner { avatarUrl } }
      }
      stories(first: 10) { id title points commentCount createdAt }
      packageCount
      packages(first: 10) { name description monthlyDownloads }
    }
  }
`;

export default function TopicDetail() {
  const { name } = useParams();
  const { data, loading, error } = useQuery(TOPIC, { variables: { name } });
  const meta = useOperationMeta('TopicDetail');
  if (!data && loading) return <Loading />;
  const t = data?.topic;
  if (!t) {
    return (
      <div>
        <h1>#{name}</h1>
        <ErrorBox error={error ?? { message: 'Топик не найден среди репозиториев GitHub' }} />
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>#{t.name}</h1>
          <div className="muted">
            {num(t.repositoryCount)} репозиториев · {num(t.packageCount)} npm-пакетов
          </div>
        </div>
        <MetaLine meta={meta} />
      </div>
      <ErrorBox error={error} partial />
      {t.related.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3>Часто встречается вместе с</h3>
          <div className="chips">
            {t.related.map((r) => (
              <Link key={r.topic.name} className="chip" to={`/topics/${r.topic.name}`}>
                {r.topic.name} · {r.count}
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="grid grid-3">
        <div className="panel">
          <h2>Репозитории <span className="badge">repos</span></h2>
          <ul className="list">
            {t.repositories.nodes.map((r) => (
              <li key={r.fullName}>
                <img className="avatar sm" src={r.owner.avatarUrl} alt="" />
                <Link to={repoPath(r.fullName)}>{r.fullName}</Link> <span className="small muted">★ {short(r.stars)}</span>
                <div className="small muted">{r.description?.slice(0, 120)}</div>
              </li>
            ))}
          </ul>
          <p className="small">
            <Link to="/repos">Все {num(t.repositories.totalCount)} → фильтр «Топики» в списке репозиториев</Link>
          </p>
        </div>
        <div className="panel">
          <h2>Hacker News <span className="badge">news</span></h2>
          {!t.stories?.length && <p className="small muted">Нет публикаций</p>}
          <ul className="list">
            {t.stories?.map((s) => (
              <li key={s.id}>
                <Link to={`/stories/${s.id}`}>{s.title}</Link>
                <div className="small muted">
                  {s.points} очков · {s.commentCount} комм. · {date(s.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2>npm-пакеты <span className="badge">packages</span></h2>
          {!t.packages?.length && <p className="small muted">Нет пакетов с таким ключевым словом</p>}
          <ul className="list">
            {t.packages?.map((p) => (
              <li key={p.name}>
                <Link to={`/packages/${p.name}`}>{p.name}</Link> <span className="small muted">{short(p.monthlyDownloads)}/мес</span>
                <div className="small muted">{p.description?.slice(0, 120)}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
