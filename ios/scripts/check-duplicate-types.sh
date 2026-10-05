#!/usr/bin/env bash
# One owner per name: fails when two M5Kit modules declare the same top-level
# public type (struct, enum, class, actor, protocol, typealias) — any file that
# imports both would get "ambiguous" errors. M5CoreTests' ModuleNamesTests runs
# the same check under `swift test`; this is the CI form (no Swift needed).
#
#   ios/scripts/check-duplicate-types.sh          the M5Kit modules (ios/M5Kit/Sources/<module>)
#   ios/scripts/check-duplicate-types.sh --app    also the apps' own types (M5cet, M5cetWatch,
#                                                 M5cetNotifications) named like an M5Kit public type
#                                                 (a test target that imports both sees two); an
#                                                 alias of the same type (`typealias X = Module.X`) is fine
#
# Exit 0 when every name has one owner, 1 otherwise (each clash is listed).

set -euo pipefail
cd "$(dirname "$0")/.."

attrs='^(@[[:alnum:]_.]+(\([^)]*\))?[[:space:]]+)*'
kinds='(struct|enum|class|actor|protocol|typealias)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*'
public_decl="${attrs}(public|open)[[:space:]]+((final|indirect|nonisolated)[[:space:]]+)*${kinds}"

# "<name> <module> <file>" for every top-level public type of M5Kit.
kit_types() {
    grep -rEo --include='*.swift' "$public_decl" M5Kit/Sources |
        awk -F: '{ split($1, p, "/"); n = split($2, w, /[[:space:]]+/); print w[n], p[3], $1 }' | sort -u
}

status=0
clashes=$(kit_types | awk '
    { if (!seen[$1 SUBSEP $2]++) { mods[$1] = mods[$1] " " $2; count[$1]++ } files[$1] = files[$1] "\n    " $3 }
    END { for (k in count) if (count[k] > 1) printf "%s is declared in%s:%s\n", k, mods[k], files[k] }')
if [ -n "$clashes" ]; then
    echo "Two M5Kit modules declare the same public type:" >&2
    echo "$clashes" >&2
    status=1
fi

if [ "${1:-}" = "--app" ]; then
    app_decl="${attrs}((public|internal|final|indirect|nonisolated)[[:space:]]+)*${kinds}"
    names=$(kit_types | awk '{ print $1 }' | sort -u)
    app=$( { grep -rEn --include='*.swift' "$app_decl.*" M5cet M5cetWatch M5cetNotifications 2>/dev/null || true; } |
        NAMES="$names" awk '
            BEGIN { n = split(ENVIRON["NAMES"], a, "\n"); for (i = 1; i <= n; i++) kit[a[i]] = 1 }
            {
                file = $0; sub(/:.*/, "", file)
                line = $0; sub(/^[^:]*:[0-9]+:/, "", line)
                decl = line; sub(/[[:space:]]*[:=<{(].*/, "", decl)
                k = split(decl, w, /[[:space:]]+/); name = w[k]
                if (!(name in kit)) next
                # typealias X = Module.X — the same type, not a second one
                if (line ~ "typealias[[:space:]]+" name "[[:space:]]*=[[:space:]]*[A-Za-z0-9_]+\\." name "[[:space:]]*$") next
                printf "%s (%s) is also an M5Kit public type\n", name, file
            }')
    if [ -n "$app" ]; then
        echo "App types named like an M5Kit public type:" >&2
        echo "$app" >&2
        status=1
    fi
fi

if [ "$status" -eq 0 ]; then echo "check-duplicate-types: every public type name has one owner"; fi
exit "$status"
