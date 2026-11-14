'use strict';

const { makeExecutableSchema } = require('@graphql-tools/schema');
const { SYNC_CHANNEL, logger } = require('@devpulse/common');

/**
 * GraphQL Subscriptions (протокол graphql-transport-ws).
 * Воркеры сбора данных публикуют прогресс в Redis Pub/Sub, шлюз
 * транслирует события подписчикам — это позволяет масштабировать
 * шлюз горизонтально (каждый экземпляр слушает один и тот же канал).
 */
const typeDefs = /* GraphQL */ `
  enum SyncStatus {
    QUEUED
    RUNNING
    COMPLETED
    FAILED
  }

  type SyncProgressEvent {
    source: String!
    runId: ID!
    status: SyncStatus!
    processed: Int!
    message: String
    error: String
    at: String!
  }

  type Query {
    "Подписки обслуживаются по WebSocket; запросы и мутации — через федеративную схему по HTTP"
    subscriptionsInfo: String!
  }

  type Subscription {
    "Прогресс автоматического сбора данных (repos | news | packages)"
    syncProgress(source: String): SyncProgressEvent!
  }
`;

const MAX_BUFFERED = 200;

function createPubSub(subscriber) {
  const listeners = new Set();
  subscriber.subscribe(SYNC_CHANNEL).catch((err) => logger.error({ err }, 'redis subscribe failed'));
  subscriber.on('message', (_channel, message) => {
    let event;
    try {
      event = JSON.parse(message);
    } catch {
      return;
    }
    for (const listener of listeners) listener(event);
  });

  /** Асинхронный итератор событий с фильтрацией и ограниченным буфером. */
  function iterator(predicate) {
    const buffer = [];
    let pending = null;
    let closed = false;
    const listener = (event) => {
      if (!predicate(event)) return;
      if (pending) {
        pending({ value: event, done: false });
        pending = null;
      } else {
        buffer.push(event);
        if (buffer.length > MAX_BUFFERED) buffer.shift();
      }
    };
    listeners.add(listener);
    const close = () => {
      closed = true;
      listeners.delete(listener);
      if (pending) pending({ value: undefined, done: true });
      pending = null;
      return Promise.resolve({ value: undefined, done: true });
    };
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (closed) return Promise.resolve({ value: undefined, done: true });
        if (buffer.length) return Promise.resolve({ value: buffer.shift(), done: false });
        return new Promise((resolve) => {
          pending = resolve;
        });
      },
      return: close,
      throw: close,
    };
  }

  return { iterator, listenerCount: () => listeners.size };
}

function createSubscriptionSchema(pubsub) {
  return makeExecutableSchema({
    typeDefs,
    resolvers: {
      Query: { subscriptionsInfo: () => 'Use WebSocket (graphql-transport-ws) on /graphql for Subscription.syncProgress' },
      Subscription: {
        syncProgress: {
          subscribe: (_, { source }) => pubsub.iterator((e) => !source || e.source === source),
          resolve: (event) => event,
        },
      },
    },
  });
}

module.exports = { createPubSub, createSubscriptionSchema };
