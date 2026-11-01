// Frontend Pointage QR — v3.6 (un seul bouton : le scan enregistre)
// L'URL de l'API est définie ICI uniquement.
(function () {
    'use strict';

    var API_URL = 'https://script.google.com/macros/s/AKfycbwbffmEBMxUeGdz0RMTZrlynpqccsCarLgJqRhmyyuJekw5w9v-hdReypgQpPYalmU/exec';

    var REQUEST_TIMEOUT_MS = 12000;
    var SCAN_COOLDOWN_MS = 5000;      // ignore le même QR revu par la caméra pendant 5 s
    var KEEPALIVE_MS = 4 * 60 * 1000; // garde Apps Script "chaud"

    var scanConfig = {
        fps: 10,
        qrbox: function (w, h) {
            var s = Math.floor(Math.min(w, h) * 0.7);
            return { width: s, height: s };
        },
        aspectRatio: 1,
        disableFlip: true
    };

    var html5QrCode = null;
    var currentFacingMode = 'environment';
    var isRunning = false;
    var starting = false;
    var resumeAfterHidden = false;

    var lastScans = {};

    function $(id) { return document.getElementById(id); }

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function setStatus(text) {
        var el = $('scan-status');
        if (el) el.textContent = text;
    }

    // ============================================
    // Caméra
    // ============================================
    function creerScanner() {
        var options = { verbose: false, experimentalFeatures: { useBarcodeDetector: true } }; // décodeur natif si disponible
        if (typeof Html5QrcodeSupportedFormats !== 'undefined') {
            options.formatsToSupport = [Html5QrcodeSupportedFormats.QR_CODE];
        }
        return new Html5Qrcode('reader', options);
    }

    function demarrerScanner() {
        if (starting || isRunning) return;
        if (typeof Html5Qrcode === 'undefined') {
            $('reader').innerHTML = '<div style="padding:20px;color:#ef4444;text-align:center;">Bibliothèque QR introuvable</div>';
            $('permission-info').hidden = false;
            return;
        }
        if (!html5QrCode) html5QrCode = creerScanner();

        starting = true;
        setStatus('Démarrage de la caméra…');
        html5QrCode.start({ facingMode: currentFacingMode }, scanConfig, onScanSuccess, function () {})
            .then(function () {
                starting = false;
                isRunning = true;
                setStatus('Prêt — présentez un QR code');
                $('permission-info').hidden = true;
                detecterPlusieursCameras();
                majBoutonToggle();
            })
            .catch(function (err) {
                starting = false;
                isRunning = false;
                majBoutonToggle();
                setStatus('Caméra indisponible');
                $('permission-info').hidden = false;
                console.debug('Erreur caméra:', err);
            });
    }

    function arreterScanner() {
        if (!html5QrCode || !isRunning) return Promise.resolve();
        isRunning = false;
        majBoutonToggle();
        return html5QrCode.stop().catch(function () {});
    }

    function majBoutonToggle() {
        var btn = $('btn-toggle-scan');
        if (!btn) return;
        btn.textContent = isRunning ? '⏹ Arrêter le scan' : '▶ Démarrer le scan';
        btn.classList.toggle('btn-icon--stop', isRunning);
    }

    function toggleScan() {
        resumeAfterHidden = false;
        if (isRunning) {
            setStatus('Scanner arrêté');
            arreterScanner();
        } else {
            demarrerScanner();
        }
    }

    function detecterPlusieursCameras() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        navigator.mediaDevices.enumerateDevices().then(function (devices) {
            var count = devices.filter(function (d) { return d.kind === 'videoinput'; }).length;
            var btn = $('btn-switch-camera');
            if (btn) btn.hidden = count < 2;
        }).catch(function () {});
    }

    function changerCamera() {
        if (!html5QrCode) return;
        setStatus('Changement de caméra…');
        arreterScanner().then(function () {
            currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
            demarrerScanner();
        });
    }

    // ============================================
    // Scan : le QR est au format "| MATRICULE | NOM |"
    // ============================================
    function parseQr(text) {
        var segments = String(text || '').split('|')
            .map(function (s) { return s.trim(); })
            .filter(function (s) { return s !== ''; });
        return { matricule: segments[0] || '', nom: segments[1] || '' };
    }

    function onScanSuccess(decodedText) {
        var parsed = parseQr(decodedText);
        if (!parsed.matricule) return;

        var now = Date.now();
        var key = parsed.matricule;
        if (lastScans[key] && now - lastScans[key] < SCAN_COOLDOWN_MS) return;
        lastScans[key] = now;

        pointer(parsed.matricule, parsed.nom);
    }

    // ============================================
    // Réseau — GET simple (pas de preflight CORS)
    // ============================================
    function appeler(params, timeoutMs) {
        var parts = [];
        Object.keys(params).forEach(function (k) {
            var v = params[k];
            if (v !== '' && v !== null && v !== undefined) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        });
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
        return fetch(API_URL + '?' + parts.join('&'), { method: 'GET', signal: controller ? controller.signal : undefined })
            .then(function (response) {
                if (timer) clearTimeout(timer);
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            }, function (err) {
                if (timer) clearTimeout(timer);
                throw err;
            });
    }

    function ping(premier) {
        appeler({ action: premier ? 'warmup' : 'ping', _: Date.now() }, 15000).catch(function () {});
    }

    // ============================================
    // Pointage : "✅ Enregistré" s'affiche AU SCAN (sans attendre le serveur).
    // L'envoi part en arrière-plan, en parallèle ; seule une erreur remplace l'affichage.
    // ============================================
    function pointer(matricule, nom) {
        var libelle = nom || matricule;
        afficher('in', libelle, '✅ Enregistré');

        appeler({ action: 'pointer', matricule: matricule }, REQUEST_TIMEOUT_MS)
            .then(function (data) {
                if (!data || !data.success) {
                    afficher('error', libelle, (data && data.message) || 'Erreur inconnue');
                }
            }, function () {
                afficher('error', libelle, 'Le serveur ne répond pas. Le pointage a peut-être quand même été enregistré — vérifiez la feuille.');
            });
    }

    // ============================================
    // Affichage : une seule petite carte, rien d'autre
    // ============================================
    function afficher(kind, nom, texte) {
        $('result').innerHTML =
            '<div class="result-card result-card--' + kind + '">' +
            '<div class="result-name">' + esc(nom) + '</div>' +
            '<div class="result-message">' + esc(texte) + '</div></div>';
    }

    function afficherErreur(message) {
        afficher('error', '', message);
    }

    // ============================================
    // Démarrage
    // ============================================
    function init() {
        ping(true);
        setInterval(function () { if (!document.hidden) ping(false); }, KEEPALIVE_MS);

        $('btn-switch-camera').addEventListener('click', changerCamera);
        $('btn-toggle-scan').addEventListener('click', toggleScan);

        $('manual-form').addEventListener('submit', function (evt) {
            evt.preventDefault();
            var input = $('manual-matricule');
            var matricule = input.value.trim();
            if (!matricule) { afficherErreur('Veuillez saisir un matricule ou scanner un QR valide.'); return; }
            pointer(matricule, '');
            input.value = '';
        });

        // Caméra coupée quand la page est masquée, relancée au retour.
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                if (isRunning) {
                    resumeAfterHidden = true;
                    arreterScanner();
                    setStatus('En pause (page masquée)');
                }
            } else {
                if (resumeAfterHidden) { resumeAfterHidden = false; demarrerScanner(); }
                ping(false);
            }
        });

        demarrerScanner();
    }

    window.addEventListener('beforeunload', function () {
        if (html5QrCode && isRunning) { try { html5QrCode.stop(); } catch (e) {} }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
