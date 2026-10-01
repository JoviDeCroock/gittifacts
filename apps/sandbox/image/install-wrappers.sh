#!/bin/sh
# Replace /usr/local/bin entry points with wrappers that source /opt/gittifacts/env.sh first.
# Usage: install-wrappers.sh name=target-js [name=target-js ...]   (target run with node)
#        install-wrappers.sh name=@/abs/executable                  (target exec'd directly)
set -eu
for spec in "$@"; do
  name="${spec%%=*}"
  target="${spec#*=}"
  case "$target" in
    @*) run="exec ${target#@} \"\$@\"" ;;
    *) run="exec /usr/local/bin/node $target \"\$@\"" ;;
  esac
  rm -f "/usr/local/bin/$name"
  printf '#!/bin/sh\n. /opt/gittifacts/env.sh\n%s\n' "$run" > "/usr/local/bin/$name"
  chmod 0755 "/usr/local/bin/$name"
done
