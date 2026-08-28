/**
 * PLANNING USL - Serveur principal
 * ---------------------------------------------------
 * Logiciel de planning lie a l'application RH_USL :
 *  - Semaine-type (grille de reference, remplie une seule fois)
 *  - Planning annuel (recopie automatique + exceptions ponctuelles)
 *  - Semaines speciales (vacances / horaires reduits / stage)
 *  - Contrats des salaries (donnees sensibles)
 *  - Verification des heures (prevues vs pointees sur RH_USL)
 *  - Tableau de bord (comptages automatiques)
 *  - Export Excel (planning individuel a donner a un salarie)
 *
 * Les salaries et les salles ne sont PAS ressaisis ici : ils sont
 * recuperes automatiquement depuis RH_USL (source unique de verite),
 * pour eviter tout risque de listes qui se desynchronisent.
 *
 * Toute l'application est protegee par le mot de passe administrateur
 * (donnees de contrat/salaire sensibles) : il faut se connecter pour
 * voir quoi que ce soit, contrairement a RH_USL/Bureau'USL qui ont
 * des parties publiques.
 *
 * Stockage :
 *  - Si MONGODB_URI est definie -> MongoDB
 *  - Sinon -> fichier JSON local (data/db.json)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');
const { MongoClient } = require('mongodb');

// Adresse de RH_USL, source des salaries / salles / heures pointees
const RH_USL_URL = process.env.RH_USL_URL || 'https://rh-usl-app.onrender.com';

const DEFAULT_ADMIN_PASSWORD = 'PLANNING2026';

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const MONGODB_URI = process.env.MONGODB_URI;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Constantes du planning ----------

const JOURS = ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI', 'DIMANCHE'];
const CRENEAUX = [
  '8_9', '9_10', '10_11', '11_12', '12_13', '13_14', '14_15', '15_16',
  '16_17', '17_18', '18_19', '19_20', '20_21', '21_22', '22_23', '23_24'
];

function libelleCreneau(code) {
  const [a, b] = code.split('_');
  return `${a}h-${b}h`;
}

function cle(jour, salle, creneau) {
  return `${jour}|${salle}|${creneau}`;
}

// ---------- Utilitaires date ----------

function formatDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return formatDateLocal(d);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return formatDateLocal(d);
}

function jourDeDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const idx = (d.getDay() + 6) % 7; // lundi = 0 ... dimanche = 6
  return JOURS[idx];
}

// ---------- Utilitaires base de donnees ----------

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

function computeAdminToken(state) {
  return crypto.createHmac('sha256', state.settings.adminPasswordHash).update('planningusl-admin-session').digest('hex');
}

function requireAdmin(req, res, next) {
  loadState().then((state) => {
    const token = req.headers['x-admin-token'];
    if (token && token === computeAdminToken(state)) return next();
    res.status(401).json({ error: 'Merci de vous connecter.' });
  }).catch((e) => res.status(500).json({ error: e.message }));
}

function defaultData() {
  return {
    settings: {
      adminPasswordHash: hashPassword(DEFAULT_ADMIN_PASSWORD),
      debutSaison: '2026-08-31',
      finSaison: '2027-08-15'
    },
    semaineType: {},       // { "LUNDI|SALLE 1|8_9": "LUCAS/KYKY", ... }
    exceptions: {},        // { "2026-09-07": { "LUNDI|SALLE 1|8_9": "LUCAS" } }
    semainesSpeciales: [], // [{ id, description, lundi, type, grille: {...} }]
    contrats: []           // [{ id, employeeNom, typeContrat, dateDebut, dateFin, heuresHebdoContrat, tauxHoraireBrut, poste, commentaire }]
  };
}

function migrateData(state) {
  let changed = false;
  const def = defaultData();
  if (!state.settings) { state.settings = def.settings; changed = true; }
  if (!state.settings.adminPasswordHash) { state.settings.adminPasswordHash = def.settings.adminPasswordHash; changed = true; }
  if (!state.settings.debutSaison) { state.settings.debutSaison = def.settings.debutSaison; changed = true; }
  if (!state.settings.finSaison) { state.settings.finSaison = def.settings.finSaison; changed = true; }
  if (!state.semaineType) { state.semaineType = {}; changed = true; }
  if (!state.exceptions) { state.exceptions = {}; changed = true; }
  if (!state.semainesSpeciales) { state.semainesSpeciales = []; changed = true; }
  if (!state.contrats) { state.contrats = []; changed = true; }
  return changed;
}

let mongoClientPromise = null;
function getMongoClient() {
  if (!mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI);
    mongoClientPromise = client.connect();
  }
  return mongoClientPromise;
}

async function loadState() {
  if (MONGODB_URI) {
    const client = await getMongoClient();
    const col = client.db('planningusl').collection('appstate');
    let doc = await col.findOne({ _id: 'main' });
    if (!doc) {
      doc = { _id: 'main', ...defaultData() };
      await col.insertOne(doc);
    } else if (migrateData(doc)) {
      await saveState(doc);
    }
    return doc;
  }
  let raw;
  try {
    raw = fs.readFileSync(DB_PATH, 'utf-8');
  } catch (e) {
    raw = '{}';
  }
  let state = {};
  try { state = JSON.parse(raw) || {}; } catch (e) { state = {}; }
  if (!state.settings) state = { ...defaultData(), ...state };
  if (migrateData(state)) fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2), 'utf-8');
  return state;
}

async function saveState(state) {
  if (MONGODB_URI) {
    const client = await getMongoClient();
    const col = client.db('planningusl').collection('appstate');
    const { _id, ...rest } = state;
    await col.updateOne({ _id: 'main' }, { $set: rest }, { upsert: true });
    return;
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

// ---------- Cache pour les appels vers RH_USL (evite de le solliciter en boucle) ----------

let cacheReference = { employees: [], salles: [], at: 0 };
const DUREE_CACHE_MS = 60 * 1000;

async function fetchAvecDelai(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`RH_USL a repondu ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getReference() {
  const maintenant = Date.now();
  if (maintenant - cacheReference.at < DUREE_CACHE_MS && cacheReference.employees.length) {
    return { ...cacheReference, source: 'cache' };
  }
  try {
    const [employees, settingsData] = await Promise.all([
      fetchAvecDelai(`${RH_USL_URL}/api/employees`, 12000),
      fetchAvecDelai(`${RH_USL_URL}/api/settings`, 12000)
    ]);
    cacheReference = { employees, salles: settingsData.salles || [], at: maintenant };
    return { ...cacheReference, source: 'rh-usl' };
  } catch (e) {
    if (cacheReference.employees.length) return { ...cacheReference, source: 'cache-expiree' };
    return { employees: [], salles: [], at: 0, source: 'indisponible', erreur: e.message };
  }
}

// ---------- Calcul de la grille d'une semaine ----------

function grilleSemaine(state, lundi) {
  const semaineSpeciale = (state.semainesSpeciales || []).find((s) => s.lundi === lundi);
  if (semaineSpeciale) {
    return { source: 'speciale', grille: semaineSpeciale.grille || {}, semaineSpeciale };
  }
  const grille = { ...(state.semaineType || {}) };
  const exceptionsSemaine = (state.exceptions && state.exceptions[lundi]) || {};
  let aDesExceptions = false;
  Object.keys(exceptionsSemaine).forEach((k) => {
    aDesExceptions = true;
    const val = exceptionsSemaine[k];
    if (val === '' || val === null || val === undefined) delete grille[k];
    else grille[k] = val;
  });
  return { source: aDesExceptions ? 'exception' : 'type', grille };
}

function nomsDeCellule(valeur) {
  if (!valeur) return [];
  return String(valeur).split(/[/,]/).map((n) => n.trim().toUpperCase()).filter(Boolean);
}

function heuresParEmployeDeGrille(grille) {
  const totaux = {};
  Object.values(grille).forEach((val) => {
    nomsDeCellule(val).forEach((nom) => { totaux[nom] = (totaux[nom] || 0) + 1; });
  });
  return totaux;
}

function heuresPrevuesJour(state, employeeNom, dateStr) {
  const lundi = mondayOf(dateStr);
  const jour = jourDeDate(dateStr);
  const { grille } = grilleSemaine(state, lundi);
  const cible = employeeNom.trim().toUpperCase();
  let total = 0;
  Object.keys(grille).forEach((k) => {
    const [j] = k.split('|');
    if (j !== jour) return;
    if (nomsDeCellule(grille[k]).includes(cible)) total += 1;
  });
  return total;
}

// ---------- Routes : ADMINISTRATION ----------

app.post('/api/admin/login', async (req, res) => {
  const state = await loadState();
  const { password } = req.body;
  if (!password || hashPassword(password) !== state.settings.adminPasswordHash) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  res.json({ token: computeAdminToken(state) });
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  const state = await loadState();
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 4 caracteres' });
  }
  state.settings.adminPasswordHash = hashPassword(newPassword);
  await saveState(state);
  res.json({ token: computeAdminToken(state) });
});

// ---------- Route : REFERENCE (salaries + salles, depuis RH_USL) ----------

app.get('/api/reference', requireAdmin, async (req, res) => {
  const reference = await getReference();
  res.json({ ...reference, jours: JOURS, creneaux: CRENEAUX.map((c) => ({ code: c, label: libelleCreneau(c) })) });
});

// ---------- Route : PARAMETRES (periode de la saison) ----------

app.get('/api/settings', requireAdmin, async (req, res) => {
  const state = await loadState();
  res.json(state.settings);
});

app.put('/api/settings', requireAdmin, async (req, res) => {
  const state = await loadState();
  const { debutSaison, finSaison } = req.body;
  if (debutSaison) state.settings.debutSaison = mondayOf(debutSaison);
  if (finSaison) state.settings.finSaison = finSaison;
  await saveState(state);
  res.json(state.settings);
});

// ---------- Route : SEMAINE-TYPE ----------

app.get('/api/semaine-type', requireAdmin, async (req, res) => {
  const state = await loadState();
  res.json(state.semaineType || {});
});

app.put('/api/semaine-type', requireAdmin, async (req, res) => {
  const state = await loadState();
  const { cellules } = req.body;
  if (!cellules || typeof cellules !== 'object') return res.status(400).json({ error: 'Cellules manquantes' });
  state.semaineType = state.semaineType || {};
  Object.keys(cellules).forEach((k) => {
    const val = String(cellules[k] || '').trim();
    if (!val) delete state.semaineType[k];
    else state.semaineType[k] = val.toUpperCase();
  });
  await saveState(state);
  res.json(state.semaineType);
});

// ---------- Route : PLANNING (vue calculee d'une semaine + edition ponctuelle) ----------

app.get('/api/planning', requireAdmin, async (req, res) => {
  const state = await loadState();
  const lundi = mondayOf(req.query.lundi || formatDateLocal(new Date()));
  const resultat = grilleSemaine(state, lundi);
  const heures = heuresParEmployeDeGrille(resultat.grille);
  res.json({
    lundi,
    dimanche: addDays(lundi, 6),
    source: resultat.source,
    semaineSpeciale: resultat.semaineSpeciale || null,
    grille: resultat.grille,
    heuresParEmploye: heures
  });
});

// Modifie UNE cellule pour une semaine precise. Si la semaine correspond a
// une semaine speciale, la modification va dans sa grille dediee. Sinon,
// elle est enregistree comme exception ponctuelle (le reste de l'annee
// n'est pas touche).
app.put('/api/planning/cellule', requireAdmin, async (req, res) => {
  const state = await loadState();
  const { lundi, jour, salle, creneau, noms } = req.body;
  if (!lundi || !jour || !salle || !creneau) return res.status(400).json({ error: 'Champs manquants' });
  const lundiReel = mondayOf(lundi);
  const k = cle(jour, salle, creneau);
  const valeur = String(noms || '').trim().toUpperCase();

  const semaineSpeciale = (state.semainesSpeciales || []).find((s) => s.lundi === lundiReel);
  if (semaineSpeciale) {
    semaineSpeciale.grille = semaineSpeciale.grille || {};
    if (!valeur) delete semaineSpeciale.grille[k];
    else semaineSpeciale.grille[k] = valeur;
  } else {
    state.exceptions = state.exceptions || {};
    state.exceptions[lundiReel] = state.exceptions[lundiReel] || {};
    if (!valeur) delete state.exceptions[lundiReel][k];
    else state.exceptions[lundiReel][k] = valeur;
    if (Object.keys(state.exceptions[lundiReel]).length === 0) delete state.exceptions[lundiReel];
  }
  await saveState(state);
  const resultat = grilleSemaine(state, lundiReel);
  res.json({ lundi: lundiReel, source: resultat.source, grille: resultat.grille, heuresParEmploye: heuresParEmployeDeGrille(resultat.grille) });
});

// Reinitialise une semaine normale (supprime ses exceptions ponctuelles,
// revient a la semaine-type).
app.delete('/api/planning/exceptions/:lundi', requireAdmin, async (req, res) => {
  const state = await loadState();
  const lundiReel = mondayOf(req.params.lundi);
  if (state.exceptions) delete state.exceptions[lundiReel];
  await saveState(state);
  res.json({ ok: true });
});

// ---------- Routes : SEMAINES SPECIALES ----------

app.get('/api/semaines-speciales', requireAdmin, async (req, res) => {
  const state = await loadState();
  const liste = [...(state.semainesSpeciales || [])].sort((a, b) => a.lundi.localeCompare(b.lundi));
  res.json(liste);
});

app.post('/api/semaines-speciales', requireAdmin, async (req, res) => {
  const state = await loadState();
  const { description, lundi, type } = req.body;
  if (!description || !lundi || !type) return res.status(400).json({ error: 'Description, semaine et type requis' });
  state.semainesSpeciales = state.semainesSpeciales || [];
  const item = { id: uuidv4(), description, lundi: mondayOf(lundi), type, grille: {} };
  state.semainesSpeciales.push(item);
  await saveState(state);
  res.status(201).json(item);
});

app.delete('/api/semaines-speciales/:id', requireAdmin, async (req, res) => {
  const state = await loadState();
  state.semainesSpeciales = (state.semainesSpeciales || []).filter((s) => s.id !== req.params.id);
  await saveState(state);
  res.json({ ok: true });
});

// ---------- Routes : CONTRATS (donnees sensibles) ----------

app.get('/api/contrats', requireAdmin, async (req, res) => {
  const state = await loadState();
  const liste = [...(state.contrats || [])].sort((a, b) => a.employeeNom.localeCompare(b.employeeNom));
  res.json(liste);
});

app.post('/api/contrats', requireAdmin, async (req, res) => {
  const state = await loadState();
  const { employeeNom, typeContrat, dateDebut, dateFin, heuresHebdoContrat, tauxHoraireBrut, poste, commentaire } = req.body;
  if (!employeeNom || !typeContrat) return res.status(400).json({ error: 'Salarie et type de contrat requis' });
  state.contrats = state.contrats || [];
  const item = {
    id: uuidv4(),
    employeeNom: String(employeeNom).toUpperCase(),
    typeContrat,
    dateDebut: dateDebut || null,
    dateFin: dateFin || null,
    heuresHebdoContrat: heuresHebdoContrat === '' || heuresHebdoContrat === undefined ? null : Number(heuresHebdoContrat),
    tauxHoraireBrut: tauxHoraireBrut === '' || tauxHoraireBrut === undefined ? null : Number(tauxHoraireBrut),
    poste: poste || '',
    commentaire: commentaire || ''
  };
  state.contrats.push(item);
  await saveState(state);
  res.status(201).json(item);
});

app.put('/api/contrats/:id', requireAdmin, async (req, res) => {
  const state = await loadState();
  const c = (state.contrats || []).find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Contrat introuvable' });
  ['employeeNom', 'typeContrat', 'dateDebut', 'dateFin', 'poste', 'commentaire'].forEach((k) => {
    if (req.body[k] !== undefined) c[k] = k === 'employeeNom' ? String(req.body[k]).toUpperCase() : req.body[k];
  });
  if (req.body.heuresHebdoContrat !== undefined) c.heuresHebdoContrat = req.body.heuresHebdoContrat === '' ? null : Number(req.body.heuresHebdoContrat);
  if (req.body.tauxHoraireBrut !== undefined) c.tauxHoraireBrut = req.body.tauxHoraireBrut === '' ? null : Number(req.body.tauxHoraireBrut);
  await saveState(state);
  res.json(c);
});

app.delete('/api/contrats/:id', requireAdmin, async (req, res) => {
  const state = await loadState();
  state.contrats = (state.contrats || []).filter((c) => c.id !== req.params.id);
  await saveState(state);
  res.json({ ok: true });
});

// ---------- Route : TABLEAU DE BORD (comptages sur une periode) ----------

app.get('/api/tableau-bord', requireAdmin, async (req, res) => {
  const state = await loadState();
  const from = req.query.from ? mondayOf(req.query.from) : state.settings.debutSaison;
  const to = req.query.to || state.settings.finSaison;

  const parSalarie = {}; // { NOM: { total, parSalle: {}, parCreneau: {} } }
  let lundiCourant = mondayOf(from);
  let garde = 0;
  while (lundiCourant <= to && garde < 60) {
    garde += 1;
    const { grille } = grilleSemaine(state, lundiCourant);
    Object.keys(grille).forEach((k) => {
      const [, salle, creneau] = k.split('|');
      nomsDeCellule(grille[k]).forEach((nom) => {
        if (!parSalarie[nom]) parSalarie[nom] = { total: 0, parSalle: {}, parCreneau: {} };
        parSalarie[nom].total += 1;
        parSalarie[nom].parSalle[salle] = (parSalarie[nom].parSalle[salle] || 0) + 1;
        parSalarie[nom].parCreneau[creneau] = (parSalarie[nom].parCreneau[creneau] || 0) + 1;
      });
    });
    lundiCourant = addDays(lundiCourant, 7);
  }

  res.json({ from, to, nbSemaines: garde, parSalarie });
});

// ---------- Route : VERIFICATION DES HEURES (planning vs pointages RH_USL) ----------

app.get('/api/verification-heures', requireAdmin, async (req, res) => {
  const state = await loadState();
  const { employeeNom, from, to } = req.query;
  if (!employeeNom || !from || !to) return res.status(400).json({ error: 'Salarie, du et au sont requis' });

  let heuresPointees = {};
  let statutRhUsl = 'ok';
  try {
    const data = await fetchAvecDelai(`${RH_USL_URL}/api/public/heures?from=${from}&to=${to}`, 15000);
    heuresPointees = (data.heures && data.heures[employeeNom.toUpperCase()]) || {};
  } catch (e) {
    statutRhUsl = 'indisponible';
  }

  const jours = [];
  let dateCourante = from;
  let garde = 0;
  while (dateCourante <= to && garde < 400) {
    garde += 1;
    const prevuesH = heuresPrevuesJour(state, employeeNom, dateCourante);
    const pointeesMin = heuresPointees[dateCourante] || 0;
    const pointeesH = +(pointeesMin / 60).toFixed(2);
    jours.push({
      date: dateCourante,
      jour: jourDeDate(dateCourante),
      prevuesHeures: prevuesH,
      pointeesHeures: pointeesH,
      ecartHeures: +(pointeesH - prevuesH).toFixed(2)
    });
    dateCourante = addDays(dateCourante, 1);
  }

  const totalPrevu = jours.reduce((s, j) => s + j.prevuesHeures, 0);
  const totalPointe = jours.reduce((s, j) => s + j.pointeesHeures, 0);

  res.json({
    employeeNom: employeeNom.toUpperCase(),
    from, to, statutRhUsl,
    jours,
    totalPrevu: +totalPrevu.toFixed(2),
    totalPointe: +totalPointe.toFixed(2),
    totalEcart: +(totalPointe - totalPrevu).toFixed(2)
  });
});

// ---------- Route : EXPORT EXCEL (planning individuel a distribuer) ----------

app.get('/api/export/planning-excel', requireAdmin, async (req, res) => {
  const state = await loadState();
  const { employeeNom, from, to } = req.query;
  if (!employeeNom || !from || !to) return res.status(400).json({ error: 'Salarie, du et au sont requis' });
  const cible = employeeNom.trim().toUpperCase();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Planning USL';
  workbook.created = new Date();

  const ORANGE = 'FFFF7B00';
  const NOIR = 'FF1B1B1B';

  const ws = workbook.addWorksheet(`Planning ${cible}`.slice(0, 31));
  ws.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Jour', key: 'jour', width: 12 },
    { header: 'Salle', key: 'salle', width: 16 },
    { header: 'Horaire', key: 'horaire', width: 14 }
  ];
  ws.getRow(1).eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ORANGE } };
    c.font = { bold: true, color: { argb: NOIR }, size: 12 };
  });

  let dateCourante = from;
  let garde = 0;
  let totalHeures = 0;
  while (dateCourante <= to && garde < 400) {
    garde += 1;
    const lundi = mondayOf(dateCourante);
    const jour = jourDeDate(dateCourante);
    const { grille } = grilleSemaine(state, lundi);
    Object.keys(grille)
      .filter((k) => k.startsWith(jour + '|'))
      .sort((a, b) => CRENEAUX.indexOf(a.split('|')[2]) - CRENEAUX.indexOf(b.split('|')[2]))
      .forEach((k) => {
        const [, salle, creneau] = k.split('|');
        if (nomsDeCellule(grille[k]).includes(cible)) {
          ws.addRow({ date: dateCourante, jour, salle, horaire: libelleCreneau(creneau) });
          totalHeures += 1;
        }
      });
    dateCourante = addDays(dateCourante, 1);
  }

  ws.addRow({});
  const totalRow = ws.addRow({ date: '', jour: '', salle: 'TOTAL', horaire: `${totalHeures} h` });
  totalRow.font = { bold: true };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Planning_${cible}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

app.listen(PORT, () => {
  console.log(`Planning USL - serveur demarre sur le port ${PORT}`);
  console.log(`Stockage : ${MONGODB_URI ? 'MongoDB (en ligne)' : 'fichier local data/db.json'}`);
  console.log(`Source RH_USL : ${RH_USL_URL}`);
});
