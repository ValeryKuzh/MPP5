import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gql } from '@apollo/client';
import { useLazyQuery, useQuery } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import QueryInspector, { MetaLine, useOperationMeta } from '../components/QueryInspector.jsx';
import { dateTime, num, repoPath } from '../format.js';

/**
 * GraphQL не поддерживает рекурсивные фрагменты, поэтому выборка дерева
 * комментариев генерируется динамически на заданную глубину.
 */
function commentSelection(depth, repliesPerLevel) {
  if (depth === 0) return 'id';
  return `id text createdAt depth replyCount author { name }
          replies(first: ${repliesPerLevel}) { ${commentSelection(depth - 1, repliesPerLevel)} }`;
}

function buildQuery(depth, repliesPerLevel) {
  return `query StoryDetail($id: ID!, $first: Int, $after: String, $sort: CommentSort) {
  story(id: $id) {
    id title url domain hnUrl points commentCount storedCommentCount createdAt type text
    author { name totalPoints storyCount }
    repository { fullName description stars language owner { login avatarUrl } }
    comments(first: $first, after: $after, sort: $sort) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${commentSelection(depth, repliesPerLevel)} }
    }
  }
}`;
}

const MORE_REPLIES = gql`
  query MoreReplies($id: ID!) {
    comment(id: $id) {
      id
      replies(first: 100) {
        id
        text
        createdAt
        depth
        replyCount
        author { name }
      }
    }
  }
`;

function Comment({ c }) {
  const [loadMore, { data, loading }] = useLazyQuery(MORE_REPLIES);
  const shown = data?.comment?.replies ?? c.replies ?? [];
  const hidden = c.replyCount - shown.length;
  return (
    <div className="comment">
      <div className="comment-meta">
        <Link to={`/authors/${c.author.name}`}>{c.author.name}</Link> · {dateTime(c.createdAt)}
      </div>
      <div className="comment-text">{c.text}</div>
      {shown.map((r) => (
        <Comment key={r.id} c={r} />
      ))}
      {hidden > 0 && (
        <button className="link small" disabled={loading} onClick={() => loadMore({ variables: { id: c.id } })}>
          {loading ? 'загрузка…' : `▸ ещё ответов: ${hidden}`}
        </button>
      )}
    </div>
  );
}

export default function StoryDetail() {
  const { id } = useParams();
  const [depth, setDepth] = useState(3);
  const [perLevel, setPerLevel] = useState(5);
  const [sort, setSort] = useState('OLDEST');
  const queryText = useMemo(() => buildQuery(depth, perLevel), [depth, perLevel]);
  const document = useMemo(() => gql(queryText), [queryText]);
  const variables = { id, first: 20, sort };
  const { data, previousData, loading, error, fetchMore } = useQuery(document, { variables });
  const meta = useOperationMeta('StoryDetail');
  const story = (data ?? previousData)?.story;

  if (!story && loading) return <Loading />;
  if (!story) return <ErrorBox error={error ?? { message: 'Публикация не найдена' }} />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{story.title}</h1>
          <div className="muted">
            {num(story.points)} очков · <Link to={`/authors/${story.author.name}`}>{story.author.name}</Link> · {dateTime(story.createdAt)} ·{' '}
            <a href={story.hnUrl} target="_blank" rel="noreferrer">HN ↗</a>
            {story.url && (
              <> · <a href={story.url} target="_blank" rel="noreferrer">{story.domain} ↗</a></>
            )}
          </div>
        </div>
        <MetaLine meta={meta} />
      </div>
      <ErrorBox error={error} partial />

      {story.repository && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <span className="badge">repos</span>{' '}
          <img className="avatar sm" src={story.repository.owner.avatarUrl} alt="" />
          <Link to={repoPath(story.repository.fullName)}>{story.repository.fullName}</Link>{' '}
          <span className="muted small">★ {num(story.repository.stars)} · {story.repository.language} — {story.repository.description}</span>
        </div>
      )}
      {story.text && <div className="panel comment-text" style={{ marginBottom: 16 }}>{story.text}</div>}

      <div className="panel">
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>
            Комментарии ({num(story.commentCount)} на HN, загружено {num(story.storedCommentCount)})
          </h2>
          <label className="small">
            Глубина дерева в запросе{' '}
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6].map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
          <label className="small">
            Ответов на уровне{' '}
            <select value={perLevel} onChange={(e) => setPerLevel(Number(e.target.value))}>
              {[2, 5, 10, 20].map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="OLDEST">сначала старые</option>
            <option value="NEWEST">сначала новые</option>
          </select>
          {loading && <span className="spinner" />}
        </div>
        {story.comments.nodes.length === 0 && <p className="muted">Комментарии ещё не загружены сборщиком</p>}
        {story.comments.nodes.map((c) => (
          <Comment key={c.id} c={c} />
        ))}
        {story.comments.pageInfo.hasNextPage && (
          <button
            onClick={() =>
              fetchMore({
                variables: { after: story.comments.pageInfo.endCursor },
                updateQuery: (prev, { fetchMoreResult }) => ({
                  story: {
                    ...prev.story,
                    comments: {
                      ...fetchMoreResult.story.comments,
                      nodes: [...prev.story.comments.nodes, ...fetchMoreResult.story.comments.nodes],
                    },
                  },
                }),
              })
            }
          >
            Загрузить ещё комментарии
          </button>
        )}
      </div>
      <QueryInspector query={queryText} variables={variables} operationName="StoryDetail" />
    </div>
  );
}
