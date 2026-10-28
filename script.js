// Frontend pour API Apps Script uniquement (fetch, pas de google.script.run).
;(function () {
    var html5QrCode = null;
    var currentFacingMode = 'environment'; // caméra arrière par défaut
    var isBusy = false; // vrai pendant le traitement d'un scan (évite les doublons)
    var isRunning = false; // vrai tant que la caméra scanne activement
    var selectedMode = 'entree';
    var API_URL = (typeof window !== 'undefined' && window.API_URL) || 'https://script.google.com/macros/s/AKfycbyOxdO-lFIda9y6fVTpan5ZPvPPaTgLmLPwkmwzK1Y2F_ex-cvMlVSYGPBtjY5Of8KK/exec';
    var config = { fps: 12, qrbox: { width: 250, height: 250 } };

    function setMode(mode) {
        selectedMode = (mode === 'sortie') ? 'sortie' : 'entree';
        var buttons = document.querySelectorAll('.mode-btn');
        buttons.forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-mode') === selectedMode);
        });
    }

    function getModeLabel() {
        return selectedMode === 'sortie' ? 'Sortie' : 'Entrée';
    }

    function updateStatus(text) {
        var el = document.getElementById('scan-status');
        if (el) el.textContent = text;
    }

    // ============================================
    // Caméra — API bas niveau Html5Qrcode : démarrage direct, pas de
    // panneau intermédiaire (permission/select/start) à manipuler.
    // ============================================
    function demarrerScanner() {
        if (typeof Html5Qrcode === 'undefined') {
            document.getElementById('reader').innerHTML = '<div style="padding:20px;color:#ef4444;text-align:center;">Bibliothèque QR introuvable</div>';
            afficherPanneCamera();
            return;
        }

        if (!html5QrCode) {
            html5QrCode = new Html5Qrcode('reader', /* verbose= */ false);
        }

        updateStatus('Démarrage de la caméra…');
        html5QrCode.start({ facingMode: currentFacingMode }, config, onScanSuccess, onScanError)
            .then(function () {
                isRunning = true;
                updateStatus('Prêt — présentez un QR code');
                document.getElementById('permission-info').hidden = true;
                detecterPlusieursCameras();
                majBoutonToggle();
            })
            .catch(function (err) {
                handleCameraError(err);
            });
    }

    // ============================================
    // Bouton Arrêter / Démarrer le scan — utile si l'interface semble bloquée
    // ou si on veut couper la caméra sans quitter la page.
    // ============================================
    function majBoutonToggle() {
        var btn = document.getElementById('btn-toggle-scan');
        if (!btn) return;
        if (isRunning) {
            btn.textContent = '⏹ Arrêter le scan';
            btn.classList.add('btn-icon--stop');
        } else {
            btn.textContent = '▶ Démarrer le scan';
            btn.classList.remove('btn-icon--stop');
        }
    }

    function toggleScan() {
        if (isRunning) {
            isRunning = false;
            updateStatus('Scanner arrêté');
            majBoutonToggle();
            if (html5QrCode) {
                html5QrCode.stop().catch(function () {});
            }
        } else {
            majBoutonToggle();
            demarrerScanner();
        }
    }

    function detecterPlusieursCameras() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        navigator.mediaDevices.enumerateDevices().then(function (devices) {
            var camCount = devices.filter(function (d) { return d.kind === 'videoinput'; }).length;
            var btn = document.getElementById('btn-switch-camera');
            if (btn) btn.hidden = camCount < 2;
        }).catch(function () {});
    }

    function changerCamera() {
        if (!html5QrCode) return;
        updateStatus('Changement de caméra…');
        html5QrCode.stop().then(function () {
            currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
            demarrerScanner();
        }).catch(function () {
            currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
            demarrerScanner();
        });
    }

    function handleCameraError(err) {
        var s = String((err && err.message) || err || '');
        isRunning = false;
        majBoutonToggle();
        updateStatus('Caméra indisponible');
        afficherPanneCamera();
        console.debug('Erreur caméra:', s);
    }

    function afficherPanneCamera() {
        var info = document.getElementById('permission-info');
        if (info) info.hidden = false;
    }

    // Le QR est généré au format "| MATRICULE | NOM |" (pipe en tête et en fin).
    // On découpe par "|", on retire les segments vides/espaces, et on garde le premier
    // segment non vide restant — c'est le matricule, quel que soit le nombre de pipes.
    function extraireMatricule(decodedText) {
        var texte = (decodedText || '').toString();
        var segments = texte.split('|')
            .map(function (s) { return s.trim(); })
            .filter(function (s) { return s !== ''; });
        return segments.length ? segments[0] : texte.trim();
    }

    function onScanSuccess(decodedText) {
        if (isBusy) return; // ignore les détections répétées pendant le traitement en cours
        isBusy = true;

        try { html5QrCode.pause(true); } catch (e) {}
        updateStatus('Scan détecté…');

        var matricule = extraireMatricule(decodedText);
        traiterMatricule(matricule, reprendreScanApresDelai);
    }

    function reprendreScanApresDelai() {
        setTimeout(function () {
            try {
                html5QrCode.resume();
                updateStatus('Prêt — présentez un QR code');
            } catch (e) {}
            isBusy = false;
        }, 900); // juste assez pour lire le résultat, sans ralentir la file d'attente
    }

    function onScanError() {
        // Erreurs de lecture image par image (aucun QR dans le cadre) : ignorées volontairement,
        // la librairie les déclenche en continu tant qu'elle ne détecte rien — inutile de les traiter.
    }

    // ============================================
    // Géolocalisation — on ne demande PLUS la position à chaque scan (ça pouvait
    // prendre plusieurs secondes et ralentir toute la file d'attente). On la
    // récupère une seule fois en tâche de fond avec watchPosition() et on
    // réutilise la dernière valeur connue, lue instantanément à chaque scan.
    // ============================================
    var positionActuelle = { longitude: '', latitude: '' };
    var watchId = null;

    function demarrerSuiviPosition() {
        if (!navigator.geolocation) {
            majStatutPosition('indisponible (navigateur)');
            return;
        }
        if (window.isSecureContext === false) {
            // La géolocalisation est bloquée par le navigateur hors HTTPS/localhost.
            majStatutPosition('bloquée (site non HTTPS)');
            return;
        }
        majStatutPosition('en attente…');
        // Demande une première position immédiatement ; le suivi conserve ensuite
        // la dernière position connue sans ralentir la vérification du QR.
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                positionActuelle = { longitude: pos.coords.longitude, latitude: pos.coords.latitude };
                majStatutPosition('active');
            },
            function () {},
            { enableHighAccuracy: false, maximumAge: 60000, timeout: 4000 }
        );
        watchId = navigator.geolocation.watchPosition(
            function (pos) {
                positionActuelle = { longitude: pos.coords.longitude, latitude: pos.coords.latitude };
                majStatutPosition('active');
            },
            function (err) {
                // refusé ou indisponible : on garde '' et on continue le pointage sans position
                var raison = (err && err.code === 1) ? 'refusée par l\'utilisateur' : (err && err.code === 2) ? 'position indisponible' : 'délai dépassé';
                majStatutPosition(raison);
                console.debug('Erreur géolocalisation:', err);
            },
            { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 }
        );
    }

    function majStatutPosition(texte) {
        var el = document.getElementById('position-status');
        if (el) el.textContent = '📍 Position : ' + texte;
    }

    // ============================================
    // Le mode sélectionné détermine uniquement la colonne visée côté backend.
    // Entrée -> Date/Heure d'entrée (bloqué si déjà fait aujourd'hui).
    // Sortie -> Date/Heure de sortie, même sans entrée préalable.
    // ============================================
    function traiterMatricule(matricule, onDone) {
        if (!matricule) {
            afficherErreur('Veuillez saisir un matricule ou scanner un QR valide.');
            if (onDone) onDone();
            return;
        }

        document.getElementById('result').innerHTML =
            '<div class="result-card"><div class="result-header"><span id="result-icon">⏳</span>' +
            '<h2 id="result-title" style="color:#1d4ed8;">Vérification...</h2></div>' +
            '<div style="color:#1d4ed8; font-weight:600; text-align:center;">Mode : ' + getModeLabel() + '</div></div>';

        var action = selectedMode === 'entree' ? 'entree' : 'sortie';

        callApi(action, matricule, positionActuelle, function (response) {
            handleResult(response, getModeLabel().toLowerCase());
            if (onDone) onDone();
        }, function (error) {
            afficherErreur('Erreur API: ' + (error && error.message ? error.message : 'Impossible de contacter le backend'));
            if (onDone) onDone();
        });
    }

    function callApi(action, matricule, position, onSuccess, onError) {
        if (!API_URL) {
            if (onError) onError({ message: 'Configurez window.API_URL dans index.html.' });
            return;
        }
        var url = API_URL + '?action=' + encodeURIComponent(action) + '&matricule=' + encodeURIComponent(matricule);
        if (position && position.longitude !== '' && position.latitude !== '') {
            url += '&longitude=' + encodeURIComponent(position.longitude) + '&latitude=' + encodeURIComponent(position.latitude);
        }

        // Coupe-circuit : si le réseau/Apps Script met trop de temps à répondre, on
        // affiche un message clair au lieu de laisser "Vérification..." indéfiniment.
        // Note : le pointage peut malgré tout avoir été enregistré côté serveur avant
        // l'expiration de ce délai — seule la réponse au navigateur a été trop lente.
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var delaiDepasse = false;
        var timer = controller ? setTimeout(function () {
            delaiDepasse = true;
            controller.abort();
        }, 7000) : null;

        fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined })
            .then(function (response) {
                if (timer) clearTimeout(timer);
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (data) { if (onSuccess) onSuccess(data || {}); })
            .catch(function (error) {
                if (timer) clearTimeout(timer);
                if (delaiDepasse) {
                    if (onError) onError({ message: 'Le serveur met trop de temps à répondre. Le pointage a peut-être quand même été enregistré — vérifiez la feuille si besoin.' });
                } else {
                    if (onError) onError(error);
                }
            });
    }

    function handleResult(result, type) {
        if (result && result.success) {
            afficherSucces(result, type);
        } else {
            afficherErreur((result && result.message) ? result.message : 'Erreur inconnue');
        }
    }

    function afficherSucces(result, type) {
        var icon = type === 'entrée' ? '✅' : '🚪';
        var title = type === 'entrée' ? 'Entrée enregistrée' : 'Sortie enregistrée';
        var color = type === 'entrée' ? '#166534' : '#991b1b';
        document.getElementById('result').innerHTML =
            '<div class="result-card"><div class="result-header"><span id="result-icon">' + icon + '</span>' +
            '<h2 id="result-title" style="color:' + color + ';">' + title + '</h2></div>' +
            '<div id="result-content">' +
            '<div class="info-item"><span class="label">Matricule:</span><span class="value">' + (result.matricule || '') + '</span></div>' +
            '<div class="info-item"><span class="label">Nom:</span><span class="value">' + (result.nom || '') + '</span></div>' +
            '<div class="info-item"><span class="label">Date:</span><span class="value">' + (result.date || '') + '</span></div>' +
            '<div class="info-item"><span class="label">Heure:</span><span class="value">' + (result.heure || '') + '</span></div>' +
            '</div></div>';
        afficherToast(result.message || title, 'success');
    }

    function afficherErreur(message) {
        var clean = String(message || 'Erreur');
        document.getElementById('result').innerHTML =
            '<div class="result-card result-card--error">' +
            '<div class="result-header"><span id="result-icon">⚠️</span><h2 id="result-title">Vérification interrompue</h2></div>' +
            '<div class="result-message">' + clean + '</div></div>';
        afficherToast(clean, 'error');
    }

    function afficherToast(message, type) {
        var toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 2600);
    }

    window.onload = function () {
        setMode('entree');
        document.querySelectorAll('.mode-btn').forEach(function (btn) {
            btn.addEventListener('click', function () { setMode(btn.getAttribute('data-mode')); });
        });

        demarrerSuiviPosition();

        var switchBtn = document.getElementById('btn-switch-camera');
        if (switchBtn) switchBtn.addEventListener('click', changerCamera);

        var toggleBtn = document.getElementById('btn-toggle-scan');
        if (toggleBtn) toggleBtn.addEventListener('click', toggleScan);

        var manualForm = document.getElementById('manual-form');
        if (manualForm) {
            manualForm.addEventListener('submit', function (evt) {
                evt.preventDefault();
                var input = document.getElementById('manual-matricule');
                var matricule = input.value.trim();
                if (!matricule) return;
                traiterMatricule(matricule, function () {});
                input.value = '';
            });
        }

        if (document.getElementById('reader')) {
            demarrerScanner();
        }
    };

    window.onbeforeunload = function () {
        if (html5QrCode) {
            try { html5QrCode.stop(); } catch (e) {}
        }
        if (watchId !== null && navigator.geolocation) {
            try { navigator.geolocation.clearWatch(watchId); } catch (e) {}
        }
    };
})();
