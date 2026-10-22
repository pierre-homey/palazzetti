# TODO – Driver Palazzetti CBox

- [x] **Clarifier le comportement de SmartPause**
  - Descriptions française et anglaise corrigées : mise en pause lorsque la température atteint ou dépasse la consigne augmentée du delta de pause, sans notion de durée.

- [x] **Éviter d’utiliser une température déportée périmée**
  - [x] Ajouter un délai réglable (30 minutes par défaut) et un trigger Flow quand la température est périmée, uniquement si `externalTerm` est activé; l’horodatage repart de maintenant au démarrage.
  - Avec `externalTerm` activé, la dernière valeur de `external_temperature` peut continuer à servir à la régulation si le Flow qui l’alimente s’arrête.
  - Décider si la régulation doit cesser d’utiliser la valeur tant qu’une nouvelle mesure n’est pas reçue après l’alerte.

- [x] **Valider les températures reçues**
  - Limites ambiantes configurables dans les settings, par défaut de 0 à 40 °C, communes à `T1` et à la sonde déportée.
  - Une température déportée hors limites est rejetée avant toute écriture ou actualisation de son horodatage. Un `T1` invalide n’est ni publié ni utilisé pour la régulation; le polling reste sain.
  - Tests ajoutés pour les bornes et les valeurs hors limites.

- [ ] **Vérifier la cohérence du mode Silence**
  - Le seuil de silence peut appliquer le préréglage silencieux sans que `stove_regulation` passe nécessairement à `SILENTLY`.
  - Décider si cette capacité représente le mode sélectionné ou le préréglage actuellement appliqué, puis aligner code et interface.

- [ ] **Définir l’affichage en cas d’état CBox inconnu**
  - Un état inconnu devient `UNKNOW`, mais le mode de régulation précédent est conservé; `onoff` peut donc rester activé même si l’état réel n’est pas connu.
  - Décider si ces capacités doivent refléter le dernier état connu ou signaler explicitement l’incertitude.
  - Ajouter un test qui vérifie leur cohérence après un statut inconnu.

- [x] **Évaluer le risque de doublon lors d’un nouvel appairage**
  - L’identifiant du périphérique est aléatoire à chaque appairage.
  - Vérifier si réappairer la même CBox peut créer un deuxième périphérique dans Homey; si oui, utiliser un identifiant stable quand c’est possible.

- [x] **Documenter et tester la remise à zéro du compteur de granulés**
  - Le Flow manuel confirme une recharge complète; l’effacement par la CBox de l’alarme après confirmation réinitialise également la référence.
  - Une baisse du compteur réinitialise la référence pour éviter une consommation négative.
  - Test couvrant la première référence, la préalarme, la remise à zéro manuelle sans alarme et la baisse du compteur.

- [ ] **Compléter les tests de régulation**
  - Couvrir les limites de seuil SmartStart / reprise après pause, l’entrée et la sortie du mode Silence, et les données de température périmées ou invalides.

- [x] **Isoler les erreurs de préréglage automatique**
  - Les erreurs de polling ou de régulation ne rendent plus l’appareil indisponible ; elles sont journalisées et restent propagées à l’appelant.
  - Les échecs de requête activent `alarm_connectivity`, remise à zéro à la prochaine requête réussie. Une erreur d’écriture Homey ne déclenche pas cette alarme.
  - Un préréglage partiel conserve les valeurs confirmées ; le cycle suivant relit l’état et réévalue la régulation.
  - Tests ajoutés pour les échecs de ventilation et de puissance, la poursuite du polling et la reprise après resynchronisation.

- [x] **Ignorer les erreurs de polling après suppression du périphérique**
  - Les opérations Homey et les déclenchements de Flow vérifient que le périphérique est actif avant et après chaque appel asynchrone.
  - Une réponse HTTP tardive interrompt la chaîne après suppression, sans écrire de capacité ni relancer le polling.
  - Un try/catch interrompt aussi les appels déjà engagés qui échouent après suppression (notamment `Not Found`), sans journaliser cette annulation attendue. Les erreurs inattendues sur un périphérique actif restent visibles.
  - Tests couvrant la réponse tardive, la suppression pendant une écriture réussie ou rejetée avec `Not Found`, et la propagation d’un `Not Found` inattendu.


- [x] **Gérer une demande ON pendant l’extinction**
  - ON est refusé pendant l’extinction avec un message français/anglais demandant d’attendre l’arrêt complet ; aucune demande n’est mémorisée.
  - Après un OFF accepté, le bouton reste à OFF pendant l’extinction, y compris en présence d’états transitoires ou de valeurs de chauffe retardées. La protection prend fin à l’arrêt confirmé ou en défaut.
  - Tests couvrant la stabilité du bouton, OFF pendant STOPPING, l’échec de OFF, le refus de ON et une nouvelle demande ON après arrêt complet.
