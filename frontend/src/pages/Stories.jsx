import { Link } from 'react-router-dom';
import DataExplorer from '../components/DataExplorer.jsx';
import { date, num, repoPath } from '../format.js';

const TYPE_LABEL = { STORY: 'story', SHOW_HN: 'Show HN', ASK_HN: 'Ask HN' };

const config = {
  operationName: 'StoryList',
  rootField: 'stories',
  filterType: 'StoryFilter',
  sortType: 'StorySort',
  keyFields: 'id',
  searchPlaceholder: 'Полнотекстовый поиск по заголовкам и текстам публикаций',
  defaultSort: [{ field: 'POINTS', direction: 'DESC' }],
  sortFields: [
    { value: 'POINTS', label: 'Очки' },
    { value: 'COMMENTS', label: 'Комментарии' },
    { value: 'CREATED_AT', label: 'Дата' },
    { value: 'RELEVANCE', label: 'Релевантность (поиск)' },
  ],
  filterFields: [
    { key: 'points', label: 'Очки', type: 'int' },
    { key: 'commentCount', label: 'Комментарии', type: 'int' },
    { key: 'type', label: 'Тип', type: 'enumList', options: ['STORY', 'SHOW_HN', 'ASK_HN'] },
    { key: 'domain', label: 'Домен', type: 'string', placeholder: 'github.com' },
    { key: 'author', label: 'Автор', type: 'string' },
    { key: 'title', label: 'Заголовок', type: 'string' },
    { key: 'createdAt', label: 'Дата', type: 'date' },
    { key: 'hasRepository', label: 'Есть ссылка на репозиторий', type: 'bool' },
  ],
  columns: [
    {
      key: 'title',
      label: 'Публикация',
      selection: 'title url domain type',
      render: (s) => (
        <div>
          <Link to={`/stories/${s.id}`}>{s.title}</Link>{' '}
          {s.type !== 'STORY' && <span className="badge">{TYPE_LABEL[s.type]}</span>}
          {s.domain && <div className="small muted">{s.domain}</div>}
        </div>
      ),
    },
    { key: 'points', label: 'Очки', selection: 'points', num: true, sortField: 'POINTS', render: (s) => num(s.points) },
    { key: 'comments', label: 'Комм.', selection: 'commentCount', num: true, sortField: 'COMMENTS', render: (s) => num(s.commentCount) },
    {
      key: 'author',
      label: 'Автор',
      selection: 'author { name }',
      render: (s) => <Link to={`/authors/${s.author.name}`}>{s.author.name}</Link>,
    },
    { key: 'date', label: 'Дата', selection: 'createdAt', sortField: 'CREATED_AT', render: (s) => date(s.createdAt) },
    {
      key: 'repo',
      label: 'Репозиторий',
      remote: 'repos',
      hint: 'Сущность Repository из подграфа repos',
      selection: 'repository { fullName stars language }',
      default: false,
      render: (s) =>
        s.repository ? (
          <span>
            <Link to={repoPath(s.repository.fullName)}>{s.repository.fullName}</Link>{' '}
            <span className="small muted">★ {num(s.repository.stars)}</span>
          </span>
        ) : (
          ''
        ),
    },
  ],
};

export default function Stories() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Hacker News</h1>
          <div className="muted">Публикации, деревья комментариев и связь с репозиториями GitHub</div>
        </div>
      </div>
      <DataExplorer config={config} />
    </div>
  );
}
