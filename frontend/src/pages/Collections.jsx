import { useState } from 'react';
import { Link } from 'react-router-dom';
import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { ErrorBox, Loading } from '../components/Status.jsx';
import { dateTime, num, repoPath } from '../format.js';

const COLLECTION_FIELDS = gql`
  fragment CollectionFields on Collection {
    id
    name
    description
    createdAt
    updatedAt
    itemCount
    items {
      note
      addedAt
      repository { fullName description stars language hnMentions }
    }
  }
`;

const COLLECTIONS = gql`
  query Collections {
    collections { ...CollectionFields }
  }
  ${COLLECTION_FIELDS}
`;

const CREATE = gql`
  mutation CreateCollection($input: CreateCollectionInput!) {
    createCollection(input: $input) { ...CollectionFields }
  }
  ${COLLECTION_FIELDS}
`;

const UPDATE = gql`
  mutation UpdateCollection($id: ID!, $input: UpdateCollectionInput!) {
    updateCollection(id: $id, input: $input) { id name description updatedAt }
  }
`;

const DELETE = gql`
  mutation DeleteCollection($id: ID!) {
    deleteCollection(id: $id)
  }
`;

const ADD = gql`
  mutation AddItem($collectionId: ID!, $fullName: String!, $note: String) {
    addToCollection(collectionId: $collectionId, fullName: $fullName, note: $note) { ...CollectionFields }
  }
  ${COLLECTION_FIELDS}
`;

const REMOVE = gql`
  mutation RemoveItem($collectionId: ID!, $fullName: String!) {
    removeFromCollection(collectionId: $collectionId, fullName: $fullName) { ...CollectionFields }
  }
  ${COLLECTION_FIELDS}
`;

function CollectionCard({ c, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.name);
  const [fullName, setFullName] = useState('');
  const [note, setNote] = useState('');
  const [update, updateState] = useMutation(UPDATE);
  const [add, addState] = useMutation(ADD);
  const [remove] = useMutation(REMOVE);

  return (
    <div className="panel">
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        {editing ? (
          <span className="toolbar" style={{ margin: 0 }}>
            <input value={name} onChange={(e) => setName(e.target.value)} />
            <button
              className="primary"
              disabled={updateState.loading}
              onClick={async () => {
                await update({ variables: { id: c.id, input: { name } } });
                setEditing(false);
              }}
            >
              Сохранить
            </button>
            <button onClick={() => setEditing(false)}>Отмена</button>
          </span>
        ) : (
          <h2 style={{ margin: 0 }}>
            ★ {c.name} <span className="small muted">({num(c.itemCount)})</span>
          </h2>
        )}
        <span>
          <button className="link small" onClick={() => setEditing(true)}>переименовать</button>{' · '}
          <button className="link small danger" onClick={() => onDelete(c.id)}>удалить</button>
        </span>
      </div>
      {c.description && <p className="muted small">{c.description}</p>}
      <ErrorBox error={updateState.error} />
      <ul className="list">
        {c.items.map((i) => (
          <li key={i.repository.fullName}>
            <Link to={repoPath(i.repository.fullName)}>{i.repository.fullName}</Link>{' '}
            <span className="small muted">
              ★ {num(i.repository.stars)} · {i.repository.language} · HN: {i.repository.hnMentions ?? '—'}
            </span>{' '}
            <button className="link small danger" onClick={() => remove({ variables: { collectionId: c.id, fullName: i.repository.fullName } })}>
              ✕
            </button>
            {i.note && <div className="small">📝 {i.note}</div>}
          </li>
        ))}
      </ul>
      <form
        className="toolbar"
        style={{ marginTop: 12 }}
        onSubmit={async (e) => {
          e.preventDefault();
          await add({ variables: { collectionId: c.id, fullName: fullName.trim(), note: note || null } }).catch(() => {});
          setFullName('');
          setNote('');
        }}
      >
        <input placeholder="owner/repo" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        <input placeholder="заметка" value={note} onChange={(e) => setNote(e.target.value)} />
        <button disabled={addState.loading}>Добавить</button>
      </form>
      <ErrorBox error={addState.error} />
      <p className="small muted">Обновлено {dateTime(c.updatedAt)}</p>
    </div>
  );
}

export default function Collections() {
  const { data, loading, error } = useQuery(COLLECTIONS);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [create, createState] = useMutation(CREATE, { refetchQueries: [COLLECTIONS] });
  const [del] = useMutation(DELETE, { refetchQueries: [COLLECTIONS] });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Коллекции</h1>
          <div className="muted">Пользовательские подборки репозиториев — мутации create / update / delete / add / remove</div>
        </div>
      </div>
      <form
        className="panel toolbar"
        onSubmit={async (e) => {
          e.preventDefault();
          await create({ variables: { input: { name, description: description || null } } }).catch(() => {});
          setName('');
          setDescription('');
        }}
      >
        <input placeholder="Название коллекции" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        <input className="search" placeholder="Описание (необязательно)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <button className="primary" disabled={createState.loading}>Создать</button>
      </form>
      <ErrorBox error={createState.error ?? error} />
      {!data && loading ? (
        <Loading />
      ) : (
        <div className="grid grid-2" style={{ marginTop: 16 }}>
          {data?.collections.map((c) => (
            <CollectionCard key={c.id} c={c} onDelete={(id) => del({ variables: { id } })} />
          ))}
          {data?.collections.length === 0 && <p className="muted">Коллекций пока нет</p>}
        </div>
      )}
    </div>
  );
}
