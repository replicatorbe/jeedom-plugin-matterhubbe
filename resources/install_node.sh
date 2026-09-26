#!/bin/bash
# Lancé en root par Jeedom avant l'installation des dépendances du plugin
# (packages.json → pre-install).
#
# Le démon a besoin d'un Node.js récent (matter.js : 20.19 au moins, 22.13 ou
# plus de préférence). Le script Node du cœur de Jeedom dépend de la version
# du cœur et échoue sans gpg ; on installe donc nous-mêmes Node.js 22 depuis
# NodeSource, clé comprise, s'il est absent ou trop ancien. En cas d'échec, on
# ne laisse jamais de dépôt sans clé (il casserait tous les « apt update » de
# la machine) et on laisse le cœur tenter sa propre installation : rien ici
# n'est bloquant.

NODE_MAJOR=22
NODE_MIN=22.13.0
KEYRING=/etc/apt/keyrings/nodesource.gpg
SOURCE=/etc/apt/sources.list.d/nodesource.list

echo "== matterhubbe : contrôle de Node.js"
current=$(node -v 2>/dev/null | sed 's/^v//')
if [ -n "$current" ] && [ "$(printf '%s\n%s\n' "$NODE_MIN" "$current" | sort -V | head -n1)" = "$NODE_MIN" ]; then
    echo "Node.js v$current déjà installé : rien à faire"
    exit 0
fi

# NodeSource ne fournit pas Node.js 22 pour ARMv6 (Raspberry Pi Zero et Pi 1).
if [ "$(uname -m)" = "armv6l" ]; then
    echo "Processeur ARMv6 : Node.js $NODE_MAJOR n'existe pas pour cette machine, le plugin ne peut pas y fonctionner."
    exit 0
fi

echo "Node.js ${current:-absent} : installation de Node.js $NODE_MAJOR depuis NodeSource"
export DEBIAN_FRONTEND=noninteractive

# Un dépôt NodeSource sans clé valide (reste d'un essai raté) ferait échouer l'apt-get update.
if [ -f "$SOURCE" ] && [ ! -s "$KEYRING" ]; then
    rm -f "$SOURCE"
fi
# Une installation interrompue bloquerait tout apt-get.
dpkg --configure -a
apt-get update
apt-get install -y ca-certificates curl gnupg

mkdir -p /etc/apt/keyrings
tmp=$(mktemp)
if curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$tmp" \
    && gpg --dearmor --yes -o "$KEYRING.new" "$tmp" && [ -s "$KEYRING.new" ]; then
    mv -f "$KEYRING.new" "$KEYRING"
    chmod 644 "$KEYRING"
    echo "deb [signed-by=$KEYRING] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" > "$SOURCE"
    # NodeSource prioritaire sur le nodejs de Debian, plus ancien.
    printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodesource
    apt-get update
    # Le nodejs de NodeSource fournit son npm et remplace de lui-même celui de Debian.
    if apt-get install -y nodejs; then
        echo "Node.js $(node -v) installé"
    else
        echo "Installation de Node.js $NODE_MAJOR impossible : le cœur de Jeedom va tenter la sienne"
        apt-get install -f -y
    fi
else
    echo "Clé NodeSource impossible à récupérer (pas d'accès à internet ?) : le cœur de Jeedom va tenter sa propre installation"
    rm -f "$KEYRING.new"
    [ -s "$KEYRING" ] || rm -f "$SOURCE" "$KEYRING"
fi
rm -f "$tmp"
exit 0
