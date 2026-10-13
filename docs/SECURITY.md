# DeviceLab security model

DeviceLab runs inside a BFSI organisation's network and gives people remote
control of physical phones that hold pre-release banking apps. This document
covers the threat model, data flows, controls, retention, and a checklist
aligned with RBI IT/cyber-security expectations and India's DPDP Act 2023.

> **Ground rule: lab devices hold test data only.** No production customer
> data, real accounts or real KYC documents ever goes on a lab device. UAT
> builds point at UAT back ends.

## 1. Assets

| Asset                                       | Why it matters                                                      |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Pre-release APK/IPA builds                  | Intellectual property; can reveal unreleased features and endpoints |
| Live screens, recordings, screenshots, logs | May show test PII, OTPs, tokens and internal URLs                   |
| Devices (with test SIMs)                    | Can receive OTP SMS; physical theft risk                            |
| User credentials and sessions               | Control of devices and access to builds                             |
| Host agent tokens                           | Let a machine impersonate a device host                             |
| Audit log                                   | Evidence for incident response and audits                           |

## 2. Trust boundaries and data flow

```
Browser ──TLS──▶ Nginx ──▶ Control server ──▶ Postgres / Redis / Object storage
                              ▲
Host agent ──TLS (wss)────────┘          Host agent ──USB──▶ Phones
```

- Browsers and agents reach **only Nginx**. Postgres, Redis and MinIO stay on
  the internal Docker network (the production compose file publishes no ports
  for them).
- Video and input travel browser ⇄ server ⇄ agent over WSS. The server relays
  frames and never stores them. Recordings (Phase 3) are written to object
  storage only when a user starts one.
- **No third-party services.** No CDN fonts, no telemetry and no cloud APIs:
  fonts are bundled and package telemetry (`@scarf/scarf`) is blocked at install.

## 3. Threats and controls

| Threat                                   | Controls                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential stuffing or brute force       | argon2id (19 MiB, t=2); per-IP login rate limit (`AUTH_LOGIN_LIMIT_PER_MIN`, default 10); the same error for unknown email and wrong password, with a dummy hash to equalise timing; failed logins audited                                                                                                                                      |
| Stolen session tokens                    | 15-minute access JWT kept in memory only; the refresh token sits in `sessionStorage` (cleared when the tab closes) and **rotates on every use**; replaying a rotated token revokes the whole family and is audited; deactivating a user or resetting their password revokes all of their tokens                                                 |
| Privilege escalation                     | Server-side RBAC on **every** route: the `@Permissions()` guard is default-deny for routes without a declaration. The role is re-read from the DB on each request, so demotion applies immediately. Socket events re-check access. Users can't change their own role or deactivate themselves                                                   |
| Controlling someone else's device        | Redis lock plus a partial unique index (one ACTIVE reservation per device). Stream tickets are signed with a separate key, live 60 s, and are bound to the session and role. The relay accepts input **only** from the reservation holder (single-writer); observers are read-only                                                              |
| Rogue host agent                         | Per-host random tokens (`dlh_…`, 256-bit) stored as SHA-256 and shown once; rotate or revoke in Admin → Hosts (revoking disconnects the agent at once); unknown or revoked tokens are rejected at the handshake and audited; session events are relayed only from the host that owns the device; iOS reports are accepted only from macOS hosts |
| Malicious or tampered builds             | Uploads must be ZIP archives with an `.apk`/`.ipa` extension (AAB is rejected). A SHA-256 is computed on upload and **re-verified by the agent before install**. Builds are scoped to the uploader's project team. Downloads are audited                                                                                                        |
| Leaking test data from previous sessions | Cleanup on every release uninstalls packages installed in the session, clears the clipboard and returns to Home (optionally reboots). Idle sessions are released automatically (warning at 5 min, release at 10)                                                                                                                                |
| Data exfiltration through artifacts      | Artifacts can be read only by the session owner or by LEAD/ADMIN; every download is audited; files are served `no-store` and `nosniff` with a sanitised filename                                                                                                                                                                                |
| XSS / clickjacking                       | React escaping; a strict CSP (`script-src 'self'`, no inline scripts, `frame-ancestors 'none'`); HSTS, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` (Nginx); Helmet on the API                                                                                                                                                    |
| Injection                                | Zod validation on every body, query and socket payload; Prisma parameterised queries; package ids are validated against `^[a-zA-Z0-9._-]+$` and shell-quoted before any `adb shell`; scrcpy codec options come from a validated allowlist pattern                                                                                               |
| CSV formula injection                    | Audit export prefixes cells starting with `= + - @`                                                                                                                                                                                                                                                                                             |
| Eavesdropping                            | TLS 1.2+ at Nginx; agents use `wss://` with an optional internal CA (`caFile`)                                                                                                                                                                                                                                                                  |
| Weakening production apps                | DeviceLab never bypasses FLAG_SECURE, root/jailbreak detection, SSL pinning or device binding. It tells users to use UAT builds instead                                                                                                                                                                                                         |

## 4. Audit trail

The `AuditLog` table is append-only from the application's point of view. It
records: login, failed login, logout, refresh-token reuse; user, team and
project changes; host create, rotate, revoke, resync and rejected agents;
device edits, reboots and removals; reservation create, extend, release and
force-release (with the reason); session start, observe and end; build upload
and download; app install, uninstall and actions; and artifact create and
download. Each entry carries the actor, entity, metadata and client IP (behind
Nginx, `trust proxy` is limited to loopback and private ranges).

Admins and leads can filter the log and export it as CSV
(`GET /api/audit/export.csv`). Ship the table to your SIEM, for example with a
Postgres logical-replication or CDC connector.

## 5. Retention

| Data                              | Default                                                                                | Where to configure                      |
| --------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| Reservations, sessions, audit log | Kept until a retention job runs (Phase 4: configurable, suggested 1–3 years for audit) | Settings (Phase 4)                      |
| Screenshots, logs, recordings     | Suggested 30 days (Phase 4 retention job)                                              | Settings (Phase 4)                      |
| Builds                            | Suggested: last N per project (Phase 3)                                                | `BUILD_RETENTION_PER_PROJECT` (Phase 3) |
| Refresh tokens                    | 7 days (`REFRESH_TOKEN_TTL_DAYS`)                                                      | env                                     |

Until the Phase 3–4 jobs ship, purge old artifacts with a scheduled S3
lifecycle rule on the bucket's `artifacts/` prefix.

## 6. Operational checklist (RBI IT/cyber-security expectations and DPDP Act)

- [ ] **Test data only.** Written policy that no production customer data
      enters lab devices or builds (DPDP: no processing of real personal data
      without lawful basis or purpose). UAT builds use synthetic data.
- [ ] **Network segmentation.** The lab VLAN reaches only the DeviceLab
      server. Device Wi-Fi is limited to UAT endpoints. No internet from
      devices unless the policy allows it.
- [ ] **TLS everywhere.** Internal-CA certificates on Nginx; agents trust the
      CA (`caFile`); HTTP redirects to HTTPS.
- [ ] **Secrets.** `infra/.env` sits outside version control with strong
      random values (`openssl rand -base64 48`); rotate the JWT secrets
      yearly or on suspicion; rotate host tokens when staff change.
- [ ] **Identity.** Unique named accounts (no sharing); least-privilege roles;
      quarterly access review using Admin → Users and the audit log; OIDC/LDAP
      SSO with MFA (Phase 4).
- [ ] **Logging and monitoring.** Audit log forwarded to the SIEM; alerts on
      `auth.refresh_reuse_detected`, `host.rejected` and bursts of
      `auth.login_failed`.
- [ ] **Patch management.** Monthly updates to base images
      (`node:20-bookworm-slim`, `nginx`, `postgres`, `redis`) and to `pnpm audit` findings.
- [ ] **Backups.** Postgres backups (pg_dump or WAL archiving), with restores tested quarterly.
- [ ] **Physical security.** Device racks in a locked room; device inventory
      reconciled monthly; test SIMs registered to the organisation.
- [ ] **Incident response.** Revoke the host token, force-release its
      reservations, deactivate users, and export the audit log for the window.
- [ ] **Vendor and OSS review.** scrcpy-server (Apache-2.0) is pinned and
      checksum-verified; dependency licences reviewed.

## 7. Reporting

Report vulnerabilities to the internal security team. Do not open public issues.
