# Changelog

## 0.5.2

- Une serrure n'est plus jamais cochée d'office : ni par « Proposer une
  sélection », ni par « Cocher les lignes affichées ». Elle est signalée en
  rouge (déverrouillage à distance) et se coche à la main.
- La sonde externe d'un module à relais (Shelly 1 + DS18B20) est proposée
  comme capteur de température de la pièce ; entre plusieurs températures,
  celle qui n'est pas « interne » est exposée.

## 0.5.1

- « Proposer une sélection » ne coche plus les températures internes des
  modules et passerelles (commande « interne » ou plus de 45 °C) ; « Lampe
  garage » ou « Xbox » ne sont plus signalés à tort comme risqués.
- Noms automatiques mieux découpés (accents, noms déjà lisibles gardés,
  coupure au dernier espace, doublons numérotés) et qui suivent le type
  choisi ; seulement sur les lignes affichées.
- « Identifier » ne fait plus clignoter les prises, s'interrompt dès qu'un
  ordre est donné, et remet la lumière dans son état si elle est retirée.
- Un scénario n'est plus lancé deux fois par deux appuis rapprochés ; il
  reçoit le tag #source# = google.
- Détecteurs de fumée : événements d'alarme et de fin d'alarme, alerte de
  pile faible.
- Une info de connexion vide ne met plus l'appareil hors ligne ; un appareil
  n'y reste plus bloqué après un changement de commandes.
- Alertes : elles disparaissent bien une fois le problème réglé, même au bout
  de plusieurs jours ; « Code d'appairage » ne génère plus d'événement à
  chaque rafraîchissement.
- Interface : options affichées avec « cocher les lignes affichées », saisie
  gardée par « Proposer », filtres remis à zéro d'un pont à l'autre.
- Documentation corrigée (tableau des types).

## 0.5

- Un module déconnecté (info ONLINE) apparaît « hors ligne » dans Google.
- Alertes dans le centre de messages : pont désappairé, pont qui ne démarre
  pas, appareil exposé supprimé ou sans types génériques.
- Commandes « Code d'appairage » et « Autoriser un nouvel appairage » sur le
  pont, pour les scénarios et l'application mobile.
- « Identifier » dans Google fait basculer deux fois la lampe ou le relais.
- Récapitulatif « Ce que Google voit » dans l'onglet « Pont ».
- Détecteurs de fumée, de fuite d'eau et capteurs de luminosité.

## 0.4

- « Proposer une sélection » : coche en un clic ce qui est utile dans Google,
  sans ce qu'un « éteins tout » ne doit pas couper (modem, VMC, chaudière,
  portail…), signalé en rouge ; les relais d'éclairage sont proposés en
  « Lumière ».
- « Noms automatiques » : des noms lisibles à la place des identifiants
  techniques (« Plafond salon », « Température cuisine »).
- Filtres par pièce et par fonction dans l'onglet « Appareils exposés ».

## 0.3

- Scénarios Jeedom pilotables depuis Google : un scénario coché devient un
  interrupteur qui le lance (« Ok Google, allume mode cinéma »).
- Commande « Dernier ordre Google » sur le pont, utilisable comme déclencheur
  de scénario.
- Niveau de batterie des capteurs, serrures et volets affiché dans Google,
  avec alerte de pile faible.
- Chauffage par fil pilote exposé en marche / arrêt.

## 0.2

- Volets : ouvrir, fermer, arrêter, position.
- Thermostats (chauffage) : consigne, température, marche/arrêt par les modes
  Jeedom.
- Serrures : verrouiller, déverrouiller.
- Lumières couleur : couleur et température de blanc.
- Options par appareil : sens inversé, modes du thermostat.

## 0.1

- Pont Matter local pour Google Home, appairage par QR code.
- Lumières (simples et variables), prises et relais, capteurs d'ouverture, de
  présence, de température et d'humidité, d'après les types génériques.
- Ajout et retrait d'appareils sans réappairage ; nom et type réglables par
  appareil.
- Ouverture d'une fenêtre d'appairage et réinitialisation depuis la page du pont.
