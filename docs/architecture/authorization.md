# Multi-Tenant Authorization Model

Authorization is **server-side, deny-by-default**, and combines three checks on every
sensitive operation:

1. **Identity & session** — valid access token, session not revoked, user `ACTIVE`,
   privileged permissions require an MFA-verified session.
2. **Permission at scope** — the user holds a role granting the permission at a scope
   that *covers* the target resource.
3. **Resource rule** — resource-specific invariants (e.g. sender is an active member of
   the conversation, target user belongs to the same business, emergency contact is
   for a store the caller is a member of).

The tenant (`businessId`, `storeId`) of a resource is always **loaded from the
database**; IDs in the request body/path only identify *which* resource, never *whose*.

## Scopes

```
PLATFORM                      covers everything (Super Admin)
BUSINESS(businessId)          covers the business and all its stores
STORE(businessId, storeId)    covers only that store
```

A `RoleAssignment` grants a role's permissions at exactly one scope. Coverage rule
(implemented in `packages/shared/src/authorization/evaluate.ts`, unit tested):

| Assignment scope | Resource `{businessId, storeId?}` covered when |
| --- | --- |
| PLATFORM | always |
| BUSINESS(b) | `resource.businessId == b` **and** business is not suspended |
| STORE(b, s) | `resource.businessId == b` **and** `resource.storeId == s` |

Store-scoped roles never cover business-level resources (`storeId` absent) and never
cover sibling stores. A user who belongs to several stores gets one assignment per
store; nothing is inherited from "same business".

Privileged permissions (marked `privileged: true` in the catalog — e.g.
`business.create`, `role.assign`, `audit.read`, `user.contact.read`) additionally
require `session.mfaVerifiedAt != null`. If MFA is not yet enrolled, the API returns
`403 MFA_REQUIRED` and the client routes the user to enrolment.

## Permission catalog (excerpt — full list in `packages/shared/src/authorization/permissions.ts`)

`business.create|read|update|suspend|archive` ·
`store.create|read|update|archive` · `department.manage` ·
`user.create|read|update|deactivate` · `user.contact.read` · `session.revoke` ·
`role.read|manage|assign` · `group.create|manage` · `conversation.direct.create` ·
`message.send|delete` · `bulk_message.send` · `emergency.trigger` ·
`emergency_contact.manage|access` · `incident.read|acknowledge` · `media.upload|download` ·
`audit.read` · `report.export` · `platform.config` · `platform.health.read`

## Role-permission matrix (system roles)

✅ = granted at the role's scope · — = not granted · *(own)* = only for resources the
user participates in (enforced by resource rules, not by the role).

| Permission | Super Admin (PLATFORM) | Business Admin (BUSINESS) | Store Manager (STORE) | Security (STORE) | Employee (STORE) | Customer (BUSINESS, external) |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| business.create / suspend / archive | ✅ | — | — | — | — | — |
| business.read | ✅ | ✅ | — | — | — | — |
| business.update | ✅ | ✅ | — | — | — | — |
| store.create / update / archive | ✅ | ✅ | — | — | — | — |
| store.read | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| user.create / update / deactivate | ✅ | ✅ | — | — | — | — |
| user.read (directory) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| user.contact.read 🔒 | ✅ | ✅ | — | — | — | — |
| session.revoke | ✅ | ✅ | — | — | — | — |
| role.read | ✅ | ✅ | ✅ | — | — | — |
| role.manage / role.assign 🔒 | ✅ | ✅ | — | — | — | — |
| group.create | ✅ | ✅ | ✅ | — | — | — |
| group.manage (any group in scope) | ✅ | ✅ | ✅ | — | — | — |
| conversation.direct.create | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| message.send | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ *(own)* |
| message.delete (moderation) | ✅ | ✅ | ✅ | — | — | — |
| bulk_message.send 🔒 | ✅ | ✅ | — | — | — | — |
| emergency.trigger | — | ✅ | ✅ | ✅ | ✅ | — |
| emergency_contact.manage | ✅ | ✅ | — | — | — | — |
| incident.read / acknowledge | ✅ | ✅ | ✅ | ✅ | — | — |
| media.upload / download | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ *(own)* |
| audit.read 🔒 | ✅ | ✅ | — | — | — | — |
| report.export 🔒 | ✅ | ✅ | — | — | — | — |
| platform.config / platform.health.read 🔒 | ✅ | — | — | — | — | — |

🔒 privileged — MFA-verified session required.

Notes:

- **Super Admin has no implicit message access.** Reading conversation content requires
  membership like anyone else. Platform-level access to content (legal requests) is a
  separate, audited break-glass workflow (decision D6), not a role permission.
- **Security role** gets incidents and the groups it is added to — not employee DMs.
- **Customers** are `User.kind = EXTERNAL`. They are excluded from the internal directory,
  internal groups, and emergency contacts at the resource-rule level regardless of the
  roles they hold; a custom role cannot grant an external user `user.read`.

## Resource rules (examples)

| Operation | Rule |
| --- | --- |
| Send / read messages | caller is an **active** `ConversationMember`; message `seq >= historyFromSeq`; conversation's business not suspended; group posting policy allows the caller. |
| Create DM with user X | both are INTERNAL, active members of the same business, and share at least one store — or caller has `user.read` at BUSINESS scope. |
| Add member to group | caller has `group.manage` covering the group's scope **or** is a group admin; the new member is an active member of the group's business (and store, for store-scoped groups); external users only into `allowExternal` groups. |
| View user | target shares a business with caller and caller has `user.read` covering one of the target's stores (or business). Private contact fields additionally need `user.contact.read`. |
| Emergency help | resolved from the caller's **own** store membership, never from a client-supplied contact ID. |

## Enforcement points

- `AuthGuard` (global): validates JWT, loads session + user status (deny if revoked,
  suspended, deactivated).
- `@RequirePermission(perm, resolver)` + `PermissionGuard`: resolver loads the target's
  `{businessId, storeId}` from the DB, evaluator checks coverage and MFA.
- Services re-check resource rules inside the same transaction that mutates data
  (prevents TOCTOU between guard and write).
- Socket.IO: handshake middleware authenticates; every client event re-validates
  membership server-side; clients never choose rooms.
- Every denial is logged (`authz.denied` metric + audit row for privileged attempts).
