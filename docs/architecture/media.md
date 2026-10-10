# Secure Media Upload and Download (phase 4 — implemented)

Media bytes never pass through WebSockets and never buffer in API memory. Browsers upload
directly to a **private** S3-compatible bucket (AWS S3 / Cloudflare R2 in production,
SeaweedFS locally) using presigned, size-bound URLs. Files only become downloadable after
the worker has verified and scanned them. See ADR-0008 for the storage layout decisions.

## Storage layout

| Prefix | Contents | Download URLs issued? |
| --- | --- | --- |
| `incoming/<businessId>/<mediaId>` | Unverified bytes as uploaded | **Never** |
| `media/<businessId>/<mediaId>` | Verified, clean file | Yes, after re-checking access |
| `media/<businessId>/<mediaId>.thumb.webp` | 480 px preview (EXIF stripped) | Yes |
| `quarantine/<businessId>/<mediaId>` | Files flagged by the malware scanner | Never (security review only) |

Keys use a server-generated UUID; file names are display-only and never part of a key.

## Upload sequence

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant API as api
  participant DB as PostgreSQL
  participant S3 as Object storage (private)
  participant W as worker
  participant AV as ClamAV

  C->>API: POST /media/uploads {conversationId, fileName, mimeType, sizeBytes}
  API->>API: member + canPost + group fileSharingPolicy + media.upload + allow-listed type
  API->>API: size ≤ min(business policy for kind, MEDIA_PLATFORM_MAX_MB)
  API->>DB: advisory lock(business) → storage quota check → MediaAsset(PENDING_UPLOAD)
  alt ≤ 16 MiB
    API-->>C: presigned PUT (Content-Length, Content-Type, Content-Disposition signed)
  else larger
    API->>S3: CreateMultipartUpload (type + disposition set server-side)
    API-->>C: presigned part URLs (16 MiB parts, each part length signed)
  end
  C->>S3: PUT bytes / parts (progress, 3 parallel parts, per-part retry)
  opt network drop or URL expiry
    C->>API: POST /media/uploads/:id/parts → uploaded part numbers + fresh URLs for the rest
  end
  C->>API: POST /media/uploads/:id/complete
  API->>S3: ListParts (count + exact sizes) → CompleteMultipartUpload → HeadObject (size)
  API->>DB: status VERIFYING + OutboxEvent(media.uploaded)   [same transaction]
  W->>S3: GET incoming object (streamed once)
  W->>W: SHA-256 · file signature vs declared type · byte count
  W->>AV: INSTREAM (same stream)
  alt malware
    W->>S3: copy → quarantine/, delete incoming
    W->>DB: QUARANTINED + audit media.quarantined
  else wrong type / corrupt / size mismatch
    W->>S3: delete incoming
    W->>DB: REJECTED + audit media.rejected
  else clean
    W->>S3: server-side copy → media/ ; thumbnail (images) ; delete incoming
    W->>DB: READY (sha256, dimensions)
  end
  W-->>C: media.status_changed (uploader only)
  C->>API: POST /conversations/:id/messages {mediaId, body?}
```

A message can reference a media asset only if the sender uploaded it, for that same
conversation, it is `READY`, and the sender may share files there. Forwarding reuses the
verified file (no re-upload); access then follows the new message.

## Download

`GET /media/:id/url?variant=original|thumbnail` re-checks on every call:

1. business active and caller holds `media.download` in it;
2. the asset is `READY`;
3. caller is the uploader and still a member of the conversation, **or** the asset is
   attached to a non-deleted message the caller can read now (active member, message after
   their history boundary).

Everyone else gets 404. URLs live 5 minutes (`MEDIA_DOWNLOAD_URL_TTL_SECONDS`). Downloads in
security and emergency-response conversations are audited (`media.downloaded`).
Documents are served with `Content-Disposition: attachment`; images and videos inline.
Content type and disposition are fixed by the server at upload time (and also forced via
response overrides on providers that support them).

## Controls

| Control | Where |
| --- | --- |
| Allow-list of types (no SVG, HTML, scripts, archives, executables) | `@storeline/shared` `MEDIA_TYPES` |
| Size enforced 4×: policy at session start, signed `Content-Length`, ListParts sizes, `HeadObject` + byte count while scanning | API, storage, worker |
| Content verified by magic bytes, not by name or browser type | `file-signature.ts` (unit tested) |
| Malware scan before availability; scanner errors and oversize streams are **never** treated as clean | `malware-scanner.ts`, ClamAV with `AlertExceedsMax yes` |
| Image decompression-bomb guard (50 MP), EXIF stripped from previews | `media.processor.ts` (sharp ≥ 0.35.5) |
| Storage quota per business, serialised with an advisory lock | `media.service.ts` |
| Abandoned uploads aborted after `MEDIA_UPLOAD_EXPIRY_HOURS` (sweeper every 10 min) | worker; plus bucket lifecycle rule in production |
| Signed URLs and object keys never in message payloads, socket events or logs | DTOs, tests |
| Removed members, deleted messages, other tenants → 404 | integration tests |

## Limits (defaults)

Images 25 MB, videos 200 MB, documents 200 MB (per business policy), platform ceiling
1024 MB, multipart above 16 MiB with 16 MiB parts, upload URLs valid 15 minutes.

## Known limitations

- **Video:** no poster frame or duration (needs ffmpeg in the worker); videos show a play
  card and stream from the signed URL.
- **HEIC photos:** accepted and scanned, but no preview is generated (the bundled image
  library has no HEVC decoder); they are offered as a download.
- **Already-downloaded copies** cannot be revoked.
- **Deleted media bytes** are not purged yet; access is revoked immediately, purge follows
  the retention job (roadmap).
- The client does not hash files before upload; the server computes SHA-256 during the scan.
