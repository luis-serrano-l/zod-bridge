---
name: release-check
description: Pre-publish checklist for zod-bridge. Use when the user asks "is this ready to publish", "ready to release", "can I tag", or similar. Runs every gate and reports a pass/fail table. Never tags, pushes or publishes.
---

# release-check

Run each step in order from the repo root. Record PASS or FAIL for each. Keep going after a
failure so the final table is complete, unless Docker is unavailable (mark the Docker steps FAIL).

## Hard rule

Never run `git tag`, `git push`, or `npm publish`. Report readiness and stop. The user does those.

## Steps

1. **Clean tree**: `git status --porcelain` must print nothing, and `git branch --show-current`
   must be `main`.
2. **Typecheck**: `npm run typecheck`.
3. **Tests**: `npm test` (unit + integration, needs Docker; check `docker info` first).
4. **Build**: `npm run build`. Confirm `dist/` has the entries listed in `package.json` `exports`.
5. **Pack contents**: `npm pack --dry-run`. Expect only `dist/`, `README.md`, `LICENSE`,
   `package.json`. Anything else (src, tests, prisma, examples, .claude) is a FAIL.
6. **Package lint**: `npx publint`. Warnings and errors are FAIL.
7. **Audit**: `npm audit --omit=dev`. Any high or critical finding is FAIL.
8. **Demo** (verifies the packed artifact, not the source):
   `cd examples/demo && docker compose up --build --abort-on-container-exit && docker compose down -v`
   Always run `docker compose down -v` afterwards, even if `up` failed.
9. **Version and changelog**: read `version` in `package.json`. It must equal the intended tag
   without the leading `v` (ask the user for the tag if unknown). `CHANGELOG.md` must have an
   entry for that exact version.
10. **Author**: `package.json` `author` must be non-empty.

## Output

End with this table, one row per step, then one line stating READY or NOT READY and the
blocking items. If ready, tell the user the commands to run themselves (tag, push) without
running them.

| Step | Result | Notes |
|---|---|---|
| Clean tree | PASS/FAIL | |
| Typecheck | PASS/FAIL | |
| Tests | PASS/FAIL | |
| Build | PASS/FAIL | |
| Pack contents | PASS/FAIL | |
| publint | PASS/FAIL | |
| Audit | PASS/FAIL | |
| Demo | PASS/FAIL | |
| Version + CHANGELOG | PASS/FAIL | |
| Author | PASS/FAIL | |
