import { Injectable } from '@nestjs/common';
import { ApiError } from '../http/api-error';
import { RedisService } from './redis.service';

export interface RateLimitRule {
  /** Key namespace, e.g. "login:ip". */
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/**
 * Distributed fixed-window rate limiter backed by Redis (shared by all API replicas).
 * Fails open if Redis is unavailable so that a cache outage does not take messaging down;
 * the failure is logged by ioredis and visible in metrics.
 */
@Injectable()
export class RateLimiterService {
  constructor(private readonly redis: RedisService) {}

  async hit(rule: RateLimitRule, subject: string): Promise<RateLimitResult> {
    const key = `rl:${rule.name}:${subject}`;
    try {
      const results = await this.redis.client
        .multi()
        .incr(key)
        .expire(key, rule.windowSeconds, 'NX')
        .ttl(key)
        .exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      const ttl = Number(results?.[2]?.[1] ?? rule.windowSeconds);
      return {
        allowed: count <= rule.limit,
        remaining: Math.max(0, rule.limit - count),
        retryAfterSeconds: ttl > 0 ? ttl : rule.windowSeconds,
      };
    } catch {
      return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
    }
  }

  async consume(rule: RateLimitRule, subject: string): Promise<void> {
    const result = await this.hit(rule, subject);
    if (!result.allowed) throw ApiError.rateLimited(result.retryAfterSeconds);
  }

  /** True when the subject already used up the rule's budget (does not count a hit). */
  async exceeded(
    rule: RateLimitRule,
    subject: string,
  ): Promise<{ limited: boolean; retryAfterSeconds: number }> {
    const key = `rl:${rule.name}:${subject}`;
    try {
      const [count, ttl] = await Promise.all([
        this.redis.client.get(key),
        this.redis.client.ttl(key),
      ]);
      return {
        limited: Number(count ?? 0) >= rule.limit,
        retryAfterSeconds: ttl > 0 ? ttl : rule.windowSeconds,
      };
    } catch {
      return { limited: false, retryAfterSeconds: 0 };
    }
  }

  async reset(rule: RateLimitRule, subject: string): Promise<void> {
    await this.redis.client.del(`rl:${rule.name}:${subject}`).catch(() => undefined);
  }
}

export const RATE_LIMITS = {
  loginPerIp: { name: 'login:ip', limit: 30, windowSeconds: 300 },
  loginPerUsername: { name: 'login:user', limit: 10, windowSeconds: 900 },
  /** Guesses per sign-in attempt (per MFA token). */
  mfaPerToken: { name: 'mfa:token', limit: 5, windowSeconds: 300 },
  /** Failed codes per user across sign-in attempts (brute-force guard). */
  mfaFailuresPerUser: { name: 'mfa:fail', limit: 10, windowSeconds: 900 },
  /** Generous per-IP ceiling: many people may share one office IP. */
  mfaPerIp: { name: 'mfa:ip', limit: 60, windowSeconds: 300 },
  refreshPerIp: { name: 'refresh:ip', limit: 60, windowSeconds: 60 },
  messageSendPerUser: { name: 'msg:user', limit: 60, windowSeconds: 60 },
  messageSendPerBusiness: { name: 'msg:biz', limit: 3000, windowSeconds: 60 },
  searchPerUser: { name: 'search:user', limit: 30, windowSeconds: 60 },
  directoryPerUser: { name: 'directory:user', limit: 60, windowSeconds: 60 },
  /** Generous: a real emergency must never be throttled, but alert floods are abuse. */
  emergencyPerUser: { name: 'emergency:user', limit: 10, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitRule>;
