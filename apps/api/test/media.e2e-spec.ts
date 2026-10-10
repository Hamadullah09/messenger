import type { MediaAssetDto, MessageDto, UploadSessionDto } from '@storeline/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaProcessor } from '../src/modules/media/media.processor';
import { collectEvents, Harness, nextEvent, uuid, type Session } from './harness';

// The EICAR antivirus test string, stored encoded so local antivirus does not flag this file.
const EICAR = Buffer.from(
  'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=',
  'base64',
);
const MB = 1024 * 1024;

/**
 * Media pipeline end to end against real object storage (SeaweedFS), ClamAV, PostgreSQL,
 * Redis and the worker: presigned uploads, multipart + resume, verification, quarantine,
 * attachment rules and authorized downloads.
 */
describe('Media sharing', () => {
  let h: Harness;
  let businessId: string;
  let storeA: string;
  let alice: Session;
  let bob: Session;
  let carol: Session; // store B, not in the group
  let manager: Session;
  let outsider: Session; // other business
  let groupId: string;
  let ids: Record<'alice' | 'bob' | 'carol' | 'manager', string>;

  beforeAll(async () => {
    h = await Harness.start({ worker: true });
    businessId = (await h.createBusiness()).id;
    storeA = (await h.createStore(businessId, 'A')).id;
    const storeB = (await h.createStore(businessId, 'B')).id;
    const other = (await h.createBusiness()).id;
    const m = await h.createUser({ role: 'STORE_MANAGER', businessId, storeIds: [storeA] });
    const a = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeA] });
    const b = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeA] });
    const c = await h.createUser({ role: 'EMPLOYEE', businessId, storeIds: [storeB] });
    const o = await h.createUser({
      role: 'EMPLOYEE',
      businessId: other,
      storeIds: [(await h.createStore(other)).id],
    });
    ids = { manager: m.id, alice: a.id, bob: b.id, carol: c.id };
    manager = await h.login(m.username);
    alice = await h.login(a.username);
    bob = await h.login(b.username);
    carol = await h.login(c.username);
    outsider = await h.login(o.username);
    groupId = (
      await manager
        .post('/api/v1/conversations/groups')
        .send({
          businessId,
          storeId: storeA,
          title: 'Store A photos',
          memberIds: [ids.alice, ids.bob],
        })
        .expect(201)
    ).body.id;
  });
  afterAll(() => h.stop());

  function startUpload(
    s: Session,
    conversationId: string,
    fileName: string,
    mimeType: string,
    sizeBytes: number,
  ) {
    return s.post('/api/v1/media/uploads').send({ conversationId, fileName, mimeType, sizeBytes });
  }

  /** Uploads bytes exactly as a browser would, then completes the upload. */
  async function upload(
    s: Session,
    conversationId: string,
    data: Buffer,
    fileName: string,
    mimeType: string,
  ) {
    const res = await startUpload(s, conversationId, fileName, mimeType, data.length).expect(201);
    const session = res.body as UploadSessionDto;
    if (session.upload.method === 'PUT') {
      const put = await fetch(session.upload.url, {
        method: 'PUT',
        body: data,
        headers: session.upload.headers,
      });
      expect(put.status).toBe(200);
    } else {
      for (const part of session.upload.parts) {
        const start = (part.partNumber - 1) * session.upload.partSize;
        const put = await fetch(part.url, {
          method: 'PUT',
          body: data.subarray(start, start + part.sizeBytes),
        });
        expect(put.status).toBe(200);
      }
    }
    await s.post(`/api/v1/media/uploads/${session.media.id}/complete`).expect(202);
    return session.media.id;
  }

  async function waitForStatus(
    s: Session,
    mediaId: string,
    timeoutMs = 30_000,
  ): Promise<MediaAssetDto> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await s.get(`/api/v1/media/${mediaId}`).expect(200);
      if (res.body.status !== 'VERIFYING' && res.body.status !== 'PENDING_UPLOAD')
        return res.body as MediaAssetDto;
      if (Date.now() > deadline) throw new Error(`media ${mediaId} still ${res.body.status}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const sendWithMedia = (s: Session, conversationId: string, mediaId: string, body?: string) =>
    s
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .send({ clientMessageId: uuid(), mediaId, body });

  describe('images', () => {
    let mediaId: string;
    let message: MessageDto;
    let png: Buffer;

    it('uploads directly to storage, verifies, scans and generates a thumbnail', async () => {
      png = await sharp({
        create: { width: 1600, height: 900, channels: 3, background: '#0b6b5d' },
      })
        .png()
        .toBuffer();
      const aliceSocket = await h.socket(alice);
      const ready = nextEvent<MediaAssetDto>(aliceSocket, 'media.status_changed', 30_000);
      mediaId = await upload(alice, groupId, png, 'shelf photo.png', 'image/png');
      const pushed = await ready;
      expect(pushed).toMatchObject({ id: mediaId, status: 'READY' });
      const media = await waitForStatus(alice, mediaId);
      expect(media).toMatchObject({
        status: 'READY',
        kind: 'IMAGE',
        width: 1600,
        height: 900,
        hasThumbnail: true,
      });
      const row = await h.prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.objectKey).toBe(`media/${businessId}/${mediaId}`);
    });

    it('sends the image as a message; recipients get metadata but never a storage URL', async () => {
      const bobSocket = await h.socket(bob);
      const received = nextEvent<MessageDto>(
        bobSocket,
        'message.created',
        8_000,
        (m) => m.attachment?.mediaId === mediaId,
      );
      const res = await sendWithMedia(alice, groupId, mediaId, 'New display is up').expect(201);
      message = res.body;
      expect(message).toMatchObject({ kind: 'IMAGE', body: 'New display is up' });
      expect(message.attachment).toMatchObject({
        mediaId,
        fileName: 'shelf photo.png',
        width: 1600,
        hasThumbnail: true,
      });
      const pushed = await received;
      expect(JSON.stringify(pushed)).not.toMatch(/https?:\/\/|X-Amz|incoming\/|media\//);
    });

    it('members download through short-lived signed URLs', async () => {
      const original = await bob.get(`/api/v1/media/${mediaId}/url`).expect(200);
      const file = await fetch(original.body.url);
      expect(file.status).toBe(200);
      expect(Buffer.from(await file.arrayBuffer()).equals(png)).toBe(true);
      const thumb = await bob.get(`/api/v1/media/${mediaId}/url?variant=thumbnail`).expect(200);
      const preview = Buffer.from(await (await fetch(thumb.body.url)).arrayBuffer());
      const meta = await sharp(preview).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 480 });
    });

    it('denies everyone else with 404 (non-members, other tenants)', async () => {
      await carol.get(`/api/v1/media/${mediaId}/url`).expect(404);
      await carol.get(`/api/v1/media/${mediaId}`).expect(404);
      await outsider.get(`/api/v1/media/${mediaId}/url`).expect(404);
      const anonymous = await fetch(
        `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/media/${businessId}/${mediaId}`,
      );
      expect(anonymous.status).toBe(403);
    });

    it('removed members lose access; deleting the message revokes it for everyone', async () => {
      await manager.delete(`/api/v1/conversations/${groupId}/members/${ids.bob}`).expect(204);
      await bob.get(`/api/v1/media/${mediaId}/url`).expect(404);
      await manager
        .post(`/api/v1/conversations/${groupId}/members`)
        .send({ userIds: [ids.bob] })
        .expect(201);
      // Re-added members only see new history, so the old attachment stays hidden.
      await bob.get(`/api/v1/media/${mediaId}/url`).expect(404);
      await manager.get(`/api/v1/media/${mediaId}/url`).expect(200);
      await alice.delete(`/api/v1/messages/${message.id}`).expect(200);
      await manager.get(`/api/v1/media/${mediaId}/url`).expect(404);
    });

    it('cannot be attached by someone else or in another conversation', async () => {
      const fresh = await upload(alice, groupId, png, 'again.png', 'image/png');
      await waitForStatus(alice, fresh);
      await sendWithMedia(bob, groupId, fresh).expect(400);
      const dm = await alice
        .post('/api/v1/conversations/direct')
        .send({ businessId, userId: ids.bob })
        .expect(201);
      await sendWithMedia(alice, dm.body.id, fresh).expect(400);
      await sendWithMedia(alice, groupId, fresh).expect(201);
    });
  });

  describe('large files', () => {
    it('uses multipart uploads, supports resuming, and forwards without re-uploading', async () => {
      const header = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from('ftypisom\0\0\x02\0isomiso2', 'latin1'),
      ]);
      const video = Buffer.concat([header, Buffer.alloc(20 * MB - header.length, 7)]);
      const res = await startUpload(
        alice,
        groupId,
        'walkthrough.mp4',
        'video/mp4',
        video.length,
      ).expect(201);
      const session = res.body as UploadSessionDto;
      expect(session.upload.method).toBe('MULTIPART');
      if (session.upload.method !== 'MULTIPART') return;
      expect(session.upload.partCount).toBe(2);

      // Upload part 1, then "lose the connection" and resume with fresh URLs.
      const first = session.upload.parts[0]!;
      expect(
        (await fetch(first.url, { method: 'PUT', body: video.subarray(0, first.sizeBytes) }))
          .status,
      ).toBe(200);
      await alice.post(`/api/v1/media/uploads/${session.media.id}/complete`).expect(400); // part 2 missing
      const resume = await alice
        .post(`/api/v1/media/uploads/${session.media.id}/parts`)
        .send({})
        .expect(200);
      expect(resume.body.uploadedPartNumbers).toEqual([1]);
      expect(resume.body.parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([2]);
      const second = resume.body.parts[0];
      const tooShort = await fetch(second.url, {
        method: 'PUT',
        body: video.subarray(first.sizeBytes, first.sizeBytes + 10),
      });
      expect(tooShort.status).toBe(403); // size is part of the signature
      expect(
        (await fetch(second.url, { method: 'PUT', body: video.subarray(first.sizeBytes) })).status,
      ).toBe(200);
      await alice.post(`/api/v1/media/uploads/${session.media.id}/complete`).expect(202);
      const media = await waitForStatus(alice, session.media.id, 60_000);
      expect(media).toMatchObject({ status: 'READY', kind: 'VIDEO', sizeBytes: video.length });

      const sent = await sendWithMedia(alice, groupId, session.media.id).expect(201);
      const dm = await alice
        .post('/api/v1/conversations/direct')
        .send({ businessId, userId: ids.manager })
        .expect(201);
      const forwarded = await alice
        .post(`/api/v1/messages/${sent.body.id}/forward`)
        .send({ targets: [{ conversationId: dm.body.id, clientMessageId: uuid() }] })
        .expect(201);
      expect(forwarded.body[0]).toMatchObject({
        kind: 'VIDEO',
        forwarded: true,
        attachment: { mediaId: session.media.id },
      });
      await manager.get(`/api/v1/media/${session.media.id}/url`).expect(200);
    });
  });

  describe('verification', () => {
    it('quarantines malware and audits it', async () => {
      const mediaId = await upload(alice, groupId, EICAR, 'notes.txt', 'text/plain');
      const media = await waitForStatus(alice, mediaId);
      expect(media.status).toBe('QUARANTINED');
      expect(media.failureReason).toMatch(/harmful/);
      await sendWithMedia(alice, groupId, mediaId).expect(409);
      const audit = await h.prisma.auditLog.findFirst({
        where: { action: 'media.quarantined', targetId: mediaId },
      });
      expect(JSON.stringify(audit?.metadata)).toMatch(/Eicar/i);
      const row = await h.prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
      expect(row.objectKey).toBeNull();
    });

    it('rejects files whose content does not match the declared type', async () => {
      const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
      const mediaId = await upload(alice, groupId, pdf, 'holiday.png', 'image/png');
      const media = await waitForStatus(alice, mediaId);
      expect(media).toMatchObject({ status: 'REJECTED' });
      expect(media.failureReason).toMatch(/do not match/);
    });

    it('rejects corrupt images that pass the signature check', async () => {
      const fake = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(2000, 1),
      ]);
      const mediaId = await upload(alice, groupId, fake, 'broken.png', 'image/png');
      expect((await waitForStatus(alice, mediaId)).status).toBe('REJECTED');
    });
  });

  describe('policy', () => {
    it('enforces type and size limits before issuing upload URLs', async () => {
      await startUpload(alice, groupId, 'page.html', 'text/html', 100).expect(400);
      await startUpload(alice, groupId, 'vector.svg', 'image/svg+xml', 100).expect(400);
      const tooBig = await startUpload(alice, groupId, 'huge.mp4', 'video/mp4', 300 * MB).expect(
        400,
      );
      expect(tooBig.body.error.message).toMatch(/200 MB/);
    });

    it('requires membership and respects the group file-sharing policy', async () => {
      await startUpload(carol, groupId, 'a.png', 'image/png', 10).expect(404);
      await manager
        .patch(`/api/v1/conversations/${groupId}`)
        .send({ fileSharingPolicy: 'ADMINS_ONLY' })
        .expect(200);
      await startUpload(alice, groupId, 'a.png', 'image/png', 10).expect(403);
      await startUpload(manager, groupId, 'a.png', 'image/png', 10).expect(201);
      await manager
        .patch(`/api/v1/conversations/${groupId}`)
        .send({ fileSharingPolicy: 'DISABLED' })
        .expect(200);
      await startUpload(manager, groupId, 'a.png', 'image/png', 10).expect(403);
      await manager
        .patch(`/api/v1/conversations/${groupId}`)
        .send({ fileSharingPolicy: 'ALL_MEMBERS' })
        .expect(200);
    });

    it('enforces the business storage quota', async () => {
      await h.prisma.tenantQuota.update({
        where: { businessId },
        data: { maxStorageBytes: 100n * BigInt(MB) },
      });
      const res = await startUpload(alice, groupId, 'big.pdf', 'application/pdf', 99 * MB).expect(
        409,
      );
      expect(res.body.error.message).toMatch(/storage/);
      await h.prisma.tenantQuota.update({
        where: { businessId },
        data: { maxStorageBytes: 100n * 1024n * BigInt(MB) },
      });
    });

    it('cleans up abandoned uploads', async () => {
      const res = await startUpload(
        alice,
        groupId,
        'abandoned.pdf',
        'application/pdf',
        1000,
      ).expect(201);
      await alice.post(`/api/v1/media/uploads/${res.body.media.id}/complete`).expect(400); // nothing uploaded
      await h.prisma.mediaAsset.update({
        where: { id: res.body.media.id },
        data: { uploadExpiresAt: new Date(Date.now() - 1000) },
      });
      await h.worker!.get(MediaProcessor).sweepExpiredUploads();
      const media = await alice.get(`/api/v1/media/${res.body.media.id}`).expect(200);
      expect(media.body).toMatchObject({ status: 'FAILED' });
    });

    it('never pushes media events to other users', async () => {
      const bobSocket = await h.socket(bob);
      const leaked = collectEvents(bobSocket, 'media.status_changed', 4_000);
      const png = await sharp({
        create: { width: 10, height: 10, channels: 3, background: '#000' },
      })
        .png()
        .toBuffer();
      const id = await upload(alice, groupId, png, 'tiny.png', 'image/png');
      await waitForStatus(alice, id);
      expect(await leaked).toHaveLength(0);
    });
  });
});
