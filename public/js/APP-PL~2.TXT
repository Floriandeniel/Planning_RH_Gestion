// ==========================================================
// PLANNING USL - logique frontend (vanilla JS, sans framework)
// Toute l'application est protegee par mot de passe (donnees sensibles).
// ==========================================================

const JOURS = ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI', 'DIMANCHE'];

const state = {
  adminToken: localStorage.getItem('planningusl_admin_token') || null,
  reference: { employees: [], salles: [], creneaux: [], source: null },
  planningLundi: null,
  contratEnEdition: null
};

function isConnecte() { return !!state.adminToken; }

// ---------- Helpers generaux ----------

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.adminToken) headers['X-Admin-Token'] = state.adminToken;
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.adminToken) {
      deconnexion();
      throw new Error('Session expiree, merci de vous reconnecter.');
    }
    throw new Error(data.error || 'Erreur serveur');
  }
  return data;
}

function toast(message, isError) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.className = 'toast hidden'; }, 3500);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mondayOfStr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fillSelect(select, items, valueKey, labelKey) {
  select.innerHTML = '';
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item[valueKey];
    opt.textContent = item[labelKey];
    select.appendChild(opt);
  });
}

// ---------- Connexion ----------

document.getElementById('btn-login').addEventListener('click', tenterConnexion);
document.getElementById('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') tenterConnexion(); });

async function tenterConnexion() {
  const password = document.getElementById('login-password').value;
  const erreurEl = document.getElementById('login-erreur');
  erreurEl.classList.add('hidden');
  if (!password) return;
  try {
    const data = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    state.adminToken = data.token;
    localStorage.setItem('planningusl_admin_token', data.token);
    afficherApp();
  } catch (e) {
    erreurEl.textContent = e.message;
    erreurEl.classList.remove('hidden');
  }
}

function deconnexion() {
  state.adminToken = null;
  localStorage.removeItem('planningusl_admin_token');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('ecran-connexion').classList.remove('hidden');
  document.getElementById('login-password').value = '';
}

document.getElementById('btn-deconnexion').addEventListener('click', deconnexion);

async function afficherApp() {
  document.getElementById('ecran-connexion').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  await chargerReference();
  peuplerSelectsEmployes();
  initFormulaires();
  switchTab('semaine-type');
}

// ---------- Reference (salaries + salles depuis RH_USL) ----------

async function chargerReference() {
  try {
    state.reference = await api('/api/reference');
    const alerte = document.getElementById('alerte-reference');
    if (state.reference.source === 'indisponible' || !state.reference.employees.length) {
      alerte.textContent = "RH_USL est injoignable pour le moment : impossible de recuperer la liste des salaries/salles. Reessayez dans un instant.";
      alerte.classList.remove('hidden');
    } else {
      alerte.classList.add('hidden');
    }
  } catch (e) {
    toast(e.message, true);
  }
}

function peuplerSelectsEmployes() {
  const items = state.reference.employees.map((e) => ({ id: e.nom, nom: e.nom }));
  ['contrat-employee', 'verif-employee', 'export-employee', 'recap-employee'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) fillSelect(el, items, 'id', 'nom');
  });

  const datalist = document.getElementById('liste-employes');
  if (datalist) {
    datalist.innerHTML = state.reference.employees.map((e) => `<option value="${escapeHtml(e.nom)}"></option>`).join('');
  }

  const selExistant = document.getElementById('salarie-existant');
  if (selExistant) {
    const valeurActuelle = selExistant.value;
    selExistant.innerHTML = '<option value="">— Nouveau salarie —</option>' +
      state.reference.employees.map((e) => `<option value="${e.id}">${escapeHtml(e.nom)}</option>`).join('');
    if (valeurActuelle) selExistant.value = valeurActuelle;
  }
}

// ---------- Validation des noms saisis dans les grilles (anti-faute de frappe) ----------

function nomsConnus() {
  return (state.reference.employees || []).map((e) => e.nom.toUpperCase());
}

// Retourne { valide: bool, invalides: [...] } pour une valeur de case
// (peut contenir plusieurs noms separes par / ou ,).
function validerNomsCellule(valeur) {
  const v = String(valeur || '').trim();
  if (!v) return { valide: true, invalides: [] };
  const connus = nomsConnus();
  const noms = v.split(/[/,]/).map((n) => n.trim().toUpperCase()).filter(Boolean);
  const invalides = noms.filter((n) => !connus.includes(n));
  return { valide: invalides.length === 0, invalides };
}

// Distance de Levenshtein simplifiee, pour detecter une faute de frappe
// proche d'un nom existant (ex: "LUCSA" proche de "LUCAS").
function distance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);
    }
  }
  return d[m][n];
}

function trouverNomProche(nom) {
  const cible = nom.trim().toUpperCase();
  if (!cible) return null;
  let meilleur = null;
  let meilleureDistance = Infinity;
  nomsConnus().forEach((n) => {
    if (n === cible) return;
    const dist = distance(cible, n);
    if (dist < meilleureDistance) { meilleureDistance = dist; meilleur = n; }
  });
  if (meilleur && meilleureDistance <= 2 && meilleureDistance < cible.length) return meilleur;
  return null;
}

// ---------- Navigation par onglets ----------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

async function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
  // Si la reference RH_USL n'a jamais pu etre chargee (RH_USL injoignable au
  // demarrage), on retente automatiquement a chaque changement d'onglet,
  // au lieu d'obliger l'utilisateur a recharger toute la page.
  if (!state.reference.employees.length) {
    await chargerReference();
    peuplerSelectsEmployes();
  }
  if (name === 'semaine-type') chargerSemaineType();
  if (name === 'planning') chargerPlanning();
  if (name === 'semaines-speciales') chargerSemainesSpeciales();
  if (name === 'contrats') chargerContrats();
  if (name === 'tableau-bord') chargerResumeTableauBord();
  if (name === 'parametres') chargerParametres();
}

function allerAuPlanning(lundi) {
  state.planningLundi = lundi;
  document.getElementById('planning-lundi').value = lundi;
  switchTab('planning');
  document.querySelector('.tab-btn[data-tab="planning"]').classList.add('active');
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'planning'));
  document.querySelectorAll('.tab-content').forEach((s) => s.classList.toggle('active', s.id === 'tab-planning'));
}

// ---------- Construction d'une grille jour x salle x creneau ----------

function construireGrilleDOM(tableId, theadId, valeurs, onBlur) {
  const salles = state.reference.salles || [];
  const creneaux = state.reference.creneaux || [];
  const thead = document.getElementById(theadId);
  thead.innerHTML = '<th>Jour</th><th>Salle</th>' + creneaux.map((c) => `<th>${c.label}</th>`).join('');

  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = '';
  JOURS.forEach((jour) => {
    salles.forEach((salle, idx) => {
      const tr = document.createElement('tr');
      const tdJour = document.createElement('td');
      tdJour.className = 'col-jour';
      tdJour.textContent = idx === 0 ? jour : '';
      tr.appendChild(tdJour);

      const tdSalle = document.createElement('td');
      tdSalle.className = 'col-salle';
      tdSalle.textContent = salle;
      tr.appendChild(tdSalle);

      creneaux.forEach((cr) => {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'cell-input';
        input.setAttribute('list', 'liste-employes');
        const k = `${jour}|${salle}|${cr.code}`;
        const val = valeurs[k] || '';
        input.value = val;
        input.dataset.cle = k;
        if (val) input.classList.add('rempli');
        input.addEventListener('input', () => {
          input.classList.toggle('rempli', !!input.value.trim());
          input.classList.remove('invalide');
        });
        input.addEventListener('blur', () => {
          const verif = validerNomsCellule(input.value);
          if (!verif.valide) {
            input.classList.add('invalide');
            toast(`Nom inconnu : ${verif.invalides.join(', ')} — non enregistre.`, true);
            return;
          }
          input.classList.remove('invalide');
          if (onBlur) onBlur(jour, salle, cr.code, input.value.trim().toUpperCase());
        });
        td.appendChild(input);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  });
}

function lireValeursGrille(tableId) {
  const valeurs = {};
  document.querySelectorAll(`#${tableId} .cell-input`).forEach((input) => {
    valeurs[input.dataset.cle] = input.value.trim();
  });
  return valeurs;
}

// ==========================================================
// ONGLET SEMAINE-TYPE
// ==========================================================

async function chargerSemaineType() {
  try {
    const cellules = await api('/api/semaine-type');
    construireGrilleDOM('table-semaine-type', 'entete-semaine-type', cellules, null);
  } catch (e) { toast(e.message, true); }
}

document.getElementById('btn-save-semaine-type').addEventListener('click', async () => {
  const invalides = [];
  document.querySelectorAll('#table-semaine-type .cell-input').forEach((input) => {
    const verif = validerNomsCellule(input.value);
    if (!verif.valide) { input.classList.add('invalide'); invalides.push(...verif.invalides); }
  });
  if (invalides.length) {
    return toast(`Correction necessaire avant enregistrement : ${[...new Set(invalides)].join(', ')} inconnu(s).`, true);
  }
  const cellules = lireValeursGrille('table-semaine-type');
  try {
    await api('/api/semaine-type', { method: 'PUT', body: JSON.stringify({ cellules }) });
    toast('Semaine-type enregistree.');
  } catch (e) { toast(e.message, true); }
});

// ==========================================================
// ONGLET PLANNING ANNUEL
// ==========================================================

document.getElementById('btn-planning-precedente').addEventListener('click', () => {
  const input = document.getElementById('planning-lundi');
  input.value = mondayOfStr(addDaysStr(input.value || todayStr(), -7));
  chargerPlanning();
});
document.getElementById('btn-planning-suivante').addEventListener('click', () => {
  const input = document.getElementById('planning-lundi');
  input.value = mondayOfStr(addDaysStr(input.value || todayStr(), 7));
  chargerPlanning();
});
document.getElementById('planning-lundi').addEventListener('change', chargerPlanning);

async function chargerPlanning() {
  const lundiInput = document.getElementById('planning-lundi').value || todayStr();
  try {
    const data = await api(`/api/planning?lundi=${lundiInput}`);
    state.planningLundi = data.lundi;
    document.getElementById('planning-lundi').value = data.lundi;
    afficherResumePlanning(data);
    construireGrilleDOM('table-planning', 'entete-planning', data.grille, sauverCellulePlanning);
  } catch (e) { toast(e.message, true); }
}

async function rafraichirResumePlanning() {
  try {
    const data = await api(`/api/planning?lundi=${state.planningLundi}`);
    afficherResumePlanning(data);
  } catch (e) { /* pas grave, la grille reste affichee telle quelle */ }
}

function afficherResumePlanning(data) {
  const source = document.getElementById('planning-source');
  const btnReset = document.getElementById('btn-reset-exceptions');
  const entete = `Semaine ${data.numeroSemaine} — du ${data.lundi} au ${data.dimanche}`;
  if (data.source === 'speciale') {
    source.textContent = `${entete} — semaine speciale : ${data.semaineSpeciale.description} (${data.semaineSpeciale.type})`;
    btnReset.classList.add('hidden');
  } else if (data.source === 'exception') {
    source.textContent = `${entete} — modifiee ponctuellement pour cette semaine uniquement`;
    btnReset.classList.remove('hidden');
  } else {
    source.textContent = `${entete} — semaine normale (semaine-type)`;
    btnReset.classList.add('hidden');
  }

  const chips = document.getElementById('planning-heures');
  chips.innerHTML = '';
  Object.keys(data.heuresParEmploye).sort().forEach((nom) => {
    const chip = document.createElement('span');
    chip.className = 'chip-heure';
    chip.textContent = `${nom} : ${data.heuresParEmploye[nom]}h`;
    chips.appendChild(chip);
  });

  afficherConflitsPlanning(data.conflits);
}

function afficherConflitsPlanning(conflits) {
  const box = document.getElementById('planning-conflits');
  if (!box) return;
  const doublons = (conflits && conflits.doublons) || [];
  const ecarts = (conflits && conflits.ecarts) || [];
  if (!doublons.length && !ecarts.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  let html = '';
  if (doublons.length) {
    html += '<h4>&#9888;&#65039; Doublons : un salarie sur 2 salles en meme temps</h4><ul>';
    doublons.forEach((d) => {
      html += `<li>${escapeHtml(d.nom)} — ${escapeHtml(d.jour)} ${escapeHtml(d.creneau)} : ${d.salles.map(escapeHtml).join(' + ')}</li>`;
    });
    html += '</ul>';
  }
  if (ecarts.length) {
    html += '<h4>&#9888;&#65039; Ecart avec le contrat cette semaine</h4><ul>';
    ecarts.forEach((e) => {
      const signe = e.ecart > 0 ? '+' : '';
      html += `<li>${escapeHtml(e.nom)} : ${e.heuresPrevues}h prevues (contrat ${e.heuresContrat}h, ecart ${signe}${e.ecart}h)</li>`;
    });
    html += '</ul>';
  }
  box.innerHTML = html;
}

async function sauverCellulePlanning(jour, salle, creneau, noms) {
  try {
    await api('/api/planning/cellule', {
      method: 'PUT',
      body: JSON.stringify({ lundi: state.planningLundi, jour, salle, creneau, noms })
    });
    rafraichirResumePlanning();
  } catch (e) { toast(e.message, true); }
}

document.getElementById('btn-reset-exceptions').addEventListener('click', async () => {
  if (!confirm('Revenir a la semaine-type pour cette semaine ? Les modifications ponctuelles seront perdues.')) return;
  try {
    await api(`/api/planning/exceptions/${state.planningLundi}`, { method: 'DELETE' });
    toast('Semaine reinitialisee.');
    chargerPlanning();
  } catch (e) { toast(e.message, true); }
});

async function dupliquerVers(lundiCible) {
  if (!lundiCible) { toast('Choisis une semaine cible.', true); return; }
  const cibleReelle = mondayOfStr(lundiCible);
  if (cibleReelle === state.planningLundi) { toast('Choisis une semaine differente de celle affichee.', true); return; }
  if (!confirm(`Dupliquer le contenu de cette semaine vers la semaine du ${cibleReelle} ? Le contenu actuel de cette semaine-la sera remplace.`)) return;
  try {
    await api('/api/planning/dupliquer', {
      method: 'POST',
      body: JSON.stringify({ lundiSource: state.planningLundi, lundiCible: cibleReelle })
    });
    toast(`Semaine dupliquee vers le ${cibleReelle}.`);
    document.getElementById('planning-lundi').value = cibleReelle;
    chargerPlanning();
  } catch (e) { toast(e.message, true); }
}

document.getElementById('btn-dupliquer-semaine').addEventListener('click', () => {
  dupliquerVers(document.getElementById('planning-lundi-cible').value);
});
document.getElementById('btn-dupliquer-semaine-suivante').addEventListener('click', () => {
  dupliquerVers(mondayOfStr(addDaysStr(state.planningLundi, 7)));
});

// ==========================================================
// ONGLET SEMAINES SPECIALES
// ==========================================================

async function chargerSemainesSpeciales() {
  try {
    const liste = await api('/api/semaines-speciales');
    const tbody = document.querySelector('#table-semaines-speciales-liste tbody');
    tbody.innerHTML = '';
    liste.forEach((s) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(s.description)}</td>
        <td>${s.lundi}</td>
        <td>${s.numeroSemaine}</td>
        <td>${escapeHtml(s.type)}</td>
        <td>
          <button class="btn btn-small btn-go" data-saisir="${s.lundi}">Saisir les horaires</button>
          <button class="btn btn-small btn-stop" data-del="${s.id}">Supprimer</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-saisir]').forEach((btn) => {
      btn.addEventListener('click', () => allerAuPlanning(btn.dataset.saisir));
    });
    tbody.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer cette semaine speciale ? La semaine redeviendra normale.')) return;
        try {
          await api(`/api/semaines-speciales/${btn.dataset.del}`, { method: 'DELETE' });
          toast('Semaine speciale supprimee.');
          chargerSemainesSpeciales();
        } catch (e) { toast(e.message, true); }
      });
    });
  } catch (e) { toast(e.message, true); }
}

document.getElementById('btn-add-semaine-speciale').addEventListener('click', async () => {
  const description = document.getElementById('ss-description').value.trim();
  const lundi = document.getElementById('ss-lundi').value;
  const type = document.getElementById('ss-type').value;
  if (!description || !lundi) return toast('Description et semaine (lundi) requises', true);
  try {
    await api('/api/semaines-speciales', { method: 'POST', body: JSON.stringify({ description, lundi, type }) });
    toast('Semaine speciale ajoutee.');
    document.getElementById('ss-description').value = '';
    document.getElementById('ss-lundi').value = '';
    chargerSemainesSpeciales();
  } catch (e) { toast(e.message, true); }
});

// ==========================================================
// ONGLET CONTRATS
// ==========================================================

async function chargerContrats() {
  try {
    const liste = await api('/api/contrats');
    const tbody = document.querySelector('#table-contrats tbody');
    tbody.innerHTML = '';
    liste.forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(c.employeeNom)}</td>
        <td>${escapeHtml(c.typeContrat)}</td>
        <td>${c.dateDebut || '-'}</td>
        <td>${c.dateFin || '-'}</td>
        <td>${c.heuresHebdoContrat !== null ? c.heuresHebdoContrat + 'h' : '-'}</td>
        <td>${c.tauxHoraireBrut !== null ? c.tauxHoraireBrut + ' €' : '-'}</td>
        <td>${escapeHtml(c.poste || '')}</td>
        <td>
          <button class="btn btn-small btn-warn" data-edit="${c.id}">Modifier</button>
          <button class="btn btn-small btn-stop" data-del="${c.id}">Supprimer</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => remplirFormulaireContrat(liste.find((c) => c.id === btn.dataset.edit)));
    });
    tbody.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer ce contrat ?')) return;
        try {
          await api(`/api/contrats/${btn.dataset.del}`, { method: 'DELETE' });
          toast('Contrat supprime.');
          chargerContrats();
        } catch (e) { toast(e.message, true); }
      });
    });
  } catch (e) { toast(e.message, true); }
}

function remplirFormulaireContrat(c) {
  state.contratEnEdition = c.id;
  document.getElementById('contrat-id').value = c.id;
  document.getElementById('contrat-employee').value = c.employeeNom;
  document.getElementById('contrat-type').value = c.typeContrat;
  document.getElementById('contrat-debut').value = c.dateDebut || '';
  document.getElementById('contrat-fin').value = c.dateFin || '';
  document.getElementById('contrat-heures').value = c.heuresHebdoContrat !== null ? c.heuresHebdoContrat : '';
  document.getElementById('contrat-taux').value = c.tauxHoraireBrut !== null ? c.tauxHoraireBrut : '';
  document.getElementById('contrat-poste').value = c.poste || '';
  document.getElementById('contrat-commentaire').value = c.commentaire || '';
  document.getElementById('btn-annuler-contrat').classList.remove('hidden');
  document.getElementById('tab-contrats').scrollIntoView({ behavior: 'smooth' });
}

function viderFormulaireContrat() {
  state.contratEnEdition = null;
  document.getElementById('contrat-id').value = '';
  document.getElementById('contrat-debut').value = '';
  document.getElementById('contrat-fin').value = '';
  document.getElementById('contrat-heures').value = '';
  document.getElementById('contrat-taux').value = '';
  document.getElementById('contrat-poste').value = '';
  document.getElementById('contrat-commentaire').value = '';
  document.getElementById('btn-annuler-contrat').classList.add('hidden');
}

document.getElementById('btn-annuler-contrat').addEventListener('click', viderFormulaireContrat);

document.getElementById('btn-save-contrat').addEventListener('click', async () => {
  const payload = {
    employeeNom: document.getElementById('contrat-employee').value,
    typeContrat: document.getElementById('contrat-type').value,
    dateDebut: document.getElementById('contrat-debut').value || null,
    dateFin: document.getElementById('contrat-fin').value || null,
    heuresHebdoContrat: document.getElementById('contrat-heures').value,
    tauxHoraireBrut: document.getElementById('contrat-taux').value,
    poste: document.getElementById('contrat-poste').value.trim(),
    commentaire: document.getElementById('contrat-commentaire').value.trim()
  };
  if (!payload.employeeNom) return toast('Choisissez un salarie', true);
  try {
    if (state.contratEnEdition) {
      await api(`/api/contrats/${state.contratEnEdition}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Contrat modifie.');
    } else {
      await api('/api/contrats', { method: 'POST', body: JSON.stringify(payload) });
      toast('Contrat ajoute.');
    }
    viderFormulaireContrat();
    chargerContrats();
  } catch (e) { toast(e.message, true); }
});

// ==========================================================
// ONGLET VERIFICATION DES HEURES
// ==========================================================

document.getElementById('btn-verifier').addEventListener('click', async () => {
  const employeeNom = document.getElementById('verif-employee').value;
  const from = document.getElementById('verif-from').value;
  const to = document.getElementById('verif-to').value;
  if (!employeeNom || !from || !to) return toast('Salarie, du et au sont requis', true);
  try {
    const data = await api(`/api/verification-heures?employeeNom=${encodeURIComponent(employeeNom)}&from=${from}&to=${to}`);
    const alerte = document.getElementById('verif-alerte');
    if (data.statutRhUsl === 'indisponible') {
      alerte.textContent = 'RH_USL est injoignable : les heures pointees affichees peuvent etre incompletes.';
      alerte.classList.remove('hidden');
    } else {
      alerte.classList.add('hidden');
    }

    const chips = document.getElementById('verif-totaux');
    chips.innerHTML = `
      <span class="chip-heure">Prevu : ${data.totalPrevu}h</span>
      <span class="chip-heure">Pointe : ${data.totalPointe}h</span>
      <span class="chip-heure">Ecart : ${data.totalEcart > 0 ? '+' : ''}${data.totalEcart}h</span>
    `;

    const tbody = document.querySelector('#table-verification tbody');
    tbody.innerHTML = '';
    data.jours.forEach((j) => {
      const tr = document.createElement('tr');
      const ecartAbs = Math.abs(j.ecartHeures);
      tr.className = ecartAbs < 0.5 ? 'ecart-ok' : ecartAbs < 2 ? 'ecart-attention' : 'ecart-important';
      tr.innerHTML = `
        <td>${j.date}</td>
        <td>${j.jour}</td>
        <td>${j.prevuesHeures}h</td>
        <td class="col-pointe"></td>
        <td class="col-ecart">${j.ecartHeures > 0 ? '+' : ''}${j.ecartHeures}h</td>
        <td class="col-effacer"></td>
      `;
      const tdPointe = tr.querySelector('.col-pointe');
      const inputPointe = document.createElement('input');
      inputPointe.type = 'number';
      inputPointe.step = '0.25';
      inputPointe.min = '0';
      inputPointe.className = 'pointe-input' + (j.manuel ? ' manuel' : '');
      inputPointe.value = j.pointeesHeures;
      inputPointe.title = j.manuel ? 'Valeur corrigee a la main' : 'Valeur venant de RH_USL';
      inputPointe.addEventListener('change', () => sauverPointageManuel(employeeNom, j.date, inputPointe.value, from, to));
      tdPointe.appendChild(inputPointe);

      const tdEffacer = tr.querySelector('.col-effacer');
      if (j.manuel) {
        const btnEffacer = document.createElement('button');
        btnEffacer.className = 'btn-effacer-pointe';
        btnEffacer.title = 'Revenir a la valeur RH_USL';
        btnEffacer.textContent = '✕';
        btnEffacer.addEventListener('click', () => sauverPointageManuel(employeeNom, j.date, '', from, to));
        tdEffacer.appendChild(btnEffacer);
      }
      tbody.appendChild(tr);
    });
  } catch (e) { toast(e.message, true); }
});

async function sauverPointageManuel(employeeNom, date, heures, from, to) {
  try {
    await api('/api/verification-heures/pointage-manuel', {
      method: 'PUT',
      body: JSON.stringify({ employeeNom, date, heures: heures === '' ? '' : heures })
    });
    toast(heures === '' ? 'Correction supprimee, retour a RH_USL.' : 'Pointage corrige.');
    document.getElementById('btn-verifier').click();
  } catch (e) { toast(e.message, true); }
}

// ==========================================================
// ONGLET RECAP HEURES (par semaine / mois / annee)
// ==========================================================

document.getElementById('btn-recap').addEventListener('click', async () => {
  const employeeNom = document.getElementById('recap-employee').value;
  const from = document.getElementById('recap-from').value;
  const to = document.getElementById('recap-to').value;
  if (!employeeNom) return toast('Choisissez un salarie', true);
  try {
    const url = `/api/recap-heures?employeeNom=${encodeURIComponent(employeeNom)}` + (from ? `&from=${from}` : '') + (to ? `&to=${to}` : '');
    const data = await api(url);

    const tbodySemaine = document.querySelector('#table-recap-semaine tbody');
    tbodySemaine.innerHTML = data.semaines.map((s) => `<tr><td>${s.numeroSemaine}</td><td>${s.lundi}</td><td>${s.total}h</td></tr>`).join('') || '<tr><td colspan="3">Aucune heure prevue sur cette periode.</td></tr>';

    const tbodyMois = document.querySelector('#table-recap-mois tbody');
    tbodyMois.innerHTML = data.mois.map((m) => `<tr><td>${m.mois}</td><td>${m.total}h</td></tr>`).join('') || '<tr><td colspan="2">Aucune heure prevue sur cette periode.</td></tr>';

    const tbodyAnnee = document.querySelector('#table-recap-annee tbody');
    tbodyAnnee.innerHTML = data.annees.map((a) => `<tr><td>${a.annee}</td><td>${a.total}h</td></tr>`).join('') || '<tr><td colspan="2">Aucune heure prevue sur cette periode.</td></tr>';
  } catch (e) { toast(e.message, true); }
});

// ==========================================================
// ONGLET TABLEAU DE BORD
// ==========================================================

async function chargerResumeTableauBord() {
  try {
    const data = await api('/api/tableau-bord/resume');
    const zone = document.getElementById('tb-resume');
    zone.innerHTML = `
      <span class="chip-heure">Ce mois (${data.mois.cle}) : ${data.mois.total}h — tous salaries</span>
      <span class="chip-heure">Cette annee (${data.annee.cle}) : ${data.annee.total}h — tous salaries</span>
    `;
  } catch (e) { /* pas grave, le tableau reste utilisable via Calculer */ }
}

document.getElementById('btn-calculer-tb').addEventListener('click', async () => {
  const from = document.getElementById('tb-from').value;
  const to = document.getElementById('tb-to').value;
  try {
    const url = '/api/tableau-bord' + (from || to ? `?from=${from || ''}&to=${to || ''}` : '');
    const data = await api(url);
    afficherTableauBord(data);
  } catch (e) { toast(e.message, true); }
});

function afficherTableauBord(data) {
  const noms = Object.keys(data.parSalarie).sort();
  const nbSemaines = data.nbSemaines || 1;

  const tbodySalarie = document.querySelector('#table-tb-salarie tbody');
  tbodySalarie.innerHTML = '';
  noms.forEach((nom) => {
    const s = data.parSalarie[nom];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(nom)}</td><td>${s.total}h</td><td>${(s.total / nbSemaines).toFixed(1)}h</td>`;
    tbodySalarie.appendChild(tr);
  });

  const salles = state.reference.salles || [];
  document.getElementById('entete-tb-salle').innerHTML = '<th>Salarie</th>' + salles.map((s) => `<th>${escapeHtml(s)}</th>`).join('') + '<th>Total</th>';
  const tbodySalle = document.querySelector('#table-tb-salle tbody');
  tbodySalle.innerHTML = '';
  noms.forEach((nom) => {
    const s = data.parSalarie[nom];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(nom)}</td>` + salles.map((sal) => `<td>${s.parSalle[sal] || 0}h</td>`).join('') + `<td>${s.total}h</td>`;
    tbodySalle.appendChild(tr);
  });

  const creneaux = state.reference.creneaux || [];
  document.getElementById('entete-tb-creneau').innerHTML = '<th>Salarie</th>' + creneaux.map((c) => `<th>${c.label}</th>`).join('') + '<th>Total</th>';
  const tbodyCreneau = document.querySelector('#table-tb-creneau tbody');
  tbodyCreneau.innerHTML = '';
  noms.forEach((nom) => {
    const s = data.parSalarie[nom];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(nom)}</td>` + creneaux.map((c) => `<td>${s.parCreneau[c.code] || 0}h</td>`).join('') + `<td>${s.total}h</td>`;
    tbodyCreneau.appendChild(tr);
  });
}

// ==========================================================
// ONGLET EXPORT (telechargement Excel avec authentification)
// ==========================================================

document.getElementById('btn-export').addEventListener('click', async () => {
  const employeeNom = document.getElementById('export-employee').value;
  const from = document.getElementById('export-from').value;
  const to = document.getElementById('export-to').value;
  if (!employeeNom || !from || !to) return toast('Salarie, du et au sont requis', true);
  try {
    const url = `/api/export/planning-excel?employeeNom=${encodeURIComponent(employeeNom)}&from=${from}&to=${to}`;
    const res = await fetch(url, { headers: { 'X-Admin-Token': state.adminToken } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Erreur lors du telechargement');
    }
    const blob = await res.blob();
    const lienUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = lienUrl;
    a.download = `Planning_${employeeNom}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(lienUrl);
    toast('Fichier telecharge.');
  } catch (e) { toast(e.message, true); }
});

// ==========================================================
// ONGLET PARAMETRES
// ==========================================================

async function chargerParametres() {
  try {
    const settings = await api('/api/settings');
    document.getElementById('param-debut').value = settings.debutSaison;
    document.getElementById('param-fin').value = settings.finSaison;

    const zone = document.getElementById('param-reference');
    if (state.reference.employees.length) {
      zone.textContent = `${state.reference.employees.length} salarie(s) : ${state.reference.employees.map((e) => e.nom).join(', ')}. Salles : ${state.reference.salles.join(', ')}.`;
    } else {
      zone.textContent = 'Liste indisponible pour le moment (RH_USL injoignable).';
    }
    peuplerSelectsEmployes();
  } catch (e) { toast(e.message, true); }
}

// ---------- Ajout / modification d'un salarie (relai vers RH_USL) ----------

document.getElementById('salarie-existant').addEventListener('change', (e) => {
  const id = e.target.value;
  const champNom = document.getElementById('salarie-nom');
  const champCouleur = document.getElementById('salarie-couleur');
  const champHeures = document.getElementById('salarie-heures');
  if (!id) {
    champNom.value = ''; champNom.disabled = false; champCouleur.value = '#ffa000'; champHeures.value = 35;
    return;
  }
  const emp = state.reference.employees.find((x) => String(x.id) === String(id));
  if (!emp) return;
  champNom.value = emp.nom;
  champCouleur.value = emp.couleur || '#ffa000';
  champHeures.value = emp.heuresHebdoContrat || 35;
});

document.getElementById('btn-save-salarie').addEventListener('click', async () => {
  const id = document.getElementById('salarie-existant').value;
  const nom = document.getElementById('salarie-nom').value.trim();
  const couleur = document.getElementById('salarie-couleur').value;
  const heuresHebdoContrat = document.getElementById('salarie-heures').value;
  const rhUslPassword = document.getElementById('salarie-rhusl-password').value;
  if (!nom) return toast('Le nom du salarie est requis', true);
  if (!rhUslPassword) return toast('Le mot de passe admin RH_USL est requis', true);

  if (!id) {
    const proche = trouverNomProche(nom);
    if (proche && !confirm(`Un salarie proche existe deja : "${proche}". Est-ce une faute de frappe ? Cliquez sur Annuler pour corriger, ou OK pour ajouter quand meme "${nom.toUpperCase()}".`)) {
      return;
    }
  }

  try {
    if (id) {
      await api(`/api/rhusl/employees/${id}`, { method: 'PUT', body: JSON.stringify({ nom, couleur, heuresHebdoContrat, rhUslPassword }) });
      toast('Salarie modifie sur RH_USL.');
    } else {
      await api('/api/rhusl/employees', { method: 'POST', body: JSON.stringify({ nom, couleur, heuresHebdoContrat, rhUslPassword }) });
      toast('Salarie ajoute sur RH_USL.');
    }
    document.getElementById('salarie-rhusl-password').value = '';
    await chargerReference();
    peuplerSelectsEmployes();
    chargerParametres();
  } catch (e) { toast(e.message, true); }
});

// ==========================================================
// ONGLET ACTUALISATION
// ==========================================================

document.getElementById('btn-actualiser').addEventListener('click', async () => {
  const zone = document.getElementById('actualisation-resultat');
  zone.className = 'status-box';
  zone.textContent = 'Actualisation en cours... (peut prendre jusqu\'a 30 secondes si RH_USL etait en veille)';
  try {
    const data = await api('/api/actualiser', { method: 'POST' });
    state.reference = data;
    peuplerSelectsEmployes();
    const heure = new Date(data.heureActualisation).toLocaleTimeString('fr-FR');
    if (data.source === 'indisponible') {
      zone.className = 'status-box erreur';
      zone.textContent = `RH_USL reste injoignable (${heure}). Erreur technique : ${data.erreur || 'inconnue'}.`;
    } else if (data.source === 'cache-expiree') {
      zone.className = 'status-box erreur';
      zone.textContent = `RH_USL injoignable a l'instant, anciennes donnees reutilisees (${heure}). Erreur technique : ${data.erreur || 'inconnue'}.`;
    } else {
      zone.className = 'status-box succes';
      zone.textContent = `A jour (${heure}) : ${data.employees.length} salarie(s), ${data.salles.length} salle(s) recharges depuis RH_USL.`;
    }
    toast('Actualisation terminee.');
  } catch (e) {
    zone.className = 'status-box erreur';
    zone.textContent = `Erreur lors de l'actualisation : ${e.message}`;
    toast(e.message, true);
  }
});

document.getElementById('btn-save-periode').addEventListener('click', async () => {
  const debutSaison = document.getElementById('param-debut').value;
  const finSaison = document.getElementById('param-fin').value;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ debutSaison, finSaison }) });
    toast('Periode enregistree.');
  } catch (e) { toast(e.message, true); }
});

document.getElementById('btn-change-password').addEventListener('click', async () => {
  const newPassword = document.getElementById('new-admin-password').value;
  if (!newPassword || newPassword.length < 4) return toast('Au moins 4 caracteres', true);
  try {
    const data = await api('/api/admin/change-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
    state.adminToken = data.token;
    localStorage.setItem('planningusl_admin_token', data.token);
    document.getElementById('new-admin-password').value = '';
    toast('Mot de passe change.');
  } catch (e) { toast(e.message, true); }
});

// ---------- Initialisation des dates par defaut dans les formulaires ----------

function initFormulaires() {
  const debut = state.reference && document.getElementById('param-debut');
  document.getElementById('planning-lundi').value = mondayOfStr(todayStr());
  document.getElementById('verif-from').value = mondayOfStr(todayStr());
  document.getElementById('verif-to').value = addDaysStr(mondayOfStr(todayStr()), 6);
  document.getElementById('export-from').value = mondayOfStr(todayStr());
  document.getElementById('export-to').value = addDaysStr(mondayOfStr(todayStr()), 27);
  document.getElementById('recap-from').value = '';
  document.getElementById('recap-to').value = '';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Demarrage ----------

if (isConnecte()) {
  afficherApp();
}
