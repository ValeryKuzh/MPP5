import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { date, num, short } from '../format.js';

const MAINTAINER = gql`
  query MaintainerDetail($name: String!, $after: String) {
    maintainer(name: $name) {
      name
      npmUrl
      packageCount
      totalDownloads
      packages(first: 25, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { name version description monthlyDownloads publishedAt repository { fullName stars } }
      }
    }
  }
`;

export default function MaintainerDetail() {
  const { name } = useParams();
  const [after, setAfter] = useState(null);
  const { data, previousData, loading, error } = useQuery(MAINTAINER, { variables: { name, after } });
  const m = (data ?? previousData)?.maintainer;
  if (!m && loading) return <Loading />;
  if (!m) return <ErrorBox error={error ?? { message: 'Мейнтейнер не найден' }} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{m.name}</h1>
          <div className="muted">
            {num(m.packageCount)} пакетов · {short(m.totalDownloads)} загрузок/мес ·{' '}
            <a href={m.npmUrl} target="_blank" rel="noreferrer">npm ↗</a>
          </div>
        </div>
      </div>
      <ErrorBox error={error} partial />
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Пакет</th>
              <th className="num">Загрузки/мес</th>
              <th>GitHub</th>
              <th>Опубликован</th>
            </tr>
          </thead>
          <tbody>
            {m.packages.nodes.map((p) => (
              <tr key={p.name}>
                <td>
                  <Link to={`/packages/${p.name}`}>{p.name}</Link> <span className="small muted">v{p.version}</span>
                  <div className="small muted">{p.description?.slice(0, 120)}</div>
                </td>
                <td className="num">{num(p.monthlyDownloads)}</td>
                <td>{p.repository && <Link to={`/repos/${p.repository.fullName}`}>{p.repository.fullName}</Link>}</td>
                <td>{date(p.publishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pager">
          <button disabled={!after} onClick={() => setAfter(null)}>В начало</button>
          <button disabled={!m.packages.pageInfo.hasNextPage} onClick={() => setAfter(m.packages.pageInfo.endCursor)}>
            Дальше →
          </button>
        </div>
      </div>
    </div>
  );
}
