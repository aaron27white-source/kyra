#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# This command creates its own project. It never accepts an ambient target or provider credentials.
export DOCKER_CONTEXT=default
if [[ -n "${DOCKER_HOST:-}" ]] || [[ "$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" != unix://* ]]; then
  echo "Restore rehearsal requires the local default Unix Docker daemon." >&2; exit 1
fi
IMAGE_VERSION="${PILOT_REHEARSAL_IMAGE_VERSION:-}"
if [[ -n "$IMAGE_VERSION" && ! "$IMAGE_VERSION" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Invalid reviewed runtime image version." >&2; exit 1
fi
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lmc-restore-XXXXXXXX")"
PROJECT="$(basename "$WORK_DIR" | tr '[:upper:]' '[:lower:]')"
export REPLACEMENT_COMPOSE_PROJECT="$PROJECT" COMPOSE_PROFILES=prod
export REPLACEMENT_COMPOSE_FILE="$ROOT_DIR/docker-compose.pilot.yml"
export REPLACEMENT_ENV_FILE="$WORK_DIR/private.env" REPLACEMENT_DRILL_BACKUP_DIR="$WORK_DIR/drill"
node --input-type=module - "$REPLACEMENT_ENV_FILE" "$PROJECT" "$IMAGE_VERSION" <<'JS'
import {randomBytes} from "node:crypto";
import {writeFileSync} from "node:fs";
const [file,project,reviewedVersion]=process.argv.slice(2);
const version=reviewedVersion||project;
const names=["POSTGRES_PASSWORD",... ["MIGRATOR","AUTH","APP","SYSTEM","WORKER","DISPATCHER","READONLY"].map(role=>`LOBBYSTACK_${role}_PASSWORD`),"BETTER_AUTH_SECRET","INTERNAL_SERVICE_SECRET","INTERNAL_SERVICE_TOKEN","WIDGET_SESSION_SECRET","ENCRYPTION_KEY","OTP_HASH_SECRET","LOCAL_STORAGE_SIGNING_SECRET","LMC_SIGNING_SECRET"];
writeFileSync(file,`SERVICE_VERSION=${version}\nAPP_BASE_URL=https://restore.example.invalid\nLMC_PUBLIC_BASE_URL=https://restore.example.invalid\n`+names.map(name=>`${name}=${randomBytes(32).toString("hex")}\n`).join(""),{mode:0o600,flag:"wx"});
JS
# Remove ambient interpolation overrides without exposing any values.
unset RESEND_API_KEY RESEND_WEBHOOK_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI AI_CHAT_API_KEY AI_CHAT_MODEL LMC_EMAIL_FROM LMC_RECEIVING_DOMAIN
while IFS='=' read -r name ignored; do unset "$name"; done < "$REPLACEMENT_ENV_FILE"
COMPOSE=(docker compose --project-name "$PROJECT" --env-file "$REPLACEMENT_ENV_FILE" -f "$REPLACEMENT_COMPOSE_FILE")
if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]] || [[ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")" ]]; then
  echo "Fresh rehearsal project unexpectedly exists; refusing reuse." >&2; exit 1
fi
cleanup(){ "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
"${COMPOSE[@]}" config --quiet
if [[ -n "$IMAGE_VERSION" ]]; then
  for service in admin worker migrator; do
    revision="$(docker image inspect "lmc-pilot-$service:$IMAGE_VERSION" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
    [[ "$revision" == "$IMAGE_VERSION" ]] || { echo "Reviewed runtime image revision mismatch." >&2; exit 1; }
  done
else
  "${COMPOSE[@]}" build admin worker migrator
fi
"${COMPOSE[@]}" up -d --wait postgres redis
"${COMPOSE[@]}" run --rm migrator
"${COMPOSE[@]}" run --rm migrator node_modules/.bin/tsx dist/cli.js bootstrap
"${COMPOSE[@]}" run --rm migrator node_modules/.bin/tsx dist/cli.js verify-rls
JOURNAL_BEFORE="$("${COMPOSE[@]}" exec -T postgres psql -U postgres -d lobbystack -Atc 'select count(*) from public.__lobbystack_migrations')"
[[ "$JOURNAL_BEFORE" =~ ^[1-9][0-9]*$ ]] || { echo "Migration journal is empty." >&2; exit 1; }
CONFIRM_REPLACEMENT_RESTORE_DRILL=1 bash "$ROOT_DIR/scripts/replacement-restore-drill.sh"
"${COMPOSE[@]}" run --rm migrator node_modules/.bin/tsx dist/cli.js verify-rls
EXPECTED_TABLES="$("${COMPOSE[@]}" run --rm --no-deps migrator node --input-type=module -e 'import * as schema from "./dist/schema/index.js"; import {getTableName,is} from "drizzle-orm"; import {PgTable} from "drizzle-orm/pg-core"; const names=[...new Set(Object.values(schema).filter(value=>is(value,PgTable)).map(getTableName))].sort(); if(names.length!==88)throw new Error("EXPECTED_APPLICATION_TABLES_NOT_88"); console.log(names.join(","));')"
ACTUAL_TABLES="$("${COMPOSE[@]}" exec -T postgres psql -U postgres -d lobbystack -Atc "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relname not in ('__drizzle_migrations','__lobbystack_migrations')" | LC_ALL=C sort | paste -sd, -)"
[[ "$ACTUAL_TABLES" == "$EXPECTED_TABLES" ]] || { echo "Restored application table names differ from the canonical 88-table schema." >&2; exit 1; }
JOURNAL_AFTER="$("${COMPOSE[@]}" exec -T postgres psql -U postgres -d lobbystack -Atc 'select count(*) from public.__lobbystack_migrations')"
[[ "$JOURNAL_AFTER" == "$JOURNAL_BEFORE" ]] || { echo "Migration journal was not preserved." >&2; exit 1; }
cp -R "$WORK_DIR/drill/backup" "$WORK_DIR/tampered"
printf '\ninvalid-checksum\n' >> "$WORK_DIR/tampered/postgres.dump"
if CONFIRM_REPLACEMENT_RESTORE=1 bash "$ROOT_DIR/scripts/replacement-restore.sh" "$WORK_DIR/tampered" > "$WORK_DIR/tamper.log" 2>&1; then
  echo "Tampered backup was accepted." >&2; exit 1
fi
grep -q '^postgres.dump: FAILED$' "$WORK_DIR/tamper.log"
"${COMPOSE[@]}" run --rm migrator node_modules/.bin/tsx dist/cli.js verify-rls
printf '{"restorePostgres":true,"restoreStorage":true,"restoredApplicationTables":88,"canonicalTableNameEquality":true,"migrationJournalPreserved":true,"rlsVerifiedBeforeAndAfter":true,"tamperedBackupRejected":true,"realProviderCalls":false,"applicationConsumersStarted":false,"hostedStaging":false}\n' > "$WORK_DIR/result.json"
echo "Pilot restore rehearsal passed. Restricted evidence retained at: $WORK_DIR/result.json"
