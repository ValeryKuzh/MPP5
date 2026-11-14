import { useEffect, useState } from 'react';

/** Слушает метаданные ответов (см. metaLink в apollo.js) для указанной операции. */
export function useOperationMeta(operationName) {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    const handler = (e) => {
      if (!operationName || e.detail.operationName === operationName) setMeta(e.detail);
    };
    window.addEventListener('graphql-meta', handler);
    return () => window.removeEventListener('graphql-meta', handler);
  }, [operationName]);
  return meta;
}

export function MetaLine({ meta }) {
  if (!meta) return null;
  return (
    <span className="small muted">
      {meta.durationMs} мс
      {meta.cost && (
        <>
          {' · '}сложность {meta.cost.complexity}/{meta.cost.maxComplexity}
          {meta.cost.remaining != null && <> · бюджет {meta.cost.remaining}/{meta.cost.budget} в мин.</>}
        </>
      )}
    </span>
  );
}

/** Показывает динамически сформированный запрос и переменные — для демонстрации и отладки. */
export default function QueryInspector({ query, variables, operationName }) {
  const meta = useOperationMeta(operationName);
  return (
    <details className="inspector">
      <summary>
        Сформированный GraphQL-запрос {meta && <>· <MetaLine meta={meta} /></>}
      </summary>
      <div className="grid grid-2">
        <pre className="code">{query.trim()}</pre>
        <pre className="code">{JSON.stringify(variables, null, 2)}</pre>
      </div>
    </details>
  );
}
