import type { Readable } from 'node:stream';
import { Global, Inject, Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type Part,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APP_CONFIG, isLanHostname, type AppConfig } from '../config/config';
import { requestContext } from '../http/request-context';

export interface ObjectHeaders {
  contentType: string;
  contentDisposition: string;
}

/**
 * Thin wrapper over the S3 API. Two clients: one for server-side operations (internal
 * endpoint) and one used only to sign URLs that browsers call (public endpoint). Storage
 * credentials and object keys never leave this service except inside signed URLs.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly signer: S3Client;
  readonly bucket: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const base = {
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
    };
    this.client = new S3Client({
      ...base,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    });
    const publicEndpoint = config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT;
    this.signer = new S3Client({
      ...base,
      ...(publicEndpoint ? { endpoint: publicEndpoint } : {}),
    });
    this.bucket = config.S3_BUCKET;
  }

  /** One signer per storage address (development: one per LAN host browsers use). */
  private readonly lanSigners = new Map<string, S3Client>();

  /**
   * Presigned links point at an address the browser can reach. In development with
   * CORS_ALLOW_LAN, a phone that opened the app at http://192.168.x.x:3000 gets links to that
   * same origin (apps/web/lan-server.mjs forwards them to storage), not 127.0.0.1.
   */
  private signerForRequest(): S3Client {
    const configured = this.config.S3_PUBLIC_ENDPOINT ?? this.config.S3_ENDPOINT;
    const page = requestContext.getStore();
    if (!this.config.CORS_ALLOW_LAN || !configured || !page?.hostname || !page.origin)
      return this.signer;
    const base = new URL(configured);
    if (!isLanHostname(page.hostname) || page.hostname === base.hostname) return this.signer;
    if (page.hostname === 'localhost' || page.hostname === '127.0.0.1') return this.signer;
    // Links go to the page's own origin; the LAN web server forwards /<bucket>/… to storage.
    const endpoint = page.origin;
    let signer = this.lanSigners.get(endpoint);
    if (!signer) {
      signer = new S3Client({
        region: this.config.S3_REGION,
        forcePathStyle: this.config.S3_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: this.config.S3_ACCESS_KEY_ID,
          secretAccessKey: this.config.S3_SECRET_ACCESS_KEY,
        },
        endpoint,
      });
      this.lanSigners.set(endpoint, signer);
    }
    return signer;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.S3_AUTO_CREATE_BUCKET) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client
        .send(new CreateBucketCommand({ Bucket: this.bucket }))
        .catch((error: unknown) => {
          this.logger.warn({ err: error }, 'Bucket creation failed (it may already exist)');
        });
    }
    // Browsers upload and download directly; only the configured web origins are allowed.
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              // Development on the LAN: phones upload from http://192.168.x.x:3000.
              AllowedOrigins: this.config.CORS_ALLOW_LAN
                ? [...this.config.CORS_ORIGINS, '*']
                : this.config.CORS_ORIGINS,
              AllowedMethods: ['PUT', 'GET', 'HEAD'],
              AllowedHeaders: ['content-type', 'content-disposition', 'content-length', 'range'],
              ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range'],
              MaxAgeSeconds: 600,
            },
          ],
        },
      }),
    );
  }

  /** Presigned single PUT. Length, type and disposition are signed: the client must send them exactly. */
  presignPut(
    key: string,
    sizeBytes: number,
    headers: ObjectHeaders,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.signerForRequest(),
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentLength: sizeBytes,
        ContentType: headers.contentType,
        ContentDisposition: headers.contentDisposition,
      }),
      {
        expiresIn,
        signableHeaders: new Set(['content-length', 'content-type', 'content-disposition']),
      },
    );
  }

  async createMultipartUpload(key: string, headers: ObjectHeaders): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: headers.contentType,
        ContentDisposition: headers.contentDisposition,
      }),
    );
    if (!result.UploadId) throw new Error('Storage did not return an upload id');
    return result.UploadId;
  }

  /** Presigned part upload with the exact part length signed. */
  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    sizeBytes: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.signerForRequest(),
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: sizeBytes,
      }),
      { expiresIn, signableHeaders: new Set(['content-length']) },
    );
  }

  async listParts(key: string, uploadId: string): Promise<Part[]> {
    const parts: Part[] = [];
    let marker: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      parts.push(...(result.Parts ?? []));
      if (!result.IsTruncated || !result.NextPartNumberMarker) break;
      marker = result.NextPartNumberMarker;
    }
    return parts;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: Part[]): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
    );
  }

  /** Object size in bytes, or null if the object does not exist. */
  async objectSize(key: string): Promise<number | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return head.ContentLength ?? null;
    } catch (error) {
      if (
        (error as { name?: string }).name === 'NotFound' ||
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  /** Streams an object (never buffered whole in memory). */
  async getStream(key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error('Empty object body');
    return result.Body as Readable;
  }

  /** Server-side copy; the bytes never pass through this process. */
  async copy(sourceKey: string, targetKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: targetKey,
        CopySource: `${this.bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
      }),
    );
  }

  async put(key: string, body: Buffer, headers: ObjectHeaders): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: headers.contentType,
        ContentDisposition: headers.contentDisposition,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Short-lived download URL. Response headers are forced where the provider supports it
   * (AWS S3, R2); they were also stored on the object at upload time.
   */
  presignGet(key: string, headers: ObjectHeaders, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.signerForRequest(),
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: headers.contentType,
        ResponseContentDisposition: headers.contentDisposition,
      }),
      { expiresIn },
    );
  }
}

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
