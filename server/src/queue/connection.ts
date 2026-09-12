import type { ConnectionOptions } from "bullmq";
import { config } from "../config";

// ============================================
// Shared Redis connection options for BullMQ. Passed as plain options (not an
// ioredis instance) so every Queue/Worker uses BullMQ's bundled ioredis build.
//
// `maxRetriesPerRequest: null` is required by BullMQ (it manages its own
// retry/blocking semantics). Redis Cloud usually needs TLS even on `redis://`;
// local `redis://localhost` stays plain.
// ============================================

const url = new URL(config.redisUrl);
const isRedisCloud = /\.(redis\.io|redislabs\.com)$/i.test(url.hostname);

const useTls =
  url.protocol === "rediss:" ||
  process.env.REDIS_TLS === "true" ||
  (isRedisCloud && process.env.REDIS_TLS !== "false");

const rejectUnauthorized =
  process.env.REDIS_TLS_REJECT_UNAUTHORIZED === "true"
    ? true
    : isRedisCloud
      ? false
      : process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false";

export const redisConnection: ConnectionOptions = {
  host: url.hostname,
  port: url.port ? Number(url.port) : useTls ? 6380 : 6379,
  username: url.username ? decodeURIComponent(url.username) : undefined,
  password: url.password ? decodeURIComponent(url.password) : undefined,
  maxRetriesPerRequest: null,
  ...(useTls
    ? { tls: { servername: url.hostname, rejectUnauthorized } }
    : {}),
};
