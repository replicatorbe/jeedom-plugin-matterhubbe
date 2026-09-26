# Matter Hub pour Jeedom

Plugin Jeedom qui expose des équipements Jeedom à **Google Home** par
**Matter**, entièrement en local, sans cloud ni abonnement.

Le plugin crée un pont Matter (Aggregator) que l'application Google Home
appaire avec un QR code. Les lumières, prises, capteurs d'ouverture, de
présence, de température et d'humidité y apparaissent d'après leurs types
génériques Jeedom, et se pilotent à la voix ou depuis l'application.

Documentation : [docs/fr_FR/index.md](docs/fr_FR/index.md).

## Architecture

- **PHP** (`core/class/matterhubbe.class.php`) : choix du type d'appareil Matter
  d'après les types génériques, configuration envoyée au démon, exécution des
  commandes demandées par Google.
- **Démon Node.js** (`resources/matterhubbed`) : le pont Matter, construit sur
  [matter.js](https://github.com/matter-js/matter.js). Il suit les valeurs
  Jeedom par attente longue sur `event::changes` et ne charge jamais le cœur.

## Remerciements

Ce plugin s'inspire de
[home-assistant-matter-hub](https://github.com/RiDDiX/home-assistant-matter-hub),
qui fait la même chose pour Home Assistant. Le correctif
`resources/matterhubbed/lib/patch-level-control.js` en est adapté, ainsi que
plusieurs réglages propres à Google Home (intervalles de souscription,
séquence « éteindre la pièce »).

## Licence

AGPL v3, voir [LICENSE](LICENSE).

`resources/matterhubbed/lib/patch-level-control.js` est adapté de
home-assistant-matter-hub, © les contributeurs de home-assistant-matter-hub,
sous licence Apache 2.0 : voir [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
Le démon s'appuie sur [matter.js](https://github.com/matter-js/matter.js),
lui aussi sous licence Apache 2.0, installé par npm.
