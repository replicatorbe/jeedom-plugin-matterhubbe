#!/bin/bash
# Lancé en root par Jeedom avant l'installation des dépendances du plugin
# (packages.json → pre-install).
#
# Le démon a besoin de Node.js récent (matter.js : 20.19 au moins, 22 de
# préférence). Le script Node du cœur de Jeedom dépend de la version du cœur et
# échoue sans gpg ; on installe donc nous-mêmes Node.js 22 depuis NodeSource,
# clé comprise, s'il est absent ou plus ancien. En cas d'échec, on remet apt en
# état et on laisse le cœur tenter sa propre installation : rien ici n'est
# bloquant.

NODE_MAJOR=22
KEYRING=/etc/apt/keyrings/nodesource.gpg
SOURCE=/etc/apt/sources.list.d/nodesource.list

echo "== matterhubbe : contrôle de Node.js"
current=$(node -v 2>/dev/null | sed 's/^v//')
major=${current%%.*}
if [ -n "$current" ] && [ "$major" -ge "$NODE_MAJOR" ] 2>/dev/null; then
    echo "Node.js v$current déjà installé : rien à faire"
    exit 0
fi
echo "Node.js ${current:-absent} : installation de Node.js $NODE_MAJOR depuis NodeSource"

export DEBIAN_FRONTEND=noninteractive
apt-get install -y ca-certificates curl gnupg

mkdir -p /etc/apt/keyrings
tmp=$(mktemp)
if curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$tmp" \
    && gpg --dearmor --yes -o "$KEYRING" "$tmp" && [ -s "$KEYRING" ]; then
    chmod 644 "$KEYRING"
    echo "deb [signed-by=$KEYRING] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" > "$SOURCE"
    # NodeSource prioritaire sur le nodejs de Debian, plus ancien.
    printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodesource
    apt-get update
    # Le npm de Debian est incompatible avec le nodejs de NodeSource, qui fournit le sien.
    if dpkg -s npm >/dev/null 2>&1; then
        apt-get remove -y npm
    fi
    if apt-get install -y nodejs; then
        echo "Node.js $(node -v) installé"
    else
        echo "Installation de Node.js $NODE_MAJOR impossible : le cœur de Jeedom va tenter la sienne"
    fi
else
    echo "Clé NodeSource impossible à récupérer : le cœur de Jeedom va tenter sa propre installation"
    # Pas de dépôt sans clé : il ferait échouer tous les « apt update » de la machine.
    [ -s "$KEYRING" ] || rm -f "$SOURCE" "$KEYRING"
fi
rm -f "$tmp"
exit 0
