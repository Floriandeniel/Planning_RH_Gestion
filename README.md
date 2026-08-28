# Planning USL

Logiciel de planning, contrats et verification des heures, en lien avec [RH_USL](https://rh-usl-app.onrender.com).

## Fonctionnement

- **Semaine-type** : la grille de reference (jour x salle x creneau), remplie une seule fois.
- **Planning annuel** : consultation/edition semaine par semaine, recopiee automatiquement depuis la semaine-type, avec exceptions ponctuelles possibles.
- **Semaines speciales** : vacances / horaires reduits / stage, avec leur propre grille dediee.
- **Contrats** : donnees sensibles par salarie (type de contrat, dates, heures/semaine, taux horaire...). Non lisibles sans connexion.
- **Verification des heures** : compare les heures prevues au planning avec les heures reellement pointees sur RH_USL.
- **Tableau de bord** : comptages automatiques par salarie / salle / creneau.
- **Export** : genere un fichier Excel du planning d'un salarie, a lui remettre.

Les salaries et les salles ne sont **pas ressaisis ici** : ils sont recuperes automatiquement depuis RH_USL (`GET /api/employees` et `GET /api/settings`), pour eviter toute liste desynchronisee. Pour changer un nom de salarie ou de salle, il faut le faire depuis RH_USL.

Toute l'application est protegee par un mot de passe (donnees de contrat/salaire sensibles) : contrairement a RH_USL/Bureau'USL, il n'y a pas de partie publique.

## Variables d'environnement (Render)

- `MONGODB_URI` : base MongoDB Atlas (sinon stockage local en fichier JSON).
- `RH_USL_URL` : adresse de l'application RH_USL (par defaut `https://rh-usl-app.onrender.com`).

## Mot de passe par defaut

`PLANNING2026` — a changer depuis l'onglet Parametres apres la premiere connexion.
