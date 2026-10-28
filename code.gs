// ============================================
// CONFIGURATION
// ============================================
var CONFIG = {
  SPREADSHEET_ID: '1tzN6IGciGyobtmwVbkugCuMfys2gi6u0vBPBRUDSQdo',
  EMPLOYEE_SHEET_NAME: 'Employe',
  PRESENCE_SHEET_NAME: 'Fiche de présence',
  TIMEZONE: 'Africa/Nairobi'
};

// ============================================
// doGet / doPost — API JSON uniquement
// (le frontend est un site statique séparé : index.html + style.css + script.js,
//  qui appelle cette URL de déploiement via fetch())
// ============================================
function doGet(e) {
  return handleApiRequest(e);
}

function doPost(e) {
  return handleApiRequest(e);
}

function doOptions(e) {
  return createCorsResponse({ success: true, message: 'CORS preflight OK' });
}

function handleApiRequest(e) {
  var params = normalizeRequestData(e);
  var action = resolveAction(params);
  var matricule = String(params.matricule || params.codeQr || params.qr || params.code || '').trim();

  if (!action && !matricule) {
    return createCorsResponse({ success: false, message: 'Aucune action ni matricule fournis.' });
  }

  try {
    switch (action) {
      case 'ping':
        return createCorsResponse({ success: true, message: 'API OK', date: getTodayDate(), heure: getNowTime(), timezone: CONFIG.TIMEZONE });

      case 'ajouter':
      case 'ajout':
        return createCorsResponse(ajouterEmploye(params.matricule, params.nom, params.fonction, params.codeQr || params.code || '-'));

      case 'statut':
        if (!matricule) return createCorsResponse({ success: false, message: 'Matricule manquant' });
        var statut = verifierStatut(matricule);
        return createCorsResponse(statut ? { success: true, data: statut } : { success: false, message: '❌ Matricule non trouvé' });

      case 'entree':
      case 'checkin':
        if (!matricule) return createCorsResponse({ success: false, message: 'Matricule manquant' });
        return createCorsResponse(enregistrerEntree(matricule, params.longitude, params.latitude));

      case 'sortie':
      case 'checkout':
        if (!matricule) return createCorsResponse({ success: false, message: 'Matricule manquant' });
        return createCorsResponse(enregistrerSortie(matricule, params.longitude, params.latitude));

      case 'stats':
      case 'statistiques':
        return createCorsResponse(getStatistiques());

      case 'rapport':
      case 'report':
        return createCorsResponse({ success: true, data: getRapportDuJour() });

      default:
        return createCorsResponse({
          success: false,
          message: 'Action inconnue.',
          actions: ['ping', 'ajouter', 'statut', 'entree', 'sortie', 'stats', 'rapport']
        });
    }
  } catch (error) {
    console.error('Erreur handleApiRequest:', error);
    return createCorsResponse({ success: false, message: 'Erreur serveur: ' + error.toString() });
  }
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

function resolveAction(params) {
  if (!params) return '';
  return String(params.action || params.type || params.endpoint || params.mode || '').toLowerCase();
}

// Note : ContentService ne permet pas de définir des en-têtes CORS custom depuis Apps Script.
// L'appel fonctionne en simple GET/POST sans en-têtes spéciaux, ce qui évite les erreurs de preflight.
function createCorsResponse(payload) {
  var output = ContentService.createTextOutput(JSON.stringify(payload));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
}

// Uniformise une cellule de date (objet Date ou texte) en 'dd/MM/yyyy'.
function formatCellDate(cell) {
  if (cell == null || cell === '') return '';
  if (Object.prototype.toString.call(cell) === '[object Date]') {
    return Utilities.formatDate(cell, CONFIG.TIMEZONE, 'dd/MM/yyyy');
  }
  return String(cell).trim();
}

function getTodayDate() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd/MM/yyyy');
}

function getNowTime() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'HH:mm:ss');
}

// ============================================
// FEUILLES
// ============================================
function getEmployeeSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.EMPLOYEE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.EMPLOYEE_SHEET_NAME);
    sheet.appendRow(['Matricule', 'Nom et Prénoms', 'Fonction', 'Code QR']);
  }
  return sheet;
}

function getPresenceSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.PRESENCE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.PRESENCE_SHEET_NAME);
    sheet.appendRow(["Matricule", "Date d'entrée", "Heure d'entrée", "Date de sortie", "Heure de sortie", "Longitude entrée", "Latitude entrée", "Longitude sortie", "Latitude sortie"]);
  }
  return sheet;
}

function getEmployeeCacheKey(key) {
  var normalizedKey = normalizeText(key).toLowerCase();
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, normalizedKey);
  return 'employee:' + Utilities.base64EncodeWebSafe(digest);
}

function findEmployeeRow(key) {
  try {
    if (!key) return null;
    var cache = null;
    var cacheKey = '';
    try {
      cache = CacheService.getScriptCache();
      cacheKey = getEmployeeCacheKey(key);
      var cachedEmployee = cache.get(cacheKey);
      if (cachedEmployee === '!') return null;
      if (cachedEmployee !== null) {
        try {
          return { row: JSON.parse(cachedEmployee), index: -1 };
        } catch (cacheError) {
          cache.remove(cacheKey);
          console.warn('Cache employé invalide, relecture de la feuille:', cacheError);
        }
      }
    } catch (cacheError) {
      cache = null;
      console.warn('Cache employé indisponible, relecture de la feuille:', cacheError);
    }

    var sheet = getEmployeeSheet();
    var data = sheet.getDataRange().getValues();
    var targetLower = normalizeText(key).toLowerCase();

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var matricule = row[0] ? normalizeText(row[0]) : '';
      var codeQr = row[3] ? normalizeText(row[3]) : '';
      if (matricule.toLowerCase() === targetLower || (codeQr && codeQr.toLowerCase() === targetLower)) {
        if (cache) {
          try {
            cache.put(cacheKey, JSON.stringify(row.slice(0, 4)), 120);
          } catch (cacheError) {
            console.warn('Mise en cache employé impossible:', cacheError);
          }
        }
        return { row: row, index: i };
      }
    }
    if (cache) {
      try {
        cache.put(cacheKey, '!', 30);
      } catch (cacheError) {
        console.warn('Mise en cache de la recherche impossible:', cacheError);
      }
    }
    return null;
  } catch (e) {
    console.error('Erreur findEmployeeRow:', e);
    return null;
  }
}

function getEmployeeByMatricule(matricule) {
  var found = findEmployeeRow(matricule);
  if (!found) return null;
  return { matricule: found.row[0], nom: found.row[1] || '', fonction: found.row[2] || '', codeQr: found.row[3] || '' };
}

function getTodayPresenceIndex(sheet, today) {
  var cache = null;
  var cacheKey = 'presence:' + today.replace(/\D/g, '');
  try {
    cache = CacheService.getScriptCache();
    var cachedIndex = cache.get(cacheKey);
    if (cachedIndex !== null) {
      try {
        var parsedIndex = JSON.parse(cachedIndex);
        if (parsedIndex && typeof parsedIndex === 'object' && !Array.isArray(parsedIndex)) {
          return { index: parsedIndex, cache: cache, cacheKey: cacheKey };
        }
        cache.remove(cacheKey);
      } catch (cacheError) {
        cache.remove(cacheKey);
        console.warn('Cache des présences invalide, relecture de la feuille:', cacheError);
      }
    }
  } catch (cacheError) {
    cache = null;
    console.warn('Cache des présences indisponible, relecture de la feuille:', cacheError);
  }

  var index = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var data = sheet.getRange(1, 1, lastRow, 5).getValues();
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var matricule = normalizeText(row[0]);
      if (!matricule) continue;

      var dateEntree = formatCellDate(row[1]);
      var dateSortie = formatCellDate(row[3]);
      if (dateEntree !== today && dateSortie !== today) continue;

      var key = '$' + matricule;
      var employeePresence = index[key] || { openRows: [], hasCompletedExit: false, lastExitTime: '' };
      if (dateEntree === today && dateSortie === '') {
        employeePresence.openRows.push({ row: i + 1, heure: row[2] || '' });
      }
      if (dateEntree === today && dateSortie === today) {
        employeePresence.hasCompletedExit = true;
        employeePresence.lastExitTime = row[4] || '';
      }
      index[key] = employeePresence;
    }
  }

  var snapshot = { index: index, cache: cache, cacheKey: cacheKey };
  saveTodayPresenceIndex(snapshot);
  return snapshot;
}

function saveTodayPresenceIndex(snapshot) {
  if (!snapshot.cache) return;
  try {
    snapshot.cache.put(snapshot.cacheKey, JSON.stringify(snapshot.index), 120);
  } catch (cacheError) {
    console.warn('Mise en cache des présences impossible:', cacheError);
  }
}

// ============================================
// STATUT DU JOUR
// ============================================
function verifierStatut(matricule) {
  try {
    var employee = findEmployeeRow(matricule);
    if (!employee) return null;

    var sheet = getPresenceSheet();
    var data = sheet.getRange(1, 1, sheet.getLastRow(), 5).getValues();
    var today = getTodayDate();
    var normalizedMatricule = normalizeText(employee.row[0]);
    var openRow = null;
    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      if (normalizeText(row[0]) === normalizedMatricule && formatCellDate(row[1]) === today && formatCellDate(row[3]) === '') {
        openRow = row;
        break;
      }
    }

    return {
      matricule: employee.row[0],
      nom: employee.row[1] || '',
      fonction: employee.row[2] || '',
      codeQr: employee.row[3] || '',
      estPresent: !!openRow,
      heureEntree: openRow ? (openRow[2] || '') : ''
    };
  } catch (error) {
    console.error('Erreur verifierStatut:', error);
    return null;
  }
}

// ============================================
// ENTRÉE — écrit dans Date d'entrée / Heure d'entrée.
// Une seconde entrée le même jour (tant que la sortie n'est pas faite) est bloquée.
// ============================================
function enregistrerEntree(matricule, longitude, latitude) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, message: 'Le système est occupé, réessayez.' };
  }

  try {
    if (!matricule) return { success: false, message: 'Matricule manquant' };

    var employee = findEmployeeRow(matricule);
    if (!employee) return { success: false, message: '❌ Matricule non trouvé dans la base Employé' };

    var sheet = getPresenceSheet();
    var today = getTodayDate();
    var presenceSnapshot = getTodayPresenceIndex(sheet, today);
    var presenceKey = '$' + normalizeText(employee.row[0]);
    var employeePresence = presenceSnapshot.index[presenceKey];
    if (!employeePresence || Object.prototype.toString.call(employeePresence.openRows) !== '[object Array]') {
      employeePresence = { openRows: [], hasCompletedExit: false, lastExitTime: '' };
    }
    if (employeePresence.openRows.length) {
      return {
        success: false,
        message: (employee.row[1] || 'Cette personne') + ' est déjà enregistrée (entrée à ' + (employeePresence.openRows[0].heure || '') + ')',
        matricule: employee.row[0],
        nom: employee.row[1] || ''
      };
    }

    var now = new Date();
    var dateStr = Utilities.formatDate(now, CONFIG.TIMEZONE, 'dd/MM/yyyy');
    var heureStr = Utilities.formatDate(now, CONFIG.TIMEZONE, 'HH:mm:ss');
    var lonVal = normalizeCoord(longitude);
    var latVal = normalizeCoord(latitude);
    // Colonnes : Matricule / Date entrée / Heure entrée / Date sortie / Heure sortie / Longitude entrée / Latitude entrée / Longitude sortie / Latitude sortie
    sheet.appendRow([employee.row[0], dateStr, heureStr, '', '', lonVal, latVal, '', '']);

    var nouvelleLigne = sheet.getLastRow();
    employeePresence.openRows.push({ row: nouvelleLigne, heure: heureStr });
    presenceSnapshot.index[presenceKey] = employeePresence;
    saveTodayPresenceIndex(presenceSnapshot);

    // Empêche Sheets d'hériter le format "Heure" des colonnes voisines sur les cellules GPS.
    sheet.getRange(nouvelleLigne, 6, 1, 2).setNumberFormat('0.000000');

    return {
      success: true,
      message: 'Entrée enregistrée',
      matricule: employee.row[0],
      nom: employee.row[1] || '',
      fonction: employee.row[2] || '',
      date: dateStr,
      heure: heureStr,
      longitude: lonVal,
      latitude: latVal
    };
  } catch (error) {
    console.error('Erreur enregistrerEntree:', error);
    return { success: false, message: 'Erreur: ' + error.toString() };
  } finally {
    lock.releaseLock();
  }
}

// Convertit en nombre valide, ou '' si absent/invalide (coordonnée non fournie).
function normalizeCoord(value) {
  if (value === undefined || value === null || value === '') return '';
  var num = parseFloat(value);
  return isNaN(num) ? '' : num;
}

// ============================================
// SORTIE — écrit dans Date de sortie / Heure de sortie,
// même si aucune entrée n'a été enregistrée aujourd'hui.
// ============================================
function enregistrerSortie(matricule, longitude, latitude) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, message: 'Le système est occupé, réessayez.' };
  }

  try {
    if (!matricule) return { success: false, message: 'Matricule manquant' };

    var employee = findEmployeeRow(matricule);
    if (!employee) return { success: false, message: '❌ Matricule non trouvé dans la base Employé' };

    var sheet = getPresenceSheet();
    var today = getTodayDate();
    var presenceSnapshot = getTodayPresenceIndex(sheet, today);
    var presenceKey = '$' + normalizeText(employee.row[0]);
    var employeePresence = presenceSnapshot.index[presenceKey];
    if (!employeePresence || Object.prototype.toString.call(employeePresence.openRows) !== '[object Array]') {
      employeePresence = { openRows: [], hasCompletedExit: false, lastExitTime: '' };
    }
    var now = new Date();
    var dateStr = Utilities.formatDate(now, CONFIG.TIMEZONE, 'dd/MM/yyyy');
    var heureStr = Utilities.formatDate(now, CONFIG.TIMEZONE, 'HH:mm:ss');
    var lonVal = normalizeCoord(longitude);
    var latVal = normalizeCoord(latitude);

    // 1) Ligne d'entrée du jour encore ouverte (sortie vide) -> on la complète.
    if (employeePresence.openRows.length) {
      var targetRowIndex = employeePresence.openRows[employeePresence.openRows.length - 1].row;
      sheet.getRange(targetRowIndex, 4).setValue(dateStr);
      sheet.getRange(targetRowIndex, 5).setValue(heureStr);
      employeePresence.openRows.pop();
      employeePresence.hasCompletedExit = true;
      employeePresence.lastExitTime = heureStr;
      presenceSnapshot.index[presenceKey] = employeePresence;
      saveTodayPresenceIndex(presenceSnapshot);
      // Colonnes 8/9 = Longitude sortie / Latitude sortie — indépendantes de la position d'entrée (colonnes 6/7).
      // setNumberFormat AVANT setValue pour empêcher Sheets d'afficher le nombre comme une heure.
      sheet.getRange(targetRowIndex, 8, 1, 2).setNumberFormat('0.000000');
      sheet.getRange(targetRowIndex, 8).setValue(lonVal);
      sheet.getRange(targetRowIndex, 9).setValue(latVal);
      return {
        success: true,
        message: 'Sortie enregistrée',
        matricule: employee.row[0],
        nom: employee.row[1] || '',
        fonction: employee.row[2] || '',
        date: dateStr,
        heure: heureStr,
        longitude: lonVal,
        latitude: latVal
      };
    }

    // 2) Pas d'entrée ouverte : on refuse seulement une 2e sortie le même jour.
    if (employeePresence.hasCompletedExit) {
      return {
        success: false,
        message: (employee.row[1] || 'Cette personne') + ' a déjà validé la sortie aujourd\'hui (' + (employeePresence.lastExitTime || '') + ')',
        matricule: employee.row[0],
        nom: employee.row[1] || ''
      };
    }

    // 3) Sinon : sortie seule, entrée laissée vide.
    // Colonnes : Matricule / Date entrée / Heure entrée / Date sortie / Heure sortie / Longitude entrée / Latitude entrée / Longitude sortie / Latitude sortie
    sheet.appendRow([employee.row[0], '', '', dateStr, heureStr, '', '', lonVal, latVal]);

    var nouvelleLigneSortie = sheet.getLastRow();

    // Empêche Sheets d'hériter le format "Heure" des colonnes voisines sur les cellules GPS.
    sheet.getRange(nouvelleLigneSortie, 8, 1, 2).setNumberFormat('0.000000');

    return {
      success: true,
      message: 'Sortie enregistrée',
      matricule: employee.row[0],
      nom: employee.row[1] || '',
      fonction: employee.row[2] || '',
      date: dateStr,
      heure: heureStr,
      longitude: lonVal,
      latitude: latVal
    };
  } catch (error) {
    console.error('Erreur enregistrerSortie:', error);
    return { success: false, message: 'Erreur: ' + error.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ============================================
// STATISTIQUES DU JOUR
// ============================================
function getStatistiques() {
  try {
    var employeeData = getEmployeeSheet().getDataRange().getValues();
    var total = 0;
    for (var i = 1; i < employeeData.length; i++) {
      if (employeeData[i][0] && employeeData[i][0] !== '') total++;
    }

    var presenceData = getPresenceSheet().getDataRange().getValues();
    var today = getTodayDate();
    var present = 0;
    var seen = {};

    for (var j = 1; j < presenceData.length; j++) {
      var row = presenceData[j];
      var matricule = normalizeText(row[0]);
      if (!matricule) continue;
      if (formatCellDate(row[1]) === today && formatCellDate(row[3]) === '' && !seen[matricule]) {
        seen[matricule] = true;
        present++;
      }
    }

    return { success: true, total: total, present: present, absent: total - present, aujourdhui: today };
  } catch (error) {
    console.error('Erreur getStatistiques:', error);
    return { success: false, total: 0, present: 0, absent: 0 };
  }
}

// ============================================
// JOURNAL DU JOUR
// ============================================
function getRapportDuJour() {
  try {
    var data = getPresenceSheet().getDataRange().getValues();
    var rapport = [];
    var today = getTodayDate();

    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      var matricule = normalizeText(row[0]);
      if (!matricule) continue;

      var dateEntree = formatCellDate(row[1]);
      var dateSortie = formatCellDate(row[3]);

      if (dateEntree === today || dateSortie === today) {
        var employee = getEmployeeByMatricule(matricule) || { nom: '', fonction: '' };
        rapport.push({
          matricule: matricule,
          nom: employee.nom || '',
          fonction: employee.fonction || '',
          heureEntree: dateEntree === today ? (row[2] || '') : '',
          heureSortie: dateSortie === today ? (row[4] || '') : '',
          present: (dateEntree === today && dateSortie === '')
        });
      }
    }
    return rapport;
  } catch (error) {
    console.error('Erreur getRapportDuJour:', error);
    return [];
  }
}

// ============================================
// AJOUT D'UN COLLABORATEUR
// ============================================
function ajouterEmploye(matricule, nom, fonction, codeQr) {
  try {
    matricule = String(matricule || '').trim();
    nom = String(nom || '').trim();
    fonction = String(fonction || '').trim();
    codeQr = String(codeQr || '-').trim();
    var codeQrValide = (codeQr && codeQr !== '-') ? codeQr : '';

    if (!matricule || !nom || !fonction) {
      return { success: false, message: 'Matricule, nom et fonction sont obligatoires.' };
    }
    if (findEmployeeRow(matricule) || (codeQrValide && findEmployeeRow(codeQrValide))) {
      return { success: false, message: 'Ce collaborateur existe déjà dans la base.' };
    }

    getEmployeeSheet().appendRow([matricule, nom, fonction, codeQr]);
    try {
      var employeeCache = CacheService.getScriptCache();
      employeeCache.remove(getEmployeeCacheKey(matricule));
      if (codeQrValide) employeeCache.remove(getEmployeeCacheKey(codeQrValide));
    } catch (cacheError) {
      console.warn('Invalidation du cache employé impossible:', cacheError);
    }

    return { success: true, message: 'Collaborateur ajouté avec succès', matricule: matricule, nom: nom, fonction: fonction, codeQr: codeQr };
  } catch (error) {
    console.error('Erreur ajouterEmploye:', error);
    return { success: false, message: 'Erreur: ' + error.toString() };
  }
}

function testConnexion() {
  try {
    var sheet = getEmployeeSheet();
    return { success: true, message: 'Connexion réussie', nomFeuille: sheet.getName(), nbLignes: sheet.getLastRow() };
  } catch (error) {
    return { success: false, message: 'Erreur: ' + error.toString() };
  }
}