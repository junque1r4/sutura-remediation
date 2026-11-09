import IORedis from 'ioredis';
import { getConfig } from '../config';

let _connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (_connection) return _connection;
  const config = getConfig();
  _connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  return _connection;
}
