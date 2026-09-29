# Plugin Matter Hub

Expose vos équipements Jeedom à **Google Home** par le protocole Matter,
entièrement en local : ni cloud, ni DNS Jeedom, ni abonnement aux services
vocaux. Google pilote directement Jeedom sur votre réseau.

Le plugin crée un **pont Matter** (un « bridge ») : Google Home le voit comme un
appareil Matter qui en contient d'autres, un par équipement Jeedom exposé.

## Prérequis

- Un **hub Google compatible Matter** sur le même réseau que Jeedom : Nest Hub
  (2ᵉ génération ou Max), Nest Mini, Nest Audio, Chromecast avec Google TV,
  Google TV Streamer, Nest Wifi Pro… C'est lui qui parle au pont en local.
- Le **multicast (mDNS) et l'IPv6 local** doivent passer entre Jeedom et le hub :
  même réseau, pas de VLAN séparé ni d'isolation Wi-Fi. Le téléphone qui sert
  à l'appairage doit être sur ce même Wi-Fi.
- Un accès à internet pendant l'installation des dépendances (NodeSource et
  npm). Ensuite, tout fonctionne en local.
- **Raspberry Pi** : Pi 2 ou plus récent (ARMv7 ou 64 bits). Node.js 22
  n'existe pas pour les Pi Zero et Pi 1 (ARMv6).
- Le plugin installe **Node.js** (20.19 ou plus récent, 22 de préférence) et la
  bibliothèque matter.js par le mécanisme de dépendances de Jeedom. Comptez
  jusqu'à une vingtaine de minutes. Le démon refuse de démarrer, avec un message
  explicite, si la version de Node.js installée est trop ancienne.
- **Docker** : le conteneur Jeedom doit être en réseau `host` (mDNS et IPv6
  locaux) ; derrière le NAT de Docker, Google ne voit pas le pont.

### Déclarer le pont chez Google (une fois)

Le pont n'est pas certifié par la Connectivity Standards Alliance : il utilise
les identifiants de test Matter. Google Home refuse d'appairer un tel appareil
tant qu'il n'est pas déclaré dans votre compte développeur, ce qui est gratuit :

1. Ouvrez la [Google Home Developer Console](https://console.home.google.com/)
   avec **le même compte Google que l'application Google Home** de la maison,
   et acceptez les conditions.
2. Créez un projet, puis **Add Matter integration**.
3. Renseignez un nom de produit, **Vendor ID `0xFFF1`** et **Product ID
   `0x8000`** ; comme type d'appareil, choisissez un pont (« Bridge ») s'il est
   proposé, sinon n'importe lequel. Enregistrez.

Rien d'autre n'est à faire dans la console : tout reste local ensuite. Si
cette étape est oubliée, l'application Google Home échoue à l'ajout avec un
message du type « Impossible d'ajouter l'appareil », sans autre explication.

## Mise en route

1. **Plugins → Gestion des plugins → Matter Hub** : activez le plugin. Les
   dépendances (Node.js 22 et matter.js) s'installent d'elles-mêmes, et un pont
   « Jeedom » est créé : un seul suffit pour Google Home. Le démon démarre
   seul, une minute environ après la fin de l'installation.
2. Sur la page du plugin, ouvrez le pont « Jeedom ».
3. Onglet **Appareils exposés** : cliquez sur **Proposer une sélection**, puis
   sur **Noms automatiques**, relisez (décochez, renommez, changez le type si
   besoin) et **Sauvegardez**. Vous pouvez aussi tout cocher à la main.
4. Onglet **Pont** : le QR code et le code à 11 chiffres apparaissent.
5. Dans l'application **Google Home** : **Ajouter → Appareil Matter**, scannez
   le QR code, puis rangez les appareils dans vos pièces.
6. Essayez : « Ok Google, allume le plafonnier du salon ».

Ajouter ou retirer un équipement plus tard ne demande pas de réappairer :
enregistrez le pont, l'appareil apparaît ou disparaît dans Google Home. Un
nouvel appareil arrive sans pièce : rangez-le depuis l'application.

À savoir :

- **Noms** : le nom envoyé (32 caractères au plus) sert à l'ajout ; ensuite,
  Google garde en général le nom que vous lui donnez dans l'application.
  Préférez des noms uniques et parlants.
- **Changer le type** d'un appareil déjà exposé (Prise → Lumière) le recrée dans
  Google : pièce et routines sont à refaire.
- **Équipement désactivé** dans Jeedom : il reste dans Google, mais « hors
  ligne », et revient tel quel une fois réactivé. Décochez-le pour le retirer.
- **Équipement supprimé** ou qui a perdu ses types génériques : il est signalé
  en tête de l'onglet « Appareils exposés », pour être décoché.

## Ce qui est exposé

Le type d'appareil est déduit des **types génériques** des commandes
(Outils → Types génériques). Un équipement qui n'apparaît pas dans l'onglet
« Appareils exposés » n'a pas de type générique exploitable.

| Types génériques Jeedom | Appareil dans Google Home |
|---|---|
| `LIGHT_ON` + `LIGHT_OFF` (+ `LIGHT_STATE` / `LIGHT_STATE_BOOL`) | Lumière |
| … + `LIGHT_SLIDER` (+ `LIGHT_BRIGHTNESS`) | Lumière variable |
| … + `LIGHT_SET_COLOR` (+ `LIGHT_COLOR`) et/ou `LIGHT_SET_COLOR_TEMP` (+ `LIGHT_COLOR_TEMP`), avec un `LIGHT_SLIDER` | Lumière couleur ou à blanc réglable |
| `ENERGY_ON` + `ENERGY_OFF` (+ `ENERGY_STATE`) | Prise, ou Lumière au choix |
| `FLAP_UP` + `FLAP_DOWN` et/ou `FLAP_SLIDER` (+ `FLAP_STATE`, `FLAP_STOP` ; variantes `FLAP_BSO_*`) | Volet |
| `THERMOSTAT_SET_SETPOINT` (+ `THERMOSTAT_SETPOINT`, `THERMOSTAT_TEMPERATURE` ou `TEMPERATURE`, `THERMOSTAT_STATE`, `THERMOSTAT_MODE`, `THERMOSTAT_SET_MODE`) | Thermostat (chauffage) |
| `LOCK_CLOSE` + `LOCK_OPEN` (+ `LOCK_STATE`) | Serrure |
| `HEATING_ON` + `HEATING_OFF` (+ `HEATING_STATE`) : fil pilote | Prise (marche / arrêt du chauffage) |
| `OPENING`, `OPENING_WINDOW` | Capteur d'ouverture |
| `PRESENCE` | Capteur de présence |
| `TEMPERATURE` | Capteur de température |
| `HUMIDITY` | Capteur d'humidité |
| `SMOKE` | Détecteur de fumée |
| `WATER_LEAK`, `FLOOD` | Détecteur de fuite d'eau |
| `BRIGHTNESS` (lux) | Capteur de luminosité |
| Un **scénario** Jeedom | Interrupteur qui lance le scénario |

Un équipement qui a une info `BATTERY` la transmet à ses capteurs, sa serrure
et son volet : Google affiche le niveau et prévient quand la pile faiblit
(alerte sous 20 %, remplacement sous 10 %).

Un équipement qui a une info `ONLINE` (connexion du module, fréquente sur les
Shelly, ESPHome…) apparaît **hors ligne** dans Google quand le module ne répond
plus, au lieu de garder un état périmé.

Les détecteurs de fumée et de fuite sont proposés, sauf quand l'équipement est
une caméra (sa « détection de fumée » n'est pas un vrai détecteur). Selon les
versions de Google Home, ces types peuvent ne pas encore être affichés.

Un même équipement peut donner plusieurs appareils : un module
température + humidité apparaît comme deux capteurs.

- **Luminosité d'une lampe** : la plage du curseur (`LIGHT_SLIDER`, valeurs min
  et max de la commande) est convertie vers l'échelle Matter.
- **Ouvertures** : Jeedom compte 1 = fermé. Si le plugin de l'équipement
  remonte l'inverse et que la commande est réglée sur « Inverser », le plugin en
  tient compte.
- **Réponse immédiate** : Google voit le nouvel état tout de suite ; si Jeedom
  refuse la commande, l'état réel est rétabli.
- **Lumière sans boutons** : un curseur `LIGHT_SLIDER` seul suffit ; allumer
  remet le dernier niveau connu, éteindre met le curseur au minimum.
- **Modules à plusieurs relais** : une seule sortie par équipement est exposée
  (celle dont les commandes sont liées à l'info d'état).
- **Volets** : Jeedom compte 0 = fermé et 100 = ouvert, à l'échelle du curseur
  (un curseur 0-99 est aussi accepté) ; un état binaire vaut 1 = ouvert. « Tout ouvrir »
  et « tout fermer » passent par les boutons haut/bas, une position
  intermédiaire par le curseur. Sans curseur, une position devient « ouvrir »
  ou « fermer ». Case « Inverser » si Google montre l'inverse.
- **Thermostats** : chauffage seul pour l'instant. La consigne suit les bornes
  et le pas du curseur `THERMOSTAT_SET_SETPOINT`. Les modes Jeedom
  (`THERMOSTAT_SET_MODE`, une action par mode ou une liste) sont associés à
  « arrêt » et « chauffage » de Google : proposés d'office (Off / Confort…),
  modifiables par appareil. Eco, Hors-gel… n'ont pas d'équivalent Google.
- **Serrures** : `LOCK_STATE` à 1 = verrouillée ; les deux actions sont exigées
  (une gâche qui ne sait qu'ouvrir n'est pas proposée). Selon les réglages de
  Google, le déverrouillage à la voix peut être refusé ou demander une
  confirmation : l'application, elle, déverrouille toujours, sans code, pour
  tous les membres de la maison Google. C'est pourquoi une serrure n'est
  **jamais cochée d'office** : ni par « Proposer une sélection », ni par
  « Cocher les lignes affichées ». Elle est signalée en rouge et se coche à la
  main, en connaissance de cause.
- **Couleur** : `#rrggbb` côté Jeedom ; la luminosité reste celle de la lampe.
  Il faut un curseur de luminosité (`LIGHT_SLIDER`), Matter l'impose.
  Température de couleur en kelvins (unité « K » ou bornes au-delà de 500),
  en mireds si les bornes sont petites ; sans bornes, 2700-6500 K. Une lampe
  couleur sans commande de blanc reçoit le blanc demandé comme une couleur.

## Aide à la sélection et aux noms

- **Proposer une sélection** coche ce qui a du sens dans Google : lumières,
  prises, chauffage, volets, thermostats, ouvertures et vraies sondes
  de température ou d'humidité. Ce qui est déjà coché reste coché. Les
  serrures ne sont jamais cochées d'office (voir plus haut). Les relais
  qu'un « Ok Google, éteins tout » ne doit pas couper (modem, box, NVR, VMC,
  chaudière, pompe, portail, porte de garage, verrou, tableau électrique…) sont
  laissés de côté et signalés en rouge. Ne sont pas proposées non plus, sans
  signalement : les températures internes des modules et des passerelles
  (commande « interne », ou plus de 45 °C) et les présences de téléphones ou de
  caméras. Un relais dont le nom parle d'éclairage (plafond, spot, projecteur,
  lampe, façade…) est proposé en « Lumière ». La sonde externe branchée sur un
  relais (Shelly 1 + DS18B20 : logicalId `ext…` ou nom « externe », « sonde »)
  est proposée comme capteur de la pièce, même si l'équipement a aussi un
  relais ; quand un équipement a plusieurs températures, c'est celle qui n'est
  pas « interne » qui est exposée.
- **Noms automatiques** remplit les noms vides des appareils cochés et affichés avec un nom
  lisible : « Shelly 1 440FA4 — shellyplafondsalon » devient « Plafond salon »,
  une sonde devient « Température cuisine ». Un nom déjà saisi n'est jamais
  remplacé ; relisez avant d'enregistrer.
- Les listes **pièce** et **fonction** filtrent le tableau.

## Scénarios

Les scénarios Jeedom apparaissent en bas de l'onglet « Appareils exposés ».
Un scénario coché devient un interrupteur dans Google : l'allumer lance le
scénario, puis l'interrupteur repasse à « éteint » tout seul, prêt pour la fois
suivante. Donnez-lui un nom facile à dire : « Ok Google, allume mode cinéma ». Le
scénario reçoit le tag `#source#` = `google`. Attention : rangé dans une pièce
de Google, il peut aussi être lancé par « Ok Google, allume tout » dans cette
pièce ; laissez-le hors des pièces si ce n'est pas voulu.
Un scénario désactivé dans Jeedom apparaît « hors ligne » dans Google.

## Retrouver un appareil : « Identifier »

Quand l'application Google Home (ou un autre contrôleur) demande à identifier
un appareil, une lampe ou un relais bascule deux fois puis revient à son état :
pratique pour savoir quel « Plafonnier » ranger dans quelle pièce. Les prises
ne clignotent pas : cela couperait ce qui y est branché.

## Réagir aux ordres de Google

Le pont a une commande info **Dernier ordre Google** : l'appareil et l'action
demandée (« Plafonnier salon : allumer »), mise à jour à chaque ordre, même
identique au précédent. Un scénario Jeedom peut s'en servir comme
déclencheur, pour journaliser ou prévenir.

Deux autres commandes servent aux scénarios et à l'application mobile :
**Code d'appairage** (info) et **Autoriser un nouvel appairage** (action, ouvre
l'appairage pendant 15 minutes).

## Alertes

Le centre de messages de Jeedom prévient, une seule fois tant que la situation
dure : quand plus aucun contrôleur n'est appairé (Google a oublié le pont),
quand le pont ne démarre pas (port déjà utilisé…), et quand un appareil exposé
a été supprimé ou a perdu ses types génériques.

L'onglet « Pont » résume aussi **ce que Google voit** : le nombre d'appareils
par type, ceux hors ligne et ceux qui ne sont plus exposables.

## Options par appareil

Dans l'onglet « Appareils exposés », une fois la ligne cochée :

- **Apparaît comme** : le type d'appareil dans Google (un relais en Lumière
  plutôt qu'en Prise, une lampe couleur en simple lampe variable…).
- **Inverser** (ouvertures, volets, serrures) : si Google montre l'inverse de
  la réalité. S'ajoute à l'option « Inverser » de la commande Jeedom.
- **Mode « arrêt » / Mode « chauffage »** (thermostats) : les modes Jeedom
  déclenchés quand on éteint ou rallume le thermostat depuis Google.
  « Aucun » : Google ne peut pas l'éteindre.

## Plusieurs contrôleurs, réappairage

Le bouton **Autoriser un nouvel appairage** (visible une fois le pont appairé) rend le code
à nouveau utilisable pendant 15 minutes : pour réappairer Google après une
réinitialisation du hub, ou pour ajouter un second contrôleur Matter.

**Réinitialiser** oublie tous les contrôleurs et génère un nouveau code : Google
perd le pont, ses pièces et ses routines.

## Sauvegarde

L'appairage (clés, contrôleurs, numéros d'appareils) est stocké dans
`plugins/matterhubbe/data/matter`, inclus dans les sauvegardes Jeedom.
Restaurer une sauvegarde sur une nouvelle machine conserve l'appairage.
Ces fichiers contiennent les clés du pont : ne partagez pas une sauvegarde.

**Désinstaller le plugin efface cet appairage** : Google perd le pont. Une mise à
jour, elle, le conserve. Avant de supprimer un pont, retirez-le aussi de
l'application Google Home, sinon il y reste « hors ligne ».

## Dépannage

- **Google ne trouve pas le pont** : vérifiez le hub, le réseau (mDNS, IPv6,
  pas d'isolation Wi-Fi), et la déclaration dans la Developer Console. Si la
  machine a plusieurs interfaces (Docker, VPN), indiquez la bonne dans la
  configuration du plugin (« Interface réseau »).
- **« Appareil non certifié »** : normal, confirmez l'ajout.
- **Un appareil ne réagit pas** : journal `matterhubbed` en niveau Debug ; chaque
  commande reçue de Google y est tracée avec la commande Jeedom exécutée. En
  Debug, le journal contient aussi le code d'appairage : ne le publiez pas tel
  quel sur un forum.
- **Le port 5540 est pris** (autre pont Matter sur la machine) : l'onglet
  « Pont » l'indique ; changez le port et enregistrez.
