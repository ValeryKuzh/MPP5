import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { MetaLine, useOperationMeta } from '../components/QueryInspector.jsx';
import { ago, date, num, repoPath, short } from '../format.js';

/**
 * Глубоко вложенный федеративный запрос:
 * Repository (repos) -> owner -> repositories
 *                    -> relatedStories (news) -> comments -> replies -> author
 *                    -> packages (packages) -> dependencies -> package
 */
const REPOSITORY = gql`
  query RepositoryDetail($fullName: String!) {
    repository(fullName: $fullName) {
      id
      fullName
      name
      description
      url
      homepage
      language
      license
      stars
      forks
      openIssues
      sizeKb
      archived
      isFork
      createdAt
      pushedAt
      owner {
        login
        type
        avatarUrl
        repositoryCount
        totalStars
        repositories(first: 6) {
          nodes { fullName stars language }
        }
      }
      topics { name repositoryCount }
      similar(first: 6) { fullName description stars language }
      collections { id name }
      hnMentions
      relatedStories(first: 5) {
        id
        title
        points
        commentCount
        createdAt
        author { name }
        comments(first: 3) {
          nodes {
            id
            text
            createdAt
            author { name }
            replyCount
            replies(first: 2) { id text author { name } }
          }
        }
      }
      packages {
        name
        version
        description
        monthlyDownloads
        dependencies(kind: PROD) {
          name
          versionRange
          package { name monthlyDownloads }
        }
      }
    }
    collections { id name }
  }
`;

const ADD = gql`
  mutation AddToCollection($collectionId: ID!, $fullName: String!, $note: String) {
    addToCollection(collectionId: $collectionId, fullName: $fullName, note: $note) {
      id
      itemCount
    }
  }
`;

export default function RepositoryDetail() {
  const { owner, name } = useParams();
  const fullName = `${owner}/${name}`;
  const { data, loading, error, refetch } = useQuery(REPOSITORY, { variables: { fullName } });
  const meta = useOperationMeta('RepositoryDetail');
  const [collectionId, setCollectionId] = useState('');
  const [add, addState] = useMutation(ADD);

  if (!data && loading) return <Loading />;
  const repo = data?.repository;
  if (!repo) return <ErrorBox error={error ?? { message: `Репозиторий ${fullName} не найден` }} />;

  return (
    <div>
      <div className="page-head">
        <div className="repo-head">
          <img className="avatar" src={repo.owner.avatarUrl} alt="" />
          <div>
            <h1>
              <Link to={`/owners/${repo.owner.login}`}>{repo.owner.login}</Link> / {repo.name}
            </h1>
            <div className="muted">{repo.description}</div>
            <div className="chips" style={{ marginTop: 8 }}>
              {repo.topics.map((t) => (
                <Link key={t.name} to={`/topics/${t.name}`} className="chip">
                  {t.name}
                </Link>
              ))}
            </div>
          </div>
        </div>
        <MetaLine meta={meta} />
      </div>
      <ErrorBox error={error} partial />

      <div className="grid grid-3">
        <div className="panel">
          <h2>Сведения</h2>
          <dl className="kv">
            <dt>Звёзды</dt><dd>{num(repo.stars)}</dd>
            <dt>Форки</dt><dd>{num(repo.forks)}</dd>
            <dt>Открытые issues</dt><dd>{num(repo.openIssues)}</dd>
            <dt>Язык</dt><dd>{repo.language ?? '—'}</dd>
            <dt>Лицензия</dt><dd>{repo.license ?? '—'}</dd>
            <dt>Размер</dt><dd>{short(repo.sizeKb * 1024)}Б</dd>
            <dt>Создан</dt><dd>{date(repo.createdAt)}</dd>
            <dt>Последний push</dt><dd>{ago(repo.pushedAt)}</dd>
            <dt>Упоминаний на HN</dt><dd>{repo.hnMentions ?? '—'}</dd>
          </dl>
          <p className="chips" style={{ marginTop: 12 }}>
            {repo.archived && <span className="badge warn">archived</span>}
            {repo.isFork && <span className="badge">fork</span>}
            <a href={repo.url} target="_blank" rel="noreferrer">GitHub ↗</a>
            {repo.homepage && <a href={repo.homepage} target="_blank" rel="noreferrer">Сайт ↗</a>}
          </p>
        </div>

        <div className="panel">
          <h2>
            Владелец: {repo.owner.login} <span className="badge">{repo.owner.type}</span>
          </h2>
          <p className="small muted">
            {num(repo.owner.repositoryCount)} репозиториев в базе · {num(repo.owner.totalStars)} ★
          </p>
          <ul className="list">
            {repo.owner.repositories.nodes.map((r) => (
              <li key={r.fullName}>
                <Link to={repoPath(r.fullName)}>{r.fullName}</Link>{' '}
                <span className="small muted">★ {short(r.stars)} · {r.language ?? '—'}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel">
          <h2>Коллекции</h2>
          <div className="chips" style={{ marginBottom: 10 }}>
            {repo.collections.length ? repo.collections.map((c) => <span key={c.id} className="chip">★ {c.name}</span>) : <span className="muted small">Не добавлен</span>}
          </div>
          {data.collections.length ? (
            <div className="toolbar">
              <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                <option value="">Выберите коллекцию</option>
                {data.collections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button
                className="primary"
                disabled={!collectionId || addState.loading}
                onClick={async () => {
                  await add({ variables: { collectionId, fullName: repo.fullName } });
                  refetch();
                }}
              >
                Добавить
              </button>
            </div>
          ) : (
            <p className="small muted">
              Коллекций пока нет — <Link to="/collections">создайте первую</Link>.
            </p>
          )}
          <ErrorBox error={addState.error} />
          <h3 style={{ marginTop: 16 }}>Похожие (общие топики)</h3>
          <ul className="list">
            {repo.similar.map((r) => (
              <li key={r.fullName}>
                <Link to={repoPath(r.fullName)}>{r.fullName}</Link> <span className="small muted">★ {short(r.stars)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <h2>Обсуждения на Hacker News <span className="badge">news</span></h2>
          {!repo.relatedStories?.length && <p className="muted small">Публикаций со ссылкой на этот репозиторий не найдено</p>}
          <ul className="list">
            {repo.relatedStories?.map((s) => (
              <li key={s.id}>
                <Link to={`/stories/${s.id}`}>{s.title}</Link>
                <div className="small muted">
                  {s.points} очков · {s.commentCount} комм. · <Link to={`/authors/${s.author.name}`}>{s.author.name}</Link> · {date(s.createdAt)}
                </div>
                {s.comments.nodes.map((c) => (
                  <div className="comment" key={c.id}>
                    <div className="comment-meta">{c.author.name} · ответов: {c.replyCount}</div>
                    <div className="comment-text">{c.text?.slice(0, 300)}</div>
                    {c.replies.map((r) => (
                      <div className="comment" key={r.id}>
                        <div className="comment-meta">{r.author.name}</div>
                        <div className="comment-text">{r.text?.slice(0, 200)}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2>npm-пакеты из репозитория <span className="badge">packages</span></h2>
          {!repo.packages?.length && <p className="muted small">Пакеты не найдены</p>}
          <ul className="list">
            {repo.packages?.map((p) => (
              <li key={p.name}>
                <Link to={`/packages/${p.name}`}>{p.name}</Link> <span className="small muted">v{p.version} · {short(p.monthlyDownloads)} загрузок/мес</span>
                <div className="small muted">{p.description}</div>
                {p.dependencies.length > 0 && (
                  <div className="chips" style={{ marginTop: 6 }}>
                    {p.dependencies.slice(0, 12).map((d) =>
                      d.package ? (
                        <Link key={d.name} className="chip" to={`/packages/${d.name}`} title={d.versionRange}>
                          {d.name}
                        </Link>
                      ) : (
                        <span key={d.name} className="chip neutral" title={d.versionRange}>
                          {d.name}
                        </span>
                      ),
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
