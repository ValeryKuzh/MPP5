import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import DataExplorer from '../components/DataExplorer.jsx';
import { date, num, repoPath, short } from '../format.js';

const LANGUAGES = gql`
  query Languages {
    languages
  }
`;

export default function Repositories() {
  const { data } = useQuery(LANGUAGES, { fetchPolicy: 'cache-first' });
  const languages = data?.languages;

  const config = useMemo(
    () => ({
      operationName: 'RepositoryList',
      rootField: 'repositories',
      filterType: 'RepositoryFilter',
      sortType: 'RepositorySort',
      keyFields: 'fullName',
      searchPlaceholder: 'Полнотекстовый поиск: название, описание (например: "graph database" -sql)',
      defaultSort: [{ field: 'STARS', direction: 'DESC' }],
      sortFields: [
        { value: 'STARS', label: 'Звёзды' },
        { value: 'FORKS', label: 'Форки' },
        { value: 'OPEN_ISSUES', label: 'Открытые issues' },
        { value: 'CREATED_AT', label: 'Дата создания' },
        { value: 'PUSHED_AT', label: 'Последний push' },
        { value: 'NAME', label: 'Название' },
        { value: 'RELEVANCE', label: 'Релевантность (поиск)' },
      ],
      filterFields: [
        { key: 'language', label: 'Язык', type: 'string', options: languages },
        { key: 'stars', label: 'Звёзды', type: 'int' },
        { key: 'forks', label: 'Форки', type: 'int' },
        { key: 'openIssues', label: 'Открытые issues', type: 'int' },
        { key: 'owner', label: 'Владелец', type: 'string' },
        { key: 'license', label: 'Лицензия', type: 'string', placeholder: 'MIT' },
        { key: 'createdAt', label: 'Создан', type: 'date' },
        { key: 'pushedAt', label: 'Последний push', type: 'date' },
        { key: 'topics', label: 'Топики (все)', type: 'list', placeholder: 'react, typescript' },
        { key: 'anyTopic', label: 'Топики (любой)', type: 'list', placeholder: 'rust, go' },
        { key: 'archived', label: 'Архивный', type: 'bool' },
        { key: 'isFork', label: 'Форк', type: 'bool' },
      ],
      columns: [
        {
          key: 'name',
          label: 'Репозиторий',
          selection: 'description owner { login avatarUrl }',
          sortField: 'NAME',
          render: (r) => (
            <div>
              <img className="avatar sm" src={r.owner.avatarUrl ? `${r.owner.avatarUrl}&s=44` : undefined} alt="" loading="lazy" />
              <Link to={repoPath(r.fullName)}>{r.fullName}</Link>
              {r.description && <div className="small muted">{r.description.slice(0, 140)}</div>}
            </div>
          ),
        },
        { key: 'language', label: 'Язык', selection: 'language', render: (r) => r.language ?? '—' },
        { key: 'stars', label: '★', selection: 'stars', num: true, sortField: 'STARS', render: (r) => num(r.stars) },
        { key: 'forks', label: 'Форки', selection: 'forks', num: true, sortField: 'FORKS', render: (r) => short(r.forks) },
        { key: 'issues', label: 'Issues', selection: 'openIssues', num: true, sortField: 'OPEN_ISSUES', default: false, render: (r) => num(r.openIssues) },
        { key: 'license', label: 'Лицензия', selection: 'license', default: false, render: (r) => r.license ?? '—' },
        { key: 'created', label: 'Создан', selection: 'createdAt', sortField: 'CREATED_AT', default: false, render: (r) => date(r.createdAt) },
        { key: 'pushed', label: 'Push', selection: 'pushedAt', sortField: 'PUSHED_AT', render: (r) => date(r.pushedAt) },
        {
          key: 'topics',
          label: 'Топики',
          selection: 'topics { name }',
          render: (r) => (
            <div className="chips">
              {r.topics.slice(0, 4).map((t) => (
                <Link key={t.name} className="chip" to={`/topics/${t.name}`}>
                  {t.name}
                </Link>
              ))}
            </div>
          ),
        },
        {
          key: 'hn',
          label: 'HN',
          remote: 'news',
          hint: 'Поле из подграфа news — шлюз дозапрашивает его через федерацию',
          selection: 'hnMentions',
          num: true,
          default: false,
          render: (r) => (r.hnMentions == null ? '—' : r.hnMentions || ''),
        },
        {
          key: 'packages',
          label: 'npm',
          remote: 'packages',
          hint: 'Поле из подграфа packages',
          selection: 'packages { name }',
          default: false,
          render: (r) =>
            r.packages?.length ? (
              <div className="chips">
                {r.packages.slice(0, 3).map((p) => (
                  <Link key={p.name} className="chip neutral" to={`/packages/${p.name}`}>
                    {p.name}
                  </Link>
                ))}
              </div>
            ) : (
              ''
            ),
        },
      ],
    }),
    [languages],
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Репозитории GitHub</h1>
          <div className="muted">Фильтрация (AND / OR / NOT), сортировка по нескольким полям, поиск и курсорная пагинация</div>
        </div>
      </div>
      <DataExplorer config={config} />
    </div>
  );
}
