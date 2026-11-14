import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { date, num, repoPath } from '../format.js';

const OWNER = gql`
  query OwnerDetail($login: String!, $after: String, $sort: [RepositorySort!]) {
    owner(login: $login) {
      login
      type
      avatarUrl
      url
      repositoryCount
      totalStars
      repositories(first: 20, after: $after, sort: $sort) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          fullName
          description
          stars
          forks
          language
          pushedAt
          hnMentions
          packages { name }
        }
      }
    }
  }
`;

export default function OwnerDetail() {
  const { login } = useParams();
  const [after, setAfter] = useState(null);
  const [sortField, setSortField] = useState('STARS');
  const { data, previousData, loading, error } = useQuery(OWNER, {
    variables: { login, after, sort: [{ field: sortField, direction: sortField === 'NAME' ? 'ASC' : 'DESC' }] },
  });
  const owner = (data ?? previousData)?.owner;
  if (!owner && loading) return <Loading />;
  if (!owner) return <ErrorBox error={error ?? { message: 'Владелец не найден' }} />;

  return (
    <div>
      <div className="page-head">
        <div className="repo-head">
          <img className="avatar" src={owner.avatarUrl} alt="" />
          <div>
            <h1>
              {owner.login} <span className="badge">{owner.type}</span>
            </h1>
            <div className="muted">
              {num(owner.repositoryCount)} репозиториев · {num(owner.totalStars)} ★ ·{' '}
              <a href={owner.url} target="_blank" rel="noreferrer">GitHub ↗</a>
            </div>
          </div>
        </div>
      </div>
      <ErrorBox error={error} partial />
      <div className="panel">
        <div className="toolbar">
          <select value={sortField} onChange={(e) => { setSortField(e.target.value); setAfter(null); }}>
            <option value="STARS">по звёздам</option>
            <option value="PUSHED_AT">по активности</option>
            <option value="CREATED_AT">по дате создания</option>
            <option value="NAME">по названию</option>
          </select>
          {loading && <span className="spinner" />}
        </div>
        <table>
          <thead>
            <tr>
              <th>Репозиторий</th>
              <th>Язык</th>
              <th className="num">★</th>
              <th className="num">HN</th>
              <th>npm</th>
              <th>Push</th>
            </tr>
          </thead>
          <tbody>
            {owner.repositories.nodes.map((r) => (
              <tr key={r.fullName}>
                <td>
                  <Link to={repoPath(r.fullName)}>{r.fullName}</Link>
                  <div className="small muted">{r.description?.slice(0, 120)}</div>
                </td>
                <td>{r.language}</td>
                <td className="num">{num(r.stars)}</td>
                <td className="num">{r.hnMentions || ''}</td>
                <td>{r.packages?.map((p) => p.name).join(', ')}</td>
                <td>{date(r.pushedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pager">
          <button disabled={!after} onClick={() => setAfter(null)}>В начало</button>
          <button disabled={!owner.repositories.pageInfo.hasNextPage} onClick={() => setAfter(owner.repositories.pageInfo.endCursor)}>
            Дальше →
          </button>
        </div>
      </div>
    </div>
  );
}
