import { Link, useParams } from 'react-router-dom';
import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { date, dateTime, num } from '../format.js';

const AUTHOR = gql`
  query AuthorDetail($name: String!) {
    author(name: $name) {
      name
      hnUrl
      storyCount
      commentCount
      totalPoints
      stories(first: 15) {
        totalCount
        nodes { id title points commentCount createdAt repository { fullName } }
      }
      comments(first: 10) {
        nodes { id text createdAt story { id title } }
      }
    }
  }
`;

export default function AuthorDetail() {
  const { name } = useParams();
  const { data, loading, error } = useQuery(AUTHOR, { variables: { name } });
  if (!data && loading) return <Loading />;
  const a = data?.author;
  if (!a) return <ErrorBox error={error ?? { message: 'Автор не найден' }} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{a.name}</h1>
          <div className="muted">
            {num(a.storyCount)} публикаций · {num(a.commentCount)} комментариев · {num(a.totalPoints)} очков ·{' '}
            <a href={a.hnUrl} target="_blank" rel="noreferrer">профиль HN ↗</a>
          </div>
        </div>
      </div>
      <ErrorBox error={error} partial />
      <div className="grid grid-2">
        <div className="panel">
          <h2>Публикации</h2>
          <ul className="list">
            {a.stories.nodes.map((s) => (
              <li key={s.id}>
                <Link to={`/stories/${s.id}`}>{s.title}</Link>
                <div className="small muted">
                  {s.points} очков · {s.commentCount} комм. · {date(s.createdAt)}
                  {s.repository && <> · <Link to={`/repos/${s.repository.fullName}`}>{s.repository.fullName}</Link></>}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h2>Последние комментарии</h2>
          {a.comments.nodes.map((c) => (
            <div className="comment" key={c.id}>
              <div className="comment-meta">
                {dateTime(c.createdAt)} · к <Link to={`/stories/${c.story.id}`}>{c.story.title}</Link>
              </div>
              <div className="comment-text">{c.text?.slice(0, 400)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
