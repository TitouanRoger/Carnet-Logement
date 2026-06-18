// ── Chips toggle ──
document.getElementById('chip-pool').addEventListener('click', function(e) {
  const chk = document.getElementById('chk-pool');
  chk.checked = !chk.checked;
  this.className = 'option-chip' + (chk.checked ? ' active-pool' : '');
  e.preventDefault();
});
document.getElementById('chip-solar').addEventListener('click', function(e) {
  const chk = document.getElementById('chk-solar');
  chk.checked = !chk.checked;
  this.className = 'option-chip' + (chk.checked ? ' active-solar' : '');
  e.preventDefault();
});

// ── Autocomplete (API Adresse data.gouv.fr) ──
const addrInput   = document.getElementById('addr');
const dropdown    = document.getElementById('ac-dropdown');
const addrError   = document.getElementById('addr-error');
const addrHint    = document.getElementById('addr-hint');

// Validated address state
let validatedAddress = null; // null = not validated, string = validated label
let acFocusIndex = -1;
let acItems = [];
let acDebounce = null;

function setAddressValid(label) {
  validatedAddress = label;
  addrInput.classList.remove('input-error');
  addrError.classList.remove('visible');
  addrHint.textContent = '✓ Adresse confirmée';
  addrHint.style.color = 'var(--green)';
}

function resetValidation() {
  validatedAddress = null;
  addrHint.textContent = 'Sélectionnez une adresse dans la liste pour valider';
  addrHint.style.color = '';
  addrInput.classList.remove('input-error');
  addrError.classList.remove('visible');
}

function showError(msg) {
  addrInput.classList.add('input-error');
  addrError.textContent = msg;
  addrError.classList.add('visible');
}

function closeDropdown() {
  dropdown.classList.add('hidden');
  dropdown.innerHTML = '';
  acFocusIndex = -1;
  acItems = [];
}

function selectItem(feature) {
  const label = feature.properties.label;
  addrInput.value = label;
  setAddressValid(label);
  closeDropdown();
}

function renderDropdown(features) {
  if (!features.length) {
    dropdown.innerHTML = '<div class="ac-searching">Aucune adresse trouvée</div>';
    dropdown.classList.remove('hidden');
    return;
  }
  acItems = features;
  acFocusIndex = -1;
  dropdown.innerHTML = features.map((f, i) => {
    const p = f.properties;
    const pct = Math.round((p.score || 0) * 100);
    const street = p.name || '';
    const city   = [p.postcode, p.city].filter(Boolean).join(' ');
    return `<div class="ac-item" data-idx="${i}">
      <svg class="ac-pin" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
        <circle cx="12" cy="9" r="2.5"/>
      </svg>
      <div>
        <div class="ac-main">${street}</div>
        <div class="ac-sub">${city}</div>
      </div>
      <div class="ac-score">${pct}%</div>
    </div>`;
  }).join('');
  dropdown.classList.remove('hidden');

  dropdown.querySelectorAll('.ac-item').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      selectItem(acItems[parseInt(el.dataset.idx)]);
    });
  });
}

async function fetchSuggestions(q) {
  dropdown.classList.remove('hidden');
  dropdown.innerHTML = '<div class="ac-searching"><div class="ac-mini-spin"></div>Recherche en cours…</div>';
  try {
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=6&type=housenumber`;
    const res = await fetch(url);
    const data = await res.json();
    renderDropdown(data.features || []);
  } catch {
    closeDropdown();
  }
}

addrInput.addEventListener('input', () => {
  resetValidation();
  clearTimeout(acDebounce);
  const q = addrInput.value.trim();
  if (q.length < 5) { closeDropdown(); return; }
  acDebounce = setTimeout(() => fetchSuggestions(q), 280);
});

addrInput.addEventListener('keydown', e => {
  if (dropdown.classList.contains('hidden')) {
    if (e.key === 'Enter') analyser();
    return;
  }
  const items = dropdown.querySelectorAll('.ac-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    acFocusIndex = Math.min(acFocusIndex + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('focused', i === acFocusIndex));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    acFocusIndex = Math.max(acFocusIndex - 1, -1);
    items.forEach((el, i) => el.classList.toggle('focused', i === acFocusIndex));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (acFocusIndex >= 0 && acItems[acFocusIndex]) {
      selectItem(acItems[acFocusIndex]);
    } else {
      closeDropdown();
      analyser();
    }
  } else if (e.key === 'Escape') {
    closeDropdown();
  }
});

addrInput.addEventListener('blur', () => {
  setTimeout(closeDropdown, 180);
});

// ── History ──
let history = JSON.parse(localStorage.getItem('cl_history') || '[]');
renderHistory();

function saveHistory(entry) {
  history.unshift(entry);
  if (history.length > 8) history = history.slice(0, 8);
  localStorage.setItem('cl_history', JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  const sec = document.getElementById('history-section');
  const list = document.getElementById('history-list');
  if (!history.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  list.innerHTML = history.map((h, i) => `
    <div class="history-item" onclick="reloadHistory(${i})">
      <span class="history-addr">${h.address}</span>
      <div class="history-badges">
        ${h.pool  !== null ? `<span class="hbadge pool">${h.pool  ? '🏊 Oui' : '🏊 Non'}</span>` : ''}
        ${h.solar !== null ? `<span class="hbadge solar">${h.solar ? '☀️ Oui' : '☀️ Non'}</span>` : ''}
      </div>
    </div>`).join('');
}

function reloadHistory(idx) {
  const h = history[idx];
  addrInput.value = h.address;
  setAddressValid(h.address);
  displayResults(h);
}

// ── Loading messages ──
const loadingSteps = [
  ['Géolocalisation de l\'adresse…',   'Correspondance cadastrale en cours'],
  ['Interrogation des données INSEE…', 'Croisement des déclarations fiscales'],
  ['Analyse par l\'IA…',    'Raisonnement sur les indices disponibles'],
  ['Compilation des résultats…',       'Mise en forme de la réponse'],
];
let loadingTimer = null;

function startLoadingAnim() {
  let step = 0;
  const msg = document.getElementById('loading-msg');
  const sub = document.getElementById('loading-sub');
  msg.textContent = loadingSteps[0][0];
  sub.textContent = loadingSteps[0][1];
  loadingTimer = setInterval(() => {
    step = (step + 1) % loadingSteps.length;
    msg.textContent = loadingSteps[step][0];
    sub.textContent = loadingSteps[step][1];
  }, 1800);
}

function stopLoadingAnim() { clearInterval(loadingTimer); }

// ── Main analyse ──
async function analyser() {
  if (!validatedAddress) {
    showError('Veuillez sélectionner une adresse dans la liste de propositions.');
    addrInput.focus();
    return;
  }

  const addr = validatedAddress;
  const wantPool  = document.getElementById('chk-pool').checked;
  const wantSolar = document.getElementById('chk-solar').checked;
  if (!wantPool && !wantSolar) {
    alert('Veuillez sélectionner au moins un élément à détecter.');
    return;
  }

  const btn = document.getElementById('btn-analyse');
  btn.disabled = true;
  document.getElementById('loading').classList.add('visible');
  document.getElementById('results').classList.remove('visible');
  document.getElementById('error-box').classList.remove('visible');
  startLoadingAnim();

  const items = [];
  if (wantPool)  items.push('piscine');
  if (wantSolar) items.push('panneaux photovoltaïques');

  const prompt = `Tu es un expert en analyse immobilière et cadastrale en France. On te demande d'analyser cette adresse pour le carnet logement :

  Adresse : "${addr}"
  Éléments à détecter : ${items.join(' et ')}

  CONSIGNES DE RAISONNEMENT :
  1. Regarde la superficie de la parcelle fournie en entête : si elle est minuscule (ex: moins de 150m² en zone urbaine dense ou appartement), la présence d'une piscine est techniquement improbable (false).
  2. Si la parcelle est de taille moyenne à grande (plus de 300m²-400m²), la place est physiquement suffisante pour accueillir ces équipements.
  3. En te basant sur la commune, le climat régional (ex: Gard, Hérault = fort taux d'équipement), et l'espace disponible sur la parcelle, émets une estimation probabiliste réaliste.

  Réponds UNIQUEMENT en JSON valide, sans markdown, sans commentaires, exactement ce format :
  {
    "piscine": ${wantPool ? 'true ou false' : 'null'},
    "panneaux": ${wantSolar ? 'true ou false' : 'null'},
    "confiance": "Élevée" ou "Moyenne" ou "Faible",
    "raison_piscine": ${wantPool ? '"Explication logique basée sur la taille du terrain et la région"' : 'null'},
    "raison_panneaux": ${wantSolar ? '"Explication logique basée sur l\'exposition régionale"' : 'null'},
    "analyse": "Analyse de 3-4 sentences croisant la superficie de la parcelle reçue et les spécificités de la commune."
  }`;

  try {
    const response = await fetch('http://localhost:3000/api/analyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, address: addr }) // <-- "address" est maintenant envoyé au serveur
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'Erreur API');

    // Consommation directe de data.text renvoyé de façon standardisée par le serveur proxy
    const rawText = data.text || ''; 
    let clean = rawText.replace(/```json|```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (jsonMatch) clean = jsonMatch[0];
    const parsed = JSON.parse(clean);

    const entry = {
      address: addr,
      pool:  parsed.piscine,
      solar: parsed.panneaux,
      confiance: parsed.confiance,
      raison_piscine: parsed.raison_piscine,
      raison_panneaux: parsed.raison_panneaux,
      analyse: parsed.analyse,
    };

    saveHistory(entry);
    displayResults(entry);

  } catch (err) {
    console.error(err);
    document.getElementById('error-text').textContent =
      'Erreur lors de l\'analyse : ' + (err.message || 'Vérifiez votre connexion et réessayez.');
    document.getElementById('error-box').classList.add('visible');
  } finally {
    stopLoadingAnim();
    document.getElementById('loading').classList.remove('visible');
    btn.disabled = false;
  }
}

function displayResults(entry) {
  document.getElementById('res-address').textContent = entry.address;
  document.getElementById('res-confidence').textContent =
    entry.confiance ? `Confiance : ${entry.confiance}` : 'Analyse complète';

  const cardPool = document.getElementById('card-pool');
  const poolV    = document.getElementById('pool-verdict');
  const poolR    = document.getElementById('pool-reason');
  if (entry.pool === null) {
    cardPool.className = 'detection-card pool-no';
    poolV.textContent  = 'Non analysé';
    poolR.textContent  = 'Cet élément n\'était pas sélectionné.';
  } else if (entry.pool) {
    cardPool.className = 'detection-card pool-yes';
    poolV.textContent  = '✓ Présence probable';
    poolR.textContent  = entry.raison_piscine || '';
  } else {
    cardPool.className = 'detection-card pool-no';
    poolV.textContent  = '✗ Absence probable';
    poolR.textContent  = entry.raison_piscine || '';
  }

  const cardSolar = document.getElementById('card-solar');
  const solarV    = document.getElementById('solar-verdict');
  const solarR    = document.getElementById('solar-reason');
  if (entry.solar === null) {
    cardSolar.className = 'detection-card solar-no';
    solarV.textContent  = 'Non analysé';
    solarR.textContent  = 'Cet élément n\'était pas sélectionné.';
  } else if (entry.solar) {
    cardSolar.className = 'detection-card solar-yes';
    solarV.textContent  = '✓ Présence probable';
    solarR.textContent  = entry.raison_panneaux || '';
  } else {
    cardSolar.className = 'detection-card solar-no';
    solarV.textContent  = '✗ Absence probable';
    solarR.textContent  = entry.raison_panneaux || '';
  }

  document.getElementById('analysis-text').textContent = entry.analyse || '';
  document.getElementById('results').classList.add('visible');
  document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}