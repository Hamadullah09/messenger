import { Prisma } from '@prisma/client';
import type { CampaignAudience } from '@storeline/shared';

/**
 * Who may manage campaigns where: business-wide holders of bulk_message.send, or holders
 * scoped to specific stores (their audience is limited to members of those stores).
 */
export interface CampaignScope {
  businessId: string;
  businessWide: boolean;
  storeIds: string[];
}

/**
 * The eligible audience as a SQL CTE (`eligible(id)`), always inside one business:
 * union of segments → active, internal (or opted-in customer) business members → role
 * filter → sender's store scope. The creator is never a recipient.
 */
export function eligibleAudienceSql(
  audience: CampaignAudience,
  scope: CampaignScope,
  creatorId: string,
): Prisma.Sql {
  const b = scope.businessId;
  return Prisma.sql`
    seg AS (
      SELECT bm."userId" FROM "BusinessMembership" bm
       WHERE bm."businessId" = ${b}::uuid AND bm."status" = 'ACTIVE' AND ${audience.everyone}
      UNION
      SELECT sm."userId" FROM "StoreMembership" sm
        JOIN "Store" s ON s."id" = sm."storeId"
       WHERE sm."businessId" = ${b}::uuid AND sm."status" = 'ACTIVE' AND s."status" = 'ACTIVE'
         AND sm."storeId" = ANY(${audience.storeIds}::uuid[])
      UNION
      SELECT cm."userId" FROM "ConversationMember" cm
        JOIN "Conversation" c ON c."id" = cm."conversationId"
       WHERE c."businessId" = ${b}::uuid AND c."type" = 'GROUP' AND c."archivedAt" IS NULL
         AND cm."leftAt" IS NULL AND c."id" = ANY(${audience.groupIds}::uuid[])
    ),
    eligible AS (
      SELECT DISTINCT u."id" FROM seg
        JOIN "User" u ON u."id" = seg."userId"
        JOIN "BusinessMembership" bm
          ON bm."userId" = u."id" AND bm."businessId" = ${b}::uuid AND bm."status" = 'ACTIVE'
       WHERE u."status" = 'ACTIVE'
         AND u."id" <> ${creatorId}::uuid
         AND (u."kind" = 'INTERNAL' OR (${audience.includeCustomers} AND u."kind" = 'EXTERNAL'))
         AND (cardinality(${audience.roleKeys}::text[]) = 0 OR EXISTS (
               SELECT 1 FROM "RoleAssignment" ra JOIN "Role" r ON r."id" = ra."roleId"
                WHERE ra."userId" = u."id" AND ra."businessId" = ${b}::uuid
                  AND ra."revokedAt" IS NULL AND r."isSystem"
                  AND r."key" = ANY(${audience.roleKeys}::text[])))
         AND (${scope.businessWide} OR EXISTS (
               SELECT 1 FROM "StoreMembership" sm2
                WHERE sm2."userId" = u."id" AND sm2."status" = 'ACTIVE'
                  AND sm2."storeId" = ANY(${scope.storeIds}::uuid[])))
    )`;
}

export function previewSql(
  audience: CampaignAudience,
  scope: CampaignScope,
  creatorId: string,
): Prisma.Sql {
  return Prisma.sql`
    WITH ${eligibleAudienceSql(audience, scope, creatorId)}
    SELECT count(*) FILTER (WHERE s."userId" IS NULL)::int AS "recipients",
           count(*) FILTER (WHERE s."userId" IS NOT NULL)::int AS "suppressed"
      FROM eligible e
      LEFT JOIN "CampaignSuppression" s
        ON s."businessId" = ${scope.businessId}::uuid AND s."userId" = e."id"`;
}

/**
 * Snapshots the audience into recipient rows in one statement (no per-recipient round trips).
 * Suppressed people are recorded as SKIPPED so the report accounts for them.
 */
export function materializeSql(
  campaignId: string,
  audience: CampaignAudience,
  scope: CampaignScope,
  creatorId: string,
): Prisma.Sql {
  return Prisma.sql`
    WITH ${eligibleAudienceSql(audience, scope, creatorId)}
    INSERT INTO "BulkCampaignRecipient" ("campaignId", "userId", "state", "reason", "processedAt")
    SELECT ${campaignId}::uuid, e."id",
           (CASE WHEN s."userId" IS NULL THEN 'PENDING' ELSE 'SKIPPED' END)::"CampaignRecipientState",
           CASE WHEN s."userId" IS NULL THEN NULL ELSE 'suppressed' END,
           CASE WHEN s."userId" IS NULL THEN NULL ELSE now() END
      FROM eligible e
      LEFT JOIN "CampaignSuppression" s
        ON s."businessId" = ${scope.businessId}::uuid AND s."userId" = e."id"
    ON CONFLICT DO NOTHING`;
}

/**
 * Per-recipient delivery bucket (mutually exclusive). Delivery and read come from the
 * recipient's channel watermarks, so they are only reported once their device confirmed.
 */
export function bucketSql(readReceipts: boolean): Prisma.Sql {
  return Prisma.sql`
    CASE
      WHEN r."state" = 'PENDING' THEN 'QUEUED'
      WHEN r."state" = 'SKIPPED' THEN 'SKIPPED'
      WHEN r."state" = 'CANCELLED' THEN 'CANCELLED'
      WHEN r."state" = 'FAILED' OR m."state" = 'FAILED' THEN 'FAILED'
      WHEN ${readReceipts} AND cm."lastReadSeq" >= m."seq" THEN 'READ'
      WHEN cm."lastDeliveredSeq" >= m."seq" THEN 'DELIVERED'
      WHEN m."state" = 'DISPATCHED' THEN 'SENT_TO_GATEWAY'
      ELSE 'ACCEPTED'
    END`;
}

export const recipientJoinsSql = Prisma.sql`
  FROM "BulkCampaignRecipient" r
  LEFT JOIN "Message" m ON m."id" = r."messageId"
  LEFT JOIN "ConversationMember" cm
    ON cm."conversationId" = m."conversationId" AND cm."userId" = r."userId"`;
