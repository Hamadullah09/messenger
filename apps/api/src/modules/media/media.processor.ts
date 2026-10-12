import { createHash } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { MediaMimeType } from '@storeline/shared';
import { Worker, type Job } from 'bullmq';
import sharp from 'sharp';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { MalwareScanner, ScannerUnavailableError } from '../../infra/scanning/malware-scanner';
import { StorageService } from '../../infra/storage/storage.service';
import { AuditService } from '../audit/audit.service';
import {
  MEDIA_JOB_OPTIONS,
  MEDIA_QUEUE,
  type DeliveryJobData,
  type OutboxEventPayloads,
} from '../outbox/outbox.types';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import { metrics } from '../../infra/metrics/metrics';
import { SNIFF_BYTES, verifySignature } from './file-signature';
import { mediaAssetSelect, storageKeys, toMediaAssetDto } from './media.mapper';

const CONCURRENCY = 4;
const THUMBNAIL_SIZE = 480;
/** Decompression-bomb guard for image decoding (≈ 7000 × 7000). */
const MAX_INPUT_PIXELS = 50_000_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;

class PermanentMediaError extends Error {}

/**
 * Worker-side verification (docs/architecture/media.md). One streaming pass over the
 * uploaded object computes SHA-256, checks the file signature, and feeds ClamAV, so files
 * are never fully buffered in memory. Only clean, correctly typed files are promoted to the
 * served prefix; malware is moved to quarantine; everything else is rejected.
 */
@Injectable()
export class MediaProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MediaProcessor.name);
  private worker: Worker<DeliveryJobData> | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly scanner: MalwareScanner,
    private readonly realtime: RealtimeEmitter,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<DeliveryJobData>(MEDIA_QUEUE, (job) => this.process(job), {
      connection: this.redis.createConnection('media-worker', { forBullMq: true }),
      concurrency: CONCURRENCY,
      // Scans of large files take a while; keep the job lock alive.
      lockDuration: 120_000,
    });
    this.worker.on('failed', (job, error) => void this.onFailed(job, error));
    this.worker.on('error', (error) => this.logger.error({ err: error }, 'Media worker error'));
    // A failed sweep (e.g. database briefly unavailable) is logged and retried next round;
    // it must never take the worker down.
    this.sweepTimer = setInterval(
      () =>
        void this.sweepExpiredUploads().catch((error: unknown) =>
          this.logger.warn({ err: error }, 'Expired-upload sweep failed; will retry'),
        ),
      SWEEP_INTERVAL_MS,
    ).unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.worker?.close();
  }

  async process(job: Pick<Job<DeliveryJobData>, 'data'>): Promise<void> {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id: job.data.outboxId },
      select: { type: true, payload: true },
    });
    if (!event || event.type !== 'media.uploaded')
      throw new PermanentMediaError('Unknown media event');
    await this.verify((event.payload as OutboxEventPayloads['media.uploaded']).mediaId);
  }

  async verify(mediaId: string): Promise<void> {
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: {
        id: true,
        businessId: true,
        uploaderId: true,
        status: true,
        kind: true,
        mimeType: true,
        sizeBytes: true,
        incomingKey: true,
      },
    });
    if (!media) throw new PermanentMediaError(`Media ${mediaId} not found`);
    if (media.status !== 'VERIFYING') return; // already handled (idempotent re-run)

    const declared = media.mimeType as MediaMimeType;
    const hash = createHash('sha256');
    const headChunks: Buffer[] = [];
    let headLength = 0;
    let total = 0;

    const scan = await this.scanner.start();
    try {
      const stream = await this.storage.getStream(media.incomingKey);
      for await (const raw of stream) {
        const chunk = raw as Buffer;
        total += chunk.length;
        hash.update(chunk);
        if (headLength < SNIFF_BYTES) {
          const slice = chunk.subarray(0, SNIFF_BYTES - headLength);
          headChunks.push(slice);
          headLength += slice.length;
        }
        await scan.write(chunk);
      }
    } catch (error) {
      scan.abort();
      throw error;
    }
    const scanResult = await scan.finish();
    const head = Buffer.concat(headChunks);

    if (!scanResult.clean) {
      await this.quarantine(media, scanResult.signature);
      return;
    }
    if (total !== Number(media.sizeBytes)) {
      await this.reject(media, 'size_mismatch');
      return;
    }
    const signature = verifySignature(declared, head, total <= SNIFF_BYTES);
    if (!signature.ok) {
      await this.reject(media, signature.reason);
      return;
    }

    // Promote: server-side copy to the served prefix, then drop the unverified object.
    const objectKey = storageKeys.verified(media.businessId, media.id);
    await this.storage.copy(media.incomingKey, objectKey);

    let width: number | null = null;
    let height: number | null = null;
    let thumbnailKey: string | null = null;
    if (media.kind === 'IMAGE') {
      try {
        const result = await this.makeThumbnail(objectKey);
        width = result.width;
        height = result.height;
        thumbnailKey = storageKeys.thumbnail(media.businessId, media.id);
        await this.storage.put(thumbnailKey, result.thumbnail, {
          contentType: 'image/webp',
          contentDisposition: 'inline',
        });
      } catch (error) {
        // HEIC needs a decoder that is not bundled; it is still a valid photo without a preview.
        if (declared !== 'image/heic') {
          this.logger.warn({ err: error, mediaId }, 'Image could not be decoded; rejecting');
          await this.storage.delete(objectKey).catch(() => undefined);
          await this.reject(media, 'image_unreadable');
          return;
        }
      }
    }

    const updated = await this.prisma.mediaAsset.updateMany({
      where: { id: media.id, status: 'VERIFYING' },
      data: {
        status: 'READY',
        objectKey,
        thumbnailKey,
        width,
        height,
        sha256: hash.digest('hex'),
        readyAt: new Date(),
      },
    });
    if (updated.count > 0) {
      metrics.mediaProcessed.inc({ outcome: 'ready' });
      metrics.mediaUploadBytes.inc(Number(media.sizeBytes));
    }
    await this.storage.delete(media.incomingKey).catch(() => undefined);
    if (updated.count > 0) await this.notify(media.id, media.uploaderId);
  }

  private async makeThumbnail(
    key: string,
  ): Promise<{ thumbnail: Buffer; width: number; height: number }> {
    const source = await this.storage.getStream(key);
    const image = sharp({
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
      sequentialRead: true,
    });
    source.pipe(image);
    const [metadata, thumbnail] = await Promise.all([
      image.metadata(),
      image
        .clone()
        .rotate() // apply EXIF orientation, then strip metadata (location etc.) from the preview
        .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer(),
    ]);
    if (!metadata.width || !metadata.height) throw new Error('Image has no dimensions');
    const rotated = (metadata.orientation ?? 1) >= 5;
    return {
      thumbnail,
      width: rotated ? metadata.height : metadata.width,
      height: rotated ? metadata.width : metadata.height,
    };
  }

  private async quarantine(
    media: { id: string; businessId: string; uploaderId: string; incomingKey: string },
    signature: string,
  ): Promise<void> {
    await this.storage.copy(media.incomingKey, storageKeys.quarantine(media.businessId, media.id));
    await this.storage.delete(media.incomingKey).catch(() => undefined);
    const updated = await this.prisma.mediaAsset.updateMany({
      where: { id: media.id, status: 'VERIFYING' },
      data: { status: 'QUARANTINED', failureReason: 'malware_detected' },
    });
    if (updated.count > 0) metrics.mediaProcessed.inc({ outcome: 'quarantined' });
    await this.audit.record(
      { userId: media.uploaderId },
      {
        action: 'media.quarantined',
        outcome: 'DENIED',
        businessId: media.businessId,
        targetType: 'MediaAsset',
        targetId: media.id,
        metadata: { signature },
      },
    );
    this.logger.warn({ mediaId: media.id, signature }, 'Upload quarantined by malware scanner');
    if (updated.count > 0) await this.notify(media.id, media.uploaderId);
  }

  private async reject(
    media: { id: string; businessId: string; uploaderId: string; incomingKey: string },
    reason: string,
  ): Promise<void> {
    await this.storage.delete(media.incomingKey).catch(() => undefined);
    const updated = await this.prisma.mediaAsset.updateMany({
      where: { id: media.id, status: 'VERIFYING' },
      data: { status: 'REJECTED', failureReason: reason },
    });
    if (updated.count > 0) metrics.mediaProcessed.inc({ outcome: 'rejected' });
    await this.audit.record(
      { userId: media.uploaderId },
      {
        action: 'media.rejected',
        outcome: 'DENIED',
        businessId: media.businessId,
        targetType: 'MediaAsset',
        targetId: media.id,
        metadata: { reason },
      },
    );
    if (updated.count > 0) await this.notify(media.id, media.uploaderId);
  }

  private async notify(mediaId: string, uploaderId: string): Promise<void> {
    const row = await this.prisma.mediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
      select: mediaAssetSelect,
    });
    this.realtime.toUsers([uploaderId], 'media.status_changed', toMediaAssetDto(row));
  }

  /** After the last retry the asset is marked FAILED (never READY) and the uploader is told. */
  private async onFailed(job: Job<DeliveryJobData> | undefined, error: Error): Promise<void> {
    if (!job) return;
    const permanent = error instanceof PermanentMediaError;
    if (permanent) await job.discard();
    const final =
      permanent || job.attemptsMade >= (job.opts.attempts ?? MEDIA_JOB_OPTIONS.attempts);
    this.logger.error(
      {
        err: error,
        outboxId: job.data.outboxId,
        attempt: job.attemptsMade,
        final,
        scanner: error instanceof ScannerUnavailableError,
      },
      'Media verification failed',
    );
    if (!final) return;
    try {
      const event = await this.prisma.outboxEvent.update({
        where: { id: job.data.outboxId },
        data: { status: 'FAILED', lastError: error.message.slice(0, 500) },
        select: { payload: true },
      });
      const { mediaId } = event.payload as OutboxEventPayloads['media.uploaded'];
      const media = await this.prisma.mediaAsset.findUnique({
        where: { id: mediaId },
        select: { uploaderId: true },
      });
      const updated = await this.prisma.mediaAsset.updateMany({
        where: { id: mediaId, status: 'VERIFYING' },
        data: { status: 'FAILED', failureReason: 'processing_failed' },
      });
      if (updated.count > 0) metrics.mediaProcessed.inc({ outcome: 'failed' });
      if (media && updated.count > 0) await this.notify(mediaId, media.uploaderId);
    } catch (recordError) {
      this.logger.error({ err: recordError }, 'Could not record failed media verification');
    }
  }

  /** Removes abandoned uploads (also covered by a bucket lifecycle rule in production). */
  async sweepExpiredUploads(now = new Date()): Promise<number> {
    const expired = await this.prisma.mediaAsset.findMany({
      where: { status: 'PENDING_UPLOAD', uploadExpiresAt: { lt: now } },
      select: { id: true, incomingKey: true, multipartUploadId: true },
      take: 200,
    });
    for (const media of expired) {
      try {
        if (media.multipartUploadId) {
          await this.storage
            .abortMultipartUpload(media.incomingKey, media.multipartUploadId)
            .catch(() => undefined);
        }
        await this.storage.delete(media.incomingKey).catch(() => undefined);
        await this.prisma.mediaAsset.updateMany({
          where: { id: media.id, status: 'PENDING_UPLOAD' },
          data: { status: 'FAILED', failureReason: 'upload_expired', multipartUploadId: null },
        });
      } catch (error) {
        this.logger.warn({ err: error, mediaId: media.id }, 'Could not clean up expired upload');
      }
    }
    return expired.length;
  }
}
