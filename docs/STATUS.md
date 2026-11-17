# Pilot release gate

**Pilot engineering gate verified.** Features remain frozen; this is not a deployment or real-provider-connectivity claim.

## Done

- Production-default admin/worker allowlist; closed routes return 404. Voice code remains unchanged. Separate static public artifact: six pages / eighteen files, preserved notices and [FILL] details.
- Strict isolation across 88 application tables and all 238 allowlisted API-method combinations. Configured-tenant dashboard guards and verified-operator tenant/calendar CLI tested.
- Patched Next 16.4.1 / DOMPurify 3.4.17; build, types/lint, production audit (high 0 / critical 0), strict Semgrep and complete-history Gitleaks passed. Lower-severity/development triage: DEV_ADVISORIES.md.
- Actual [hosted CI](https://github.com/joaopramalho/kyra/actions/runs/39903817220) passed all five jobs at `bcab842`. Downloaded artifact independently verified **2,274 passed / zero failed / zero skipped**, including all 143 acceptance cases and exact coverage of all 46 original acceptance sources. Local production HTTP checks passed 2,417 probes; the hosted runner also completed its production HTTP test.
- Three patched production images built; isolated PostgreSQL/storage recovery passed exact 88-table equality, preserved migration journal, three RLS checks, private storage, tampered-backup rejection and cleanup. Production profile/template/checklist: PILOT_STAGING.md.

## Your manual steps

- Supply approved business/entity/contact/physical-address/legal [FILL] details; public pages remain noindex.
- Configure DNS and real Resend in/out/webhook credentials, Google OAuth consent/calendar and LLM model/key through PILOT_STAGING.md.
- Choose/configure the production host and separately deploy the static artifact and app/worker profile; verify HTTPS/host headers and real provider connectivity before serving customers. Keep operator secrets and backups private.
