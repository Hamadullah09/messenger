# ADR-0006: Private contact data lives in a separate table

Status: Accepted (2026-10-10)

## Decision
Email and phone numbers are stored in `UserContact`, never on `User`. All user DTOs are
built from an explicit `publicUserSelect`. Only the worker (out-of-band notification) and
the audited `user.contact.read` endpoint join `UserContact`.

## Consequences
+ Leaking contact data requires deliberately joining a second table; a forgotten
  `select` cannot expose it. + Enables application-level encryption of this table later.
− One extra join for admin screens that legitimately show contact details.
