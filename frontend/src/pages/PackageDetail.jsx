import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { MetaLine, useOperationMeta } from '../components/QueryInspector.jsx';
import { date, num, repoPath, short } from '../format.js';

// Граф зависимостей на 3 уровня вглубь: package -> dependencies -> package -> dependencies -> package
const PACKAGE = gql`
  query PackageDetail($name: String!, $kind: DependencyKind, $dependentsAfter: String) {
    package(name: $name) {
      name
      version
      description
      keywords
      license
      homepage
      npmUrl
      repositoryUrl
      publishedAt
      monthlyDownloads
      weeklyDownloads
      dependentsCount
      score
      publisher { name }
      maintainers { name packageCount }
      repository {
        fullName
        description
        stars
        forks
        language
        owner { login avatarUrl }
        hnMentions
      }
      dependencies(kind: $kind) {
        name
        versionRange
        kind
        package {
          name
          monthlyDownloads
          dependencies(kind: PROD) {
            name
            package { name dependencies(kind: PROD) { name } }
          }
        }
      }
      dependents(first: 15, after: $dependentsAfter) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { name monthlyDownloads description }
      }
    }
  }
`;

export default function PackageDetail() {
  const name = useParams()['*'];
  const [kind, setKind] = useState(null);
  const [dependentsAfter, setDependentsAfter] = useState(null);
  const { data, previousData, loading, error } = useQuery(PACKAGE, { variables: { name, kind, dependentsAfter } });
  const meta = useOperationMeta('PackageDetail');
  const pkg = (data ?? previousData)?.package;

  if (!pkg && loading) return <Loading />;
  if (!pkg) return <ErrorBox error={error ?? { message: `Пакет ${name} не найден в базе` }} />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>
            {pkg.name} <span className="muted small">v{pkg.version}</span>
          </h1>
          <div className="muted">{pkg.description}</div>
          <div className="chips" style={{ marginTop: 8 }}>
            {pkg.keywords.slice(0, 15).map((k) => (
              <Link key={k} className="chip" to={`/topics/${k}`}>
                {k}
              </Link>
            ))}
          </div>
        </div>
        <MetaLine meta={meta} />
      </div>
      <ErrorBox error={error} partial />

      <div className="grid grid-3">
        <div className="panel">
          <h2>Сведения</h2>
          <dl className="kv">
            <dt>Загрузки/мес</dt><dd>{num(pkg.monthlyDownloads)}</dd>
            <dt>Загрузки/нед</dt><dd>{num(pkg.weeklyDownloads)}</dd>
            <dt>Зависимых пакетов</dt><dd>{num(pkg.dependentsCount)}</dd>
            <dt>Лицензия</dt><dd>{pkg.license ?? '—'}</dd>
            <dt>Опубликован</dt><dd>{date(pkg.publishedAt)}</dd>
            <dt>Издатель</dt><dd>{pkg.publisher?.name ?? '—'}</dd>
          </dl>
          <p className="chips" style={{ marginTop: 12 }}>
            <a href={pkg.npmUrl} target="_blank" rel="noreferrer">npm ↗</a>
            {pkg.homepage && <a href={pkg.homepage} target="_blank" rel="noreferrer">Сайт ↗</a>}
          </p>
        </div>
        <div className="panel">
          <h2>Мейнтейнеры</h2>
          <ul className="list">
            {pkg.maintainers.map((m) => (
              <li key={m.name}>
                <Link to={`/maintainers/${m.name}`}>{m.name}</Link> <span className="small muted">{m.packageCount} пакетов в базе</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2>Исходный код <span className="badge">repos</span></h2>
          {pkg.repository ? (
            <div>
              <img className="avatar sm" src={pkg.repository.owner.avatarUrl} alt="" />
              <Link to={repoPath(pkg.repository.fullName)}>{pkg.repository.fullName}</Link>
              <p className="small muted">{pkg.repository.description}</p>
              <p className="small">
                ★ {num(pkg.repository.stars)} · {short(pkg.repository.forks)} форков · {pkg.repository.language} · упоминаний на HN:{' '}
                {pkg.repository.hnMentions ?? '—'}
              </p>
            </div>
          ) : (
            <p className="small muted">
              {pkg.repositoryUrl ? `Репозиторий ${pkg.repositoryUrl} отсутствует в выборке GitHub` : 'Репозиторий не указан'}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="toolbar">
            <h2 style={{ margin: 0 }}>Зависимости ({pkg.dependencies.length})</h2>
            <span className="seg">
              {[null, 'PROD', 'DEV', 'PEER'].map((k) => (
                <button key={k ?? 'all'} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                  {k ?? 'ALL'}
                </button>
              ))}
            </span>
          </div>
          <ul className="list">
            {pkg.dependencies.map((d) => (
              <li key={`${d.kind}:${d.name}`}>
                {d.package ? <Link to={`/packages/${d.name}`}>{d.name}</Link> : d.name}{' '}
                <code className="small muted">{d.versionRange}</code> <span className="badge">{d.kind}</span>
                {d.package?.dependencies?.length > 0 && (
                  <div className="small muted" style={{ marginTop: 4 }}>
                    └ {d.package.dependencies.slice(0, 8).map((dd) => (
                      <span key={dd.name}>
                        {dd.name}
                        {dd.package?.dependencies?.length ? ` (${dd.package.dependencies.length})` : ''}{' '}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2>Зависят от {pkg.name} ({num(pkg.dependents.totalCount)} в базе)</h2>
          <ul className="list">
            {pkg.dependents.nodes.map((p) => (
              <li key={p.name}>
                <Link to={`/packages/${p.name}`}>{p.name}</Link> <span className="small muted">{short(p.monthlyDownloads)}/мес</span>
              </li>
            ))}
          </ul>
          <div className="pager">
            <button disabled={!dependentsAfter} onClick={() => setDependentsAfter(null)}>
              В начало
            </button>
            <button disabled={!pkg.dependents.pageInfo.hasNextPage} onClick={() => setDependentsAfter(pkg.dependents.pageInfo.endCursor)}>
              Дальше →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
