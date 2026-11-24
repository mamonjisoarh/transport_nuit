// ============================================
// CONFIGURATION
// ============================================
var CONFIG = {
  SPREADSHEET_ID: '1tzN6IGciGyobtmwVbkugCuMfys2gi6u0vBPBRUDSQdo',
  EMPLOYEE_SHEET_NAME: 'Employe',
  PRESENCE_SHEET_NAME: 'Fiche de présence',
  TIMEZONE: 'Africa/Nairobi',
  EMPLOYEE_CACHE_TTL: 21600,          // 6 h (rafraîchi toutes les 5 min par le déclencheur)
  EMPLOYEE_REFRESH_ON_MISS_MS: 60000  // matricule inconnu : relit la feuille si le cache a plus d'1 min
};

var EMP_CACHE_KEY = 'emp:v4';
var CHUNK_SIZE = 30000; // CacheService : 100 Ko max par valeur -> on découpe

// Mémoire d'une exécution (une requête)
var _ss = null;
var _sheets = {};
var _cache;
var _empDir = null;
var _empFresh = false;

// ============================================
// API JSON (doGet / doPost)
// ============================================
function doGet(e) { return handleApiRequest(e); }
function doPost(e) { return handleApiRequest(e); }

function handleApiRequest(e) {
  var t0 = Date.now();
  var params = normalizeRequestData(e);
  var action = String(params.action || params.type || params.endpoint || params.mode || '').toLowerCase();
  var matricule = String(params.matricule || params.codeQr || params.qr || params.code || '').trim();

  var result;
  try {
    switch (action) {
      case 'ping':
        result = { success: true, message: 'API OK' };
        break;
      case 'warmup':
        result = { success: true, message: 'Prêt', employes: Object.keys(loadEmployees().m).length };
        break;
      case 'pointer':
      case 'entree':
      case 'checkin':
      case 'sortie':
      case 'checkout':
        result = enregistrerPointage(matricule, params.accompagnement);
        break;
      case 'ajouter':
      case 'ajout':
        result = ajouterEmploye(params.matricule, params.nom, params.fonction, params.codeQr || params.code || '-');
        break;
      default:
        result = { success: false, message: 'Action inconnue.', actions: ['ping', 'warmup', 'pointer', 'ajouter'] };
    }
  } catch (error) {
    console.error('Erreur handleApiRequest:', error);
    result = { success: false, message: 'Erreur serveur: ' + error.toString() };
  }
  result.ms = Date.now() - t0; // durée côté serveur, utile pour diagnostiquer
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function normalizeRequestData(e) {
  var data = {};
  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function (key) { data[key] = e.parameter[key]; });
  }
  if (e && e.postData && e.postData.contents) {
    try {
      var parsed = JSON.parse(e.postData.contents);
      if (parsed && typeof parsed === 'object') {
        Object.keys(parsed).forEach(function (key) { data[key] = parsed[key]; });
      }
    } catch (err) { /* JSON invalide, on ignore */ }
  }
  return data;
}

// ============================================
// OUTILS
// ============================================
function normalizeText(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
}

function isChecked(value) {
  return value === true || /^(true|1|oui)$/i.test(String(value == null ? '' : value).trim());
}

// ============================================
// CACHE (valeurs découpées en blocs pour dépasser la limite de 100 Ko)
// ============================================
function getCache() {
  if (_cache === undefined) {
    try { _cache = CacheService.getScriptCache(); } catch (e) { _cache = null; }
  }
  return _cache;
}

function cachePutBig(key, str, ttl) {
  var cache = getCache();
  if (!cache) return;
  try {
    var n = Math.max(1, Math.ceil(str.length / CHUNK_SIZE));
    var batch = {};
    for (var i = 0; i < n; i++) batch[key + '#' + i] = str.substr(i * CHUNK_SIZE, CHUNK_SIZE);
    batch[key + '#n'] = String(n);
    cache.putAll(batch, ttl);
  } catch (e) {
    console.warn('Mise en cache impossible:', e);
  }
}

function cacheGetBig(key) {
  var cache = getCache();
  if (!cache) return null;
  try {
    var head = cache.get(key + '#n');
    if (head === null) return null;
    var n = parseInt(head, 10);
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(key + '#' + i);
    var parts = cache.getAll(keys);
    var out = '';
    for (var j = 0; j < n; j++) {
      var part = parts[key + '#' + j];
      if (part === undefined || part === null) return null;
      out += part;
    }
    return out;
  } catch (e) {
    return null;
  }
}

// ============================================
// FEUILLES (le classeur n'est ouvert qu'une fois par requête)
// ============================================
function getSS() {
  if (!_ss) _ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  return _ss;
}

function getEmployeeSheet() {
  if (_sheets.emp) return _sheets.emp;
  var ss = getSS();
  var sheet = ss.getSheetByName(CONFIG.EMPLOYEE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.EMPLOYEE_SHEET_NAME);
    sheet.appendRow(['Matricule', 'Nom et Prénoms', 'Fonction', 'Code QR']);
  }
  _sheets.emp = sheet;
  return sheet;
}

function getPresenceSheet() {
  if (_sheets.pres) return _sheets.pres;
  var ss = getSS();
  var sheet = ss.getSheetByName(CONFIG.PRESENCE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.PRESENCE_SHEET_NAME);
    sheet.appendRow(['Matricule', 'Date', 'Accompagnement']);
  } else if (!sheet.getRange(1, 3).getValue()) {
    sheet.getRange(1, 3).setValue('Accompagnement');
  }
  _sheets.pres = sheet;
  return sheet;
}

// ============================================
// ANNUAIRE DES EMPLOYÉS (1 seule entrée de cache, recherche instantanée)
// { m: { matriculeMinuscule: [matricule, nom, fonction, codeQr] }, q: { codeQrMinuscule: matriculeMinuscule }, t: horodatage }
// ============================================
function buildEmployeeDirectory() {
  var sheet = getEmployeeSheet();
  var last = sheet.getLastRow();
  var dir = { m: {}, q: {}, t: Date.now() };
  if (last > 1) {
    var data = sheet.getRange(2, 1, last - 1, 4).getValues();
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      var mat = normalizeText(r[0]);
      if (!mat) continue;
      var low = mat.toLowerCase();
      var qr = normalizeText(r[3]);
      dir.m[low] = [mat, normalizeText(r[1]), normalizeText(r[2]), qr];
      if (qr && qr !== '-') dir.q[qr.toLowerCase()] = low;
    }
  }
  return dir;
}

function loadEmployees(force) {
  if (_empDir && !force) return _empDir;
  if (!force) {
    var s = cacheGetBig(EMP_CACHE_KEY);
    if (s) {
      try {
        _empDir = JSON.parse(s);
        _empFresh = false;
        return _empDir;
      } catch (e) { /* cache invalide : on relit la feuille */ }
    }
  }
  _empDir = buildEmployeeDirectory();
  _empFresh = true;
  cachePutBig(EMP_CACHE_KEY, JSON.stringify(_empDir), CONFIG.EMPLOYEE_CACHE_TTL);
  return _empDir;
}

function lookupEmployee(dir, low) {
  var row = dir.m[low];
  if (!row && dir.q[low]) row = dir.m[dir.q[low]];
  if (!row) return null;
  return { matricule: row[0], nom: row[1] || '', fonction: row[2] || '', codeQr: row[3] || '' };
}

// Trouve un employé par matricule OU par code QR.
function findEmployee(key) {
  var low = normalizeText(key).toLowerCase();
  if (!low) return null;
  var emp = lookupEmployee(loadEmployees(), low);
  // Introuvable : le cache est peut-être périmé (ajout manuel dans la feuille) -> une relecture si > 1 min.
  if (!emp && !_empFresh && _empDir && (Date.now() - (_empDir.t || 0)) > CONFIG.EMPLOYEE_REFRESH_ON_MISS_MS) {
    emp = lookupEmployee(loadEmployees(true), low);
  }
  return emp;
}

// ============================================
// POINTAGE — chaque scan ajoute une ligne : Matricule | Date/heure | Accompagnement.
// Aucune vérification dans la feuille de présence (pas de contrôle de doublon).
// ============================================
function enregistrerPointage(matricule, accompagnement) {
  if (!matricule) return { success: false, message: 'Matricule manquant' };

  var employee = findEmployee(matricule); // lecture dans le cache uniquement
  if (!employee) return { success: false, message: '❌ Matricule non trouvé dans la base Employé' };

  var avecAccompagnement = isChecked(accompagnement);
  var timestamp = new Date();
  var date = Utilities.formatDate(timestamp, CONFIG.TIMEZONE, 'dd/MM/yyyy');
  var heure = Utilities.formatDate(timestamp, CONFIG.TIMEZONE, 'HH:mm:ss');
  var sheet = getPresenceSheet();
  sheet.appendRow([employee.matricule, timestamp, avecAccompagnement]);
  var row = sheet.getLastRow();
  sheet.getRange(row, 2).setNumberFormat('dd/MM/yyyy HH:mm:ss');
  sheet.getRange(row, 3).insertCheckboxes().setValue(avecAccompagnement);

  return {
    success: true,
    message: 'Enregistré',
    matricule: employee.matricule,
    nom: employee.nom,
    date: date,
    heure: heure,
    accompagnement: avecAccompagnement
  };
}

// ============================================
// AJOUT D'UN COLLABORATEUR
// ============================================
function ajouterEmploye(matricule, nom, fonction, codeQr) {
  matricule = normalizeText(matricule);
  nom = normalizeText(nom);
  fonction = normalizeText(fonction);
  codeQr = normalizeText(codeQr || '-');
  var codeQrValide = (codeQr && codeQr !== '-') ? codeQr : '';

  if (!matricule || !nom || !fonction) {
    return { success: false, message: 'Matricule, nom et fonction sont obligatoires.' };
  }

  var dir = loadEmployees(true); // lecture fraîche avant de tester les doublons
  var low = matricule.toLowerCase();
  if (lookupEmployee(dir, low) || (codeQrValide && lookupEmployee(dir, codeQrValide.toLowerCase()))) {
    return { success: false, message: 'Ce collaborateur existe déjà dans la base.' };
  }

  getEmployeeSheet().appendRow([matricule, nom, fonction, codeQr]);

  // Utilisable immédiatement : on met l'annuaire en cache à jour.
  dir.m[low] = [matricule, nom, fonction, codeQrValide];
  if (codeQrValide) dir.q[codeQrValide.toLowerCase()] = low;
  cachePutBig(EMP_CACHE_KEY, JSON.stringify(dir), CONFIG.EMPLOYEE_CACHE_TTL);

  return { success: true, message: 'Collaborateur ajouté avec succès', matricule: matricule, nom: nom, fonction: fonction, codeQr: codeQr };
}

// ============================================
// MAINTENANCE
// ============================================

// Exécuté toutes les 5 minutes par le déclencheur : garde l'annuaire en cache à jour
// (prend en compte les modifications faites à la main dans la feuille "Employe").
function prechauffer() {
  loadEmployees(true);
}

// À EXÉCUTER UNE SEULE FOIS depuis l'éditeur Apps Script (▶ Exécuter) :
// crée le déclencheur "toutes les 5 minutes".
function configurationInitiale() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'prechauffer') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('prechauffer').timeBased().everyMinutes(5).create();
  prechauffer();
  return 'Configuration terminée';
}

function testConnexion() {
  try {
    var sheet = getEmployeeSheet();
    return { success: true, message: 'Connexion réussie', nomFeuille: sheet.getName(), nbLignes: sheet.getLastRow() };
  } catch (error) {
    return { success: false, message: 'Erreur: ' + error.toString() };
  }
}
