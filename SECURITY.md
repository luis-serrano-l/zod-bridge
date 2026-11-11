# Security Policy

## Supported versions

Only the latest 0.x release receives security fixes.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's Security tab and choose
"Report a vulnerability", or go directly to
https://github.com/luis-serrano-l/zod-bridge/security/advisories/new

Please do not open public issues for security problems.

## Scope notes

- The Zod uniqueness check is best-effort. It is never a substitute for a database unique
  constraint. Two concurrent requests can both pass the check; keep the constraint and use
  `handlePrismaError` to translate the resulting error.
- Take the record id used for update exclusion from the route or session, not from the request
  body. Otherwise a caller can exclude a record they do not own from the check.
- The check answers "taken / free". Rate-limit any endpoint that exposes it, to avoid account
  enumeration.
