import { useState } from 'react';
import { Link } from 'react-router-dom';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { Bars } from '../components/Charts.jsx';

const TOPICS = gql`
  query TopicList($first: Int, $search: String, $min: Int) {
    topics(first: $first, search: $search, minRepositories: $min) {
      name
      repositoryCount
    }
  }
`;

export default function Topics() {
  const [search, setSearch] = useState('');
  const [min, setMin] = useState(3);
  const [first, setFirst] = useState(100);
  const { data, previousData, loading, error } = useQuery(TOPICS, {
    variables: { first, search: search.trim() || null, min },
  });
  const topics = (data ?? previousData)?.topics;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Топики</h1>
          <div className="muted">
            Топик — общая сущность федерации: репозитории (repos), публикации (news) и пакеты (packages)
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="toolbar">
          <input className="search" type="search" placeholder="Поиск топика…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="small">
            Мин. репозиториев <input type="number" min={1} value={min} onChange={(e) => setMin(Number(e.target.value) || 1)} style={{ width: 70 }} />
          </label>
          <label className="small">
            Показать{' '}
            <select value={first} onChange={(e) => setFirst(Number(e.target.value))}>
              {[50, 100, 200, 500].map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
          {loading && <span className="spinner" />}
        </div>
        <ErrorBox error={error} partial={Boolean(topics)} />
        {!topics ? (
          <Loading />
        ) : (
          <div className="grid grid-2">
            <Bars items={topics.slice(0, 25).map((t) => ({ label: t.name, value: t.repositoryCount, to: `/topics/${t.name}` }))} />
            <div className="chips" style={{ alignContent: 'flex-start' }}>
              {topics.slice(25).map((t) => (
                <Link key={t.name} className="chip" to={`/topics/${t.name}`}>
                  {t.name} · {t.repositoryCount}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
