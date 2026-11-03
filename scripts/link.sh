#!/bin/sh
# Links this plugin into a Vencord source checkout (default ~/dev/Vencord) for development:
#   <vencord>/src/userplugins/mcp.desktop -> ./plugin   Vencord builds the plugin from here.
#   ./plugin/tsconfig.json (git-ignored)                 Vencord's esbuild follows the link to ./plugin and
#                                                        reads the nearest tsconfig, so this one hands it
#                                                        Vencord's import aliases. Editors read it too.
# A plain copy of plugin/ into src/userplugins needs neither: it sits under Vencord's own tsconfig.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
vencord=$(cd "${1:-$HOME/dev/Vencord}" && pwd)

if [ ! -f "$vencord/scripts/build/build.mjs" ]; then
    echo "$vencord is not a Vencord source checkout (it has no scripts/build/build.mjs); pass the checkout's path" >&2
    exit 1
fi

mkdir -p "$vencord/src/userplugins"
ln -sfn "$here/plugin" "$vencord/src/userplugins/mcp.desktop"
cat > "$here/plugin/tsconfig.json" <<EOF
{
    // Written by scripts/link.sh for the checkout at $vencord; git-ignored.
    "extends": "$vencord/tsconfig.json",
    "include": ["."]
}
EOF
echo "Linked. Build Vencord with: cd \"$vencord\" && pnpm build"
