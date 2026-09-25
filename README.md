# Palazzetti CBox pour Homey

Application Homey SDK 3 pilotant une CBox locale via `/cgi-bin/sendmsg.lua`.
Configurer l'adresse IP (ou le nom local, éventuellement avec un port) dans les paramètres du périphérique. L'identifiant Homey existant `com.palazzetti` et les identifiants des capacités et des Flows sont conservés.

## Sauvegarde

Le tag local `before-promise-fixes-2026-09-25` pointe sur le commit `2990f9c`, contenant les sources locales avant correction. Il complète l'historique GitHub, dont les sources étaient différentes. Aucun push n'est effectué automatiquement.

## Fonctionnement corrigé

- Toutes les opérations asynchrones renvoient leurs promesses ; le code applicatif n'utilise ni `async` ni `await`. Les lectures synchrones Homey restent synchrones.
- Les entrées SDK (capacités, actions Flow, paramètres et interrogation périodique) partagent une file par périphérique. Les méthodes internes ne réentrent pas dans cette file. Une erreur est renvoyée à l'appelant sans bloquer les opérations suivantes.
- La CBox est interrogée au démarrage, puis 60 secondes après la fin de chaque cycle. Une panne initiale n'arrête pas les tentatives. Les requêtes expirent réellement au bout de 5 secondes ; erreurs HTTP, réponses tronquées, JSON invalide et refus CBox sont rejetés. Les commandes ne sont pas réessayées automatiquement.
- La régulation utilise un échantillon complet et est réévaluée à chaque cycle, même si la température n'a pas changé. Le hors-gel conserve son mode pendant les pauses. Les conditions d'allumage sont des booléens ; l'autorisation d'allumage s'applique également aux commandes manuelles.
- Après un accusé de réception ON/OFF, l'état interne devient transitoire pour éviter une seconde commande immédiate. L'état affiché et le Flow de changement d'état suivent le prochain retour CBox. Les statuts non reconnus deviennent `UNKNOW` et ne permettent pas un démarrage automatique.
- Les Flows reçoivent les erreurs au lieu d'annoncer un succès prématuré. Les écritures des capacités et compteurs sont attendues par chaînage.
- Les consignes sont entières, conformément à l'arrondi déjà présent dans les commandes CBox. Le compteur d'énergie reste une estimation fondée sur la puissance électrique estimée et le temps écoulé, pas une mesure réelle.
- En l'absence d'index de recharge, la première lecture du compteur de granulés sert de référence. Une baisse du compteur CBox réinitialise cette référence pour éviter une consommation négative.
- Les nouveaux paramètres sont validés avant application ; un changement d'adresse est testé avant adoption. La régulation utilise les nouveaux paramètres au prochain cycle ou changement de température.

Les noms historiques comportant des fautes (`stove_ignation`, `UNKNOW`, etc.) restent inchangés pour préserver les périphériques et les Flows existants.

## Vérifications locales

Avec Node.js 18 ou plus récent pour le lanceur de tests :

```sh
npm ci
npm test
npm run lint
npm run validate
```

Les tests utilisent un substitut du SDK et un serveur HTTP local. Ils ne contactent aucun poêle. La validation Homey recompose `app.json` et produit `.homeybuild/`. Les sources Compose sont réservées à la construction ; l'application charge le manifeste généré.

Le SDK distingue les [lectures synchrones et écritures asynchrones des périphériques](https://apps-sdk-v3.developer.homey.app/Device.html).

## Vérification sur le matériel

La validation locale ne remplace pas un essai avec le firmware CBox et la Homey utilisés : contrôler les états remontés, la perte et le retour de connexion, les Flows d'erreur, l'autorisation d'allumage, SmartStart/SmartPause et le hors-gel. Aucun déploiement ni essai sur le poêle réel n'a été effectué pendant cette correction.
