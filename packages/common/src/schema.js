'use strict';

const { GraphQLScalarType, Kind, GraphQLError } = require('graphql');

/**
 * Общие типы, одинаково объявленные во всех подграфах.
 * В Federation 2 идентичные enum / input / scalar сливаются, а value-типы помечаются @shareable.
 */
const commonTypeDefs = /* GraphQL */ `
  "Дата и время в формате ISO-8601"
  scalar DateTime

  enum SortDirection {
    ASC
    DESC
  }

  "Информация о странице (Relay Cursor Connections)"
  type PageInfo @shareable {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  input IntFilter {
    eq: Int
    ne: Int
    gt: Int
    gte: Int
    lt: Int
    lte: Int
    in: [Int!]
  }

  input StringFilter {
    eq: String
    ne: String
    in: [String!]
    contains: String
    startsWith: String
  }

  input DateFilter {
    gt: DateTime
    gte: DateTime
    lt: DateTime
    lte: DateTime
  }

  enum SyncStatus {
    QUEUED
    RUNNING
    COMPLETED
    FAILED
  }

  "Запуск автоматического сбора данных из внешнего источника"
  type SyncRun @shareable {
    id: ID!
    source: String!
    status: SyncStatus!
    startedAt: DateTime
    finishedAt: DateTime
    processed: Int!
    message: String
    error: String
    createdAt: DateTime!
  }

  type YearStat @shareable {
    year: Int!
    count: Int!
  }
`;

const DateTime = new GraphQLScalarType({
  name: 'DateTime',
  description: 'ISO-8601 date-time',
  serialize(value) {
    if (value === null || value === undefined) return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) throw new GraphQLError(`DateTime cannot represent "${value}"`);
    return d.toISOString();
  },
  parseValue(value) {
    const d = new Date(value);
    if (typeof value !== 'string' || Number.isNaN(d.getTime())) {
      throw new GraphQLError('DateTime must be an ISO-8601 string', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    return d.toISOString();
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) throw new GraphQLError('DateTime must be a string');
    const d = new Date(ast.value);
    if (Number.isNaN(d.getTime())) throw new GraphQLError('Invalid DateTime');
    return d.toISOString();
  },
});

const mapSyncRun = (r) =>
  r && {
    id: String(r.id),
    source: r.source,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    processed: r.processed,
    message: r.message,
    error: r.error,
    createdAt: r.created_at,
  };

const notFound = (what) => new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });

module.exports = { commonTypeDefs, DateTime, mapSyncRun, notFound };
