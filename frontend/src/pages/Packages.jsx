import { Link } from 'react-router-dom';
import DataExplorer from '../components/DataExplorer.jsx';
import { date, num, repoPath, short } from '../format.js';

const config = {
  operationName: 'PackageList',
  rootField: 'packages',
  filterType: 'PackageFilter',
  sortType: 'PackageSort',
  keyFields: 'name',
  searchPlaceholder: 'Поиск по названию, ключевым словам и описанию',
  defaultSort: [{ field: 'DOWNLOADS', direction: 'DESC' }],
  sortFields: [
    { value: 'DOWNLOADS', label: 'Загрузки/мес' },
    { value: 'DEPENDENTS', label: 'Зависимые пакеты' },
    { value: 'PUBLISHED_AT', label: 'Дата публикации' },
    { value: 'SCORE', label: 'Оценка npm' },
    { value: 'NAME', label: 'Название' },
    { value: 'RELEVANCE', label: 'Релевантность (поиск)' },
  ],
  filterFields: [
    { key: 'monthlyDownloads', label: 'Загрузки/мес', type: 'float' },
    { key: 'dependentsCount', label: 'Зависимых пакетов', type: 'int' },
    { key: 'keywords', label: 'Ключевые слова (все)', type: 'list', placeholder: 'react, hooks' },
    { key: 'anyKeyword', label: 'Ключевые слова (любое)', type: 'list' },
    { key: 'license', label: 'Лицензия', type: 'string', placeholder: 'MIT' },
    { key: 'name', label: 'Название', type: 'string' },
    { key: 'maintainer', label: 'Мейнтейнер', type: 'text' },
    { key: 'dependsOn', label: 'Зависит от пакета', type: 'text', placeholder: 'lodash' },
    { key: 'publishedAt', label: 'Опубликован', type: 'date' },
    { key: 'hasRepository', label: 'Есть GitHub-репозиторий', type: 'bool' },
  ],
  columns: [
    {
      key: 'name',
      label: 'Пакет',
      selection: 'version description',
      sortField: 'NAME',
      render: (p) => (
        <div>
          <Link to={`/packages/${p.name}`}>{p.name}</Link> <span className="small muted">v{p.version}</span>
          {p.description && <div className="small muted">{p.description.slice(0, 140)}</div>}
        </div>
      ),
    },
    { key: 'downloads', label: 'Загрузки/мес', selection: 'monthlyDownloads', num: true, sortField: 'DOWNLOADS', render: (p) => short(p.monthlyDownloads) },
    { key: 'dependents', label: 'Зависимых', selection: 'dependentsCount', num: true, sortField: 'DEPENDENTS', render: (p) => num(p.dependentsCount) },
    { key: 'license', label: 'Лицензия', selection: 'license', render: (p) => p.license ?? '—' },
    { key: 'published', label: 'Опубликован', selection: 'publishedAt', sortField: 'PUBLISHED_AT', render: (p) => date(p.publishedAt) },
    {
      key: 'keywords',
      label: 'Ключевые слова',
      selection: 'keywords',
      default: false,
      render: (p) => (
        <div className="chips">
          {p.keywords.slice(0, 4).map((k) => (
            <Link key={k} className="chip" to={`/topics/${k}`}>
              {k}
            </Link>
          ))}
        </div>
      ),
    },
    {
      key: 'maintainers',
      label: 'Мейнтейнеры',
      selection: 'maintainers { name }',
      default: false,
      render: (p) => p.maintainers.slice(0, 3).map((m, i) => (
        <span key={m.name}>
          {i > 0 && ', '}
          <Link to={`/maintainers/${m.name}`}>{m.name}</Link>
        </span>
      )),
    },
    {
      key: 'repo',
      label: 'GitHub',
      remote: 'repos',
      hint: 'Repository из подграфа repos',
      selection: 'repository { fullName stars }',
      render: (p) =>
        p.repository ? (
          <span>
            <Link to={repoPath(p.repository.fullName)}>{p.repository.fullName}</Link>{' '}
            <span className="small muted">★ {short(p.repository.stars)}</span>
          </span>
        ) : (
          ''
        ),
    },
  ],
};

export default function Packages() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>npm-пакеты</h1>
          <div className="muted">Пакеты, мейнтейнеры и граф зависимостей</div>
        </div>
      </div>
      <DataExplorer config={config} />
    </div>
  );
}
