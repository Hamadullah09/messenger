# ADR-0007: Encryption scope — transport and at rest, not end-to-end

Status: Accepted (2026-10-10)

## Definitions
- **In transit:** TLS 1.2+ between clients, proxy, and services.
- **At rest:** managed-disk encryption for PostgreSQL, Redis persistence, backups, and
  server-side encryption for object storage. Application-level AES-256-GCM for MFA
  secrets (key from `DATA_ENCRYPTION_KEY`).
- **End-to-end:** only sender/recipient devices hold keys; the server cannot read content.

## Decision
Storeline does **not** provide end-to-end encryption and must not claim to. Business
requirements (admin moderation, retention, legal hold, server-side search, emergency
escalation to new recipients) conflict with E2EE. A future E2EE mode would require an
established protocol (Signal/MLS), per-device identity keys, multi-device sync, key
recovery, encrypted attachments, and independent review — it will not be invented here.
