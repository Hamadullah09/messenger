# ADR-0008: Media storage layout and verification

Status: Accepted (2026-10-10)

## Context
Files up to 200 MB (videos/documents) must be shared without passing through the API,
without exposing unverified content, and on several S3-compatible providers. Local
SeaweedFS ignores per-request response-header overrides and metadata replacement on copy.

## Decision
1. **Direct upload** to an `incoming/` prefix with presigned URLs whose length (and, for
   single PUTs, `Content-Type` and `Content-Disposition`) are part of the signature.
   Multipart above 16 MiB; part sizes are signed and re-checked with `ListParts`.
2. **Server decides headers** at upload time: content type = declared allow-listed type,
   disposition = `attachment` for documents. The worker rejects files whose bytes do not
   match the declared type, so stored headers are trustworthy. Response overrides are also
   sent when signing downloads for providers that honour them (S3, R2).
3. **Verify, then promote**: one streaming pass computes SHA-256, checks the file
   signature and feeds ClamAV (`INSTREAM`). Clean files are copied server-side to `media/`;
   malware goes to `quarantine/`; anything else is deleted. Download URLs are only ever
   signed for `media/` keys.
4. **Fail closed**: scanner unavailability, timeouts or "size limit exceeded" replies are
   errors (the job retries, then the asset becomes `FAILED`), never a clean result.
   Production refuses to start unless `MALWARE_SCANNER=clamav`.
5. **Own allow-list signature checks** instead of a generic detection library: the set of
   accepted formats is small, the checks are unit tested, and it avoids an ESM-only
   dependency in the CommonJS API build.

## Consequences
+ Unverified or malicious bytes are never downloadable by other users.
+ The API process never holds file contents; the worker streams them.
− Every file is read once by the worker (cost proportional to upload volume).
− A server-side copy doubles storage briefly until the incoming object is deleted.
