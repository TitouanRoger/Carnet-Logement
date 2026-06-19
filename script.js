// ── Chips fixés ──
document.getElementById('chip-pool').addEventListener('click', (e) => e.preventDefault());
document.getElementById('chip-solar').addEventListener('click', (e) => e.preventDefault());

// ── Autocomplete (API Adresse data.gouv.fr) ──
const addrInput   = document.getElementById('addr');
const dropdown    = document.getElementById('ac-dropdown');
const addrError   = document.getElementById('addr-error');
const addrHint    = document.getElementById('addr-hint');

let validatedAddress = null; 
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

function setAddressInvalid(msg) {
  validatedAddress = null;
  addrInput.classList.add('input-error');
  addrError.textContent = msg;
  addrError.classList.add('visible');
  addrHint.textContent = 'Veuillez sélectionner une adresse dans la liste';
  addrHint.style.color = 'var(--muted)';
}

addrInput.addEventListener('input', function() {
  const q = this.value.trim();
  validatedAddress = null; 
  addrHint.textContent = 'Sélectionnez l\'adresse exacte dans la liste';
  addrHint.style.color = 'var(--muted)';
  
  if (q.length < 3) {
    closeDropdown();
    return;
  }
  
  clearTimeout(acDebounce);
  acDebounce = setTimeout(() => {
    fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=5`)
      .then(res => res.json())
      .then(json => {
        acItems = json.features || [];
        renderDropdown();
      })
      .catch(err => console.error(err));
  }, 200);
});

function renderDropdown() {
  dropdown.innerHTML = '';
  acFocusIndex = -1;
  if (acItems.length === 0) {
    closeDropdown();
    return;
  }
  acItems.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'ac-item';
    div.textContent = item.properties.label;
    div.addEventListener('click', () => {
      selectItem(index);
    });
    dropdown.appendChild(div);
  });
  dropdown.style.display = 'block';
}

function selectItem(index) {
  if (index >= 0 && index < acItems.length) {
    const item = acItems[index];
    addrInput.value = item.properties.label;
    setAddressValid(item.properties.label);
    closeDropdown();
  }
}

function closeDropdown() {
  dropdown.style.display = 'none';
  dropdown.innerHTML = '';
}

addrInput.addEventListener('keydown', function(e) {
  const items = dropdown.querySelectorAll('.ac-item');
  if (!items.length) return;
  
  if (e.key === 'ArrowDown') {
    acFocusIndex++;
    if (acFocusIndex >= items.length) acFocusIndex = 0;
    setActive(items);
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    acFocusIndex--;
    if (acFocusIndex < 0) acFocusIndex = items.length - 1;
    setActive(items);
    e.preventDefault();
  } else if (e.key === 'Enter') {
    if (acFocusIndex > -1) {
      selectItem(acFocusIndex);
      e.preventDefault();
    }
  }
});

function setActive(items) {
  items.forEach(item => item.classList.remove('active'));
  if (acFocusIndex > -1) items[acFocusIndex].classList.add('active');
}

document.addEventListener('click', function(e) {
  if (e.target !== addrInput && e.target !== dropdown) {
    closeDropdown();
  }
});

// ── Historique & Soumission ──
let historyData = [];
try {
  const local = localStorage.getItem('cl_history');
  if (local) historyData = JSON.parse(local);
} catch(e) {}

function saveHistory() {
  localStorage.setItem('cl_history', JSON.stringify(historyData));
}

function renderHistory() {
  const container = document.getElementById('history-list');
  const section = document.getElementById('history-section');
  if (!container || !section) return;

  container.innerHTML = '';
  if (historyData.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  historyData.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'history-item';
    
    let badgesHtml = '';
    if (entry.pool) badgesHtml += '<span class="hbadge pool">🏊 Piscine</span>';
    if (entry.solar) badgesHtml += '<span class="hbadge solar">☀️ Solaire</span>';
    if (!entry.pool && !entry.solar) badgesHtml += '<span class="hbadge none">Aucun</span>';

    item.innerHTML = `
      <div class="history-addr">${entry.address}</div>
      <div class="history-badges">${badgesHtml}</div>
    `;
    item.addEventListener('click', () => {
      displayResults(entry);
      document.querySelector('.main-card').scrollIntoView({ behavior: 'smooth' });
    });
    container.appendChild(item);
  });
}

document.getElementById('analyzer-form').addEventListener('submit', handleSubmit);

async function handleSubmit(e) {
  e.preventDefault();
  
  if (!validatedAddress) {
    setAddressInvalid("Veuillez choisir une adresse suggérée.");
    return;
  }

  // Force la valeur à true indépendamment de l'état visuel du checkbox
  const chkPool = true; 
  const chkSolar = true;

  const btn = document.getElementById('submit-btn');
  const loader = document.getElementById('loader');
  const resultsArea = document.getElementById('results-area');

  btn.disabled = true;
  loader.style.display = 'block';
  resultsArea.classList.remove('visible');

  try {
    const resLoc = await fetch(`/api/location-data?address=${encodeURIComponent(validatedAddress)}`);
    if (!resLoc.ok) throw new Error("Impossible de récupérer les coordonnées géographiques.");
    const locationData = await resLoc.json();

    const resAnalyze = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `Analyse de détection d'équipements pour l'adresse ${validatedAddress}`,
        options: { pool: true, solar: true },
        realCadastre: locationData
      })
    });

    if (!resAnalyze.ok) throw new Error("Erreur lors de l'analyse IA.");
    const data = await resAnalyze.json();

    const historyEntry = {
      id: Date.now(),
      address: validatedAddress,
      pool: chkPool ? data.pool : null,
      raison_piscine: chkPool ? data.raison_piscine : null,
      solar: chkSolar ? data.solar : null,
      raison_panneaux: chkSolar ? data.raison_panneaux : null,
      analyse: data.analyse,
      cadastre: locationData
    };

    historyData.unshift(historyEntry);
    saveHistory();
    renderHistory();

    displayResults(historyEntry);
    resultsArea.classList.add('visible');

  } catch (err) {
    alert(err.message || "Une erreur est survenue lors du traitement.");
  } finally {
    btn.disabled = false;
    loader.style.display = 'none';
  }
}

function displayResults(entry) {
  if (!entry) return;

  const resultsArea = document.getElementById('results-area');
  if (resultsArea) resultsArea.classList.add('visible');

  // 1. Verdicts Piscine
  const cardPool = document.getElementById('card-pool');
  const poolV    = document.getElementById('pool-verdict');
  const poolR    = document.getElementById('pool-reason');
  
  if (cardPool && poolV && poolR) {
    if (entry.pool === true) {
      cardPool.className = 'detection-card pool-yes';
      poolV.textContent  = '✓ Présence détectée par l\'IA';
      poolR.textContent  = entry.raison_piscine || 'Détectée sur l\'image satellite.';
    } else {
      cardPool.className = 'detection-card pool-no';
      poolV.textContent  = '✗ Absence constatée';
      poolR.textContent  = entry.raison_piscine || 'Aucune piscine visible.';
    }
  }

  // 2. Verdicts Panneaux Solaires
  const cardSolar = document.getElementById('card-solar');
  const solarV    = document.getElementById('solar-verdict');
  const solarR    = document.getElementById('solar-reason');
  
  if (cardSolar && solarV && solarR) {
    if (entry.solar === null || entry.solar === undefined) {
      cardSolar.className = 'detection-card solar-no';
      solarV.textContent  = 'Non analysé';
      solarR.textContent  = 'Cet élément n\'était pas sélectionné.';
    } else if (entry.solar === true) {
      cardSolar.className = 'detection-card solar-yes';
      solarV.textContent  = '✓ Présence détectée par l\'IA';
      solarR.textContent  = entry.raison_panneaux || 'Détectés sur la toiture.';
    } else {
      cardSolar.className = 'detection-card solar-no';
      solarV.textContent  = '✗ Absence constatée';
      solarR.textContent  = entry.raison_panneaux || 'Aucun panneau visible.';
    }
  }

  // 3. Remplissage des données du Cadastre
  const cadastreOutput = document.getElementById('cadastre-output');
  if (cadastreOutput) {
    const cad = entry.cadastre;
    if (cad) {
      cadastreOutput.innerHTML = `
        <ul style="list-style: none; padding: 0; margin: 0; line-height: 1.6;">
          <li><strong>Commune :</strong> ${cad.city || 'Inconnue'}</li>
          <li><strong>ID Parcelle :</strong> ${cad.idParcelle || 'Inconnu'}</li>
          <li><strong>Superficie :</strong> ${cad.superficie ? cad.superficie + ' m²' : 'Inconnue'}</li>
          <li><strong>Code INSEE :</strong> ${cad.codeInsee || 'Inconnu'}</li>
        </ul>
      `;
    } else {
      cadastreOutput.textContent = "Données cadastrales indisponibles.";
    }
  }

  // 4. Rapport d'analyse de l'IA
  const aiResponse = document.getElementById('ai-response');
  if (aiResponse) {
    aiResponse.textContent = entry.analyse || "Aucun rapport textuel généré.";
  }

  // 5. Affichage de la carte aérienne Leaflet
  const mapContainer = document.getElementById('map-container');
  let lon = entry.cadastre?.lon || null;
  let lat = entry.cadastre?.lat || null;

  if (lon && lat) {
    if (mapContainer) mapContainer.style.display = 'block';

    try {
      if (!window.ignMap) {
        window.ignMap = L.map('map').setView([lat, lon], 18);

        L.tileLayer('https://data.geopf.fr/wmts?REQUEST=GetTile&SERVICE=WMTS&VERSION=1.0.0&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', {
          maxZoom: 19,
          attribution: '© IGN'
        }).addTo(window.ignMap);

        window.ignMarker = L.marker([lat, lon]).addTo(window.ignMap);
      } else {
        window.ignMap.setView([lat, lon], 18);
        window.ignMarker.setLatLng([lat, lon]);
      }

      setTimeout(() => {
        if (window.ignMap) window.ignMap.invalidateSize();
      }, 250);

    } catch (mapError) {
      console.error("Erreur Leaflet :", mapError);
    }
  } else {
    if (mapContainer) mapContainer.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderHistory();
});