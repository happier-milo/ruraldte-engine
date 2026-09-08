#!/usr/bin/env bash
# Cada commit del PR tiene que traer `Signed-off-by:` (DCO 1.1). Ver CONTRIBUTING.md.
set -euo pipefail
BASE="${1:?falta el sha base}"; HEAD="${2:?falta el sha head}"

faltan=0
while read -r sha; do
  [ -z "$sha" ] && continue
  if ! git log -1 --format='%B' "$sha" | grep -qiE '^Signed-off-by: .+ <.+@.+>'; then
    echo "✗ $(git log -1 --format='%h %s' "$sha")"
    faltan=$((faltan + 1))
  fi
done < <(git rev-list --no-merges "$BASE..$HEAD")

if [ "$faltan" -gt 0 ]; then
  cat >&2 <<'MSG'

Faltan firmas DCO. Al firmar declaras que tienes derecho a aportar ese código
bajo Apache-2.0 (https://developercertificate.org).

  git commit --amend -s          # el último commit
  git rebase --signoff HEAD~N    # los últimos N
  git push --force-with-lease

MSG
  exit 1
fi
echo "✓ DCO: todos los commits firmados"
