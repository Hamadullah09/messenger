import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Page, SearchMessagesQuery, SearchResultDto } from '@storeline/shared';
import { decodeCursor, encodeCursor } from '../../infra/http/cursor';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RATE_LIMITS, RateLimiterService } from '../../infra/redis/rate-limiter.service';
import type { Actor } from '../auth/actor';
import { messageInclude, toMessageDto } from './mappers';

const isSearchCursor = (v: Record<string, unknown>): v is { t: string; id: string } =>
  typeof v.t === 'string' && typeof v.id === 'string';

/**
 * Converts free text into a safe prefix-matching tsquery: only letters and digits survive,
 * so user input can never inject tsquery operators.
 */
export function toPrefixTsQuery(text: string): string | null {
  const terms = text
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 8)
    .map((t) => `${t.toLowerCase()}:*`);
  return terms.length > 0 ? terms.join(' & ') : null;
}

/** Escapes LIKE wildcards so user input is matched literally (used with ESCAPE '\'). */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Full-text search (PostgreSQL GIN index, 'simple' config). Visibility is enforced in SQL:
 * active membership, history boundary, non-deleted, active business.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async searchMessages(actor: Actor, query: SearchMessagesQuery): Promise<Page<SearchResultDto>> {
    await this.rateLimiter.consume(RATE_LIMITS.searchPerUser, actor.userId);
    const tsQuery = toPrefixTsQuery(query.q);
    if (!tsQuery) return { items: [], nextCursor: null };
    // Attachment names are matched as a literal substring (LIKE wildcards escaped).
    const fileNamePattern = `%${escapeLikePattern(query.q)}%`;
    const cursor = decodeCursor(query.cursor, isSearchCursor);

    const hits = await this.prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>(Prisma.sql`
      SELECT m."id", m."createdAt"
        FROM "Message" m
        JOIN "ConversationMember" cm
          ON cm."conversationId" = m."conversationId" AND cm."userId" = ${actor.userId}::uuid AND cm."leftAt" IS NULL
        JOIN "Conversation" c ON c."id" = m."conversationId"
        JOIN "Business" b ON b."id" = c."businessId" AND b."status" = 'ACTIVE'
       WHERE m."deletedAt" IS NULL
         AND m."kind" <> 'SYSTEM'
         AND m."seq" > cm."historyFromSeq"
         AND (
           to_tsvector('simple', COALESCE(m."body", '')) @@ to_tsquery('simple', ${tsQuery})
           OR EXISTS (
             SELECT 1 FROM "MessageAttachment" ma
               JOIN "MediaAsset" ma2 ON ma2."id" = ma."mediaId"
              WHERE ma."messageId" = m."id" AND ma2."fileName" ILIKE ${fileNamePattern} ESCAPE '\\'
           )
         )
         ${query.conversationId ? Prisma.sql`AND m."conversationId" = ${query.conversationId}::uuid` : Prisma.empty}
         ${query.businessId ? Prisma.sql`AND c."businessId" = ${query.businessId}::uuid` : Prisma.empty}
         ${cursor ? Prisma.sql`AND (m."createdAt", m."id") < (${new Date(cursor.t)}, ${cursor.id}::uuid)` : Prisma.empty}
       ORDER BY m."createdAt" DESC, m."id" DESC
       LIMIT ${query.limit + 1}
    `);
    const page = hits.slice(0, query.limit);
    const rows = await this.prisma.message.findMany({
      where: { id: { in: page.map((h) => h.id) } },
      include: {
        ...messageInclude,
        conversation: { select: { id: true, title: true, type: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = page.flatMap((hit) => {
      const row = byId.get(hit.id);
      if (!row) return [];
      return [
        {
          message: toMessageDto(row),
          conversation: {
            id: row.conversation.id,
            type: row.conversation.type,
            title:
              row.conversation.title ??
              (row.conversation.type === 'DIRECT' ? 'Direct message' : 'Group'),
          },
        },
      ];
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        hits.length > query.limit && last
          ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }
}
