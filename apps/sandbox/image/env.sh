# Sourced by the tool wrappers in /usr/local/bin (pnpm, yarn, npm, npx, wrangler, ...).
#
# The Runner Durable Object execs steps with a minimal environment (PATH, HOME=/root, CI, ...),
# so the image's ENV does not reach them. These are DEFAULTS only: anything the caller set wins.
# Registries are deliberately not set here: npm_config_registry / YARN_NPM_REGISTRY_SERVER /
# COREPACK_NPM_REGISTRY route package downloads through an allowlisting proxy when set.

# A HOME the current user can write (HOME=/root is passed even when we run as `runner`).
if [ -z "${HOME:-}" ] || [ ! -w "$HOME" ]; then
  HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  if [ -z "$HOME" ] || [ ! -w "$HOME" ]; then HOME=/tmp/gittifacts-home; mkdir -p "$HOME"; fi
  export HOME
fi

# Package managers: pre-fetched by corepack, stable store/cache paths (snapshot-friendly).
: "${COREPACK_HOME:=/opt/corepack}"
: "${COREPACK_ENABLE_DOWNLOAD_PROMPT:=0}"
: "${COREPACK_ENABLE_AUTO_PIN:=0}"
: "${COREPACK_ENABLE_STRICT:=0}"
: "${pnpm_config_store_dir:=/opt/pnpm-store}"
: "${npm_config_store_dir:=/opt/pnpm-store}"
: "${npm_config_cache:=/opt/npm-cache}"
: "${YARN_CACHE_FOLDER:=/opt/yarn-cache}"
export COREPACK_HOME COREPACK_ENABLE_DOWNLOAD_PROMPT COREPACK_ENABLE_AUTO_PIN COREPACK_ENABLE_STRICT
export pnpm_config_store_dir npm_config_store_dir npm_config_cache YARN_CACHE_FOLDER

# No phoning home: update checks, funding/audit calls, telemetry.
: "${npm_config_update_notifier:=false}"
: "${pnpm_config_update_notifier:=false}"
: "${npm_config_fund:=false}"
: "${npm_config_audit:=false}"
: "${WRANGLER_SEND_METRICS:=false}"
: "${NO_UPDATE_NOTIFIER:=1}"
: "${DO_NOT_TRACK:=1}"
: "${NEXT_TELEMETRY_DISABLED:=1}"
: "${ASTRO_TELEMETRY_DISABLED:=1}"
export npm_config_update_notifier pnpm_config_update_notifier npm_config_fund npm_config_audit
export WRANGLER_SEND_METRICS NO_UPDATE_NOTIFIER DO_NOT_TRACK NEXT_TELEMETRY_DISABLED ASTRO_TELEMETRY_DISABLED
