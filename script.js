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

// ── Historique ──
let historyData = [];
try {
  const local = localStorage.getItem('cl_history');
  if (local) historyData = JSON.parse(local);
} catch (e) {}

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
      document.getElementById('results-area').classList.add('visible');
      document.querySelector('.main-card').scrollIntoView({ behavior: 'smooth' });
    });
    container.appendChild(item);
  });
}

// ── Étape 1 : localisation de la parcelle + voisines ──

let currentLocationData = null;   // réponse de /api/location-data
let selectedParcelIds = new Set(); // idu des parcelles cochées (toujours inclut la principale)
let parcelLayers = {};             // idu -> layer Leaflet
let parcelSelectionMap = null;

document.getElementById('analyzer-form').addEventListener('submit', handleLocate);

async function handleLocate(e) {
  e.preventDefault();

  if (!validatedAddress) {
    setAddressInvalid("Veuillez choisir une adresse suggérée.");
    return;
  }

  const btn = document.getElementById('submit-btn');
  const loader = document.getElementById('loader');
  const loaderText = document.getElementById('loader-text');
  const parcelSelection = document.getElementById('parcel-selection');
  const resultsArea = document.getElementById('results-area');

  btn.disabled = true;
  loaderText.textContent = 'Recherche de la parcelle cadastrale...';
  loader.style.display = 'block';
  parcelSelection.style.display = 'none';
  resultsArea.classList.remove('visible');

  try {
    const resLoc = await fetch(`/api/location-data?address=${encodeURIComponent(validatedAddress)}`);
    if (!resLoc.ok) throw new Error("Impossible de récupérer les données cadastrales pour cette adresse.");
    const locationData = await resLoc.json();

    if (!locationData.parcellePrincipale) {
      throw new Error(locationData.info || "Aucune parcelle cadastrale trouvée à cette adresse.");
    }

    currentLocationData = locationData;
    selectedParcelIds = new Set([locationData.parcellePrincipale.properties.idu]);

    displayParcelSelection(locationData);
    parcelSelection.style.display = 'block';
    parcelSelection.scrollIntoView({ behavior: 'smooth' });

  } catch (err) {
    alert(err.message || "Une erreur est survenue lors de la récupération des données cadastrales.");
  } finally {
    btn.disabled = false;
    loader.style.display = 'none';
  }
}

function displayParcelSelection(locationData) {
  const { parcellePrincipale, parcellesVoisines, lon, lat, matchType } = locationData;

  // Le géocodage de l'adresse (API Adresse / BAN) place parfois le point légèrement à côté
  // de la parcelle réelle (interpolation le long de la voie). Quand notre repli "centroïde
  // le plus proche" a dû être utilisé, on prévient l'utilisateur de vérifier la sélection
  // plus attentivement sur la carte avant de lancer l'analyse.
  const warningEl = document.getElementById('parcel-warning');
  if (warningEl) {
    if (matchType === 'centroide_proche' || matchType === 'premier_resultat_brut') {
      warningEl.style.display = 'block';
      warningEl.dataset.kind = 'geocodage-approximatif';
      warningEl.innerHTML = '⚠️ La géolocalisation de cette adresse ne tombe pas exactement ' +
        'à l\'intérieur d\'une parcelle cadastrale (cas fréquent pour les adresses en retrait ' +
        'de la voie). La parcelle la plus proche a été présélectionnée automatiquement : ' +
        '<strong>vérifiez bien sur la carte qu\'il s\'agit du bon bien</strong> avant de lancer l\'analyse.';
    } else {
      warningEl.style.display = 'none';
      warningEl.innerHTML = '';
      delete warningEl.dataset.kind;
    }
  }

  // Carte Leaflet pour visualiser la parcelle principale et ses voisines
  if (parcelSelectionMap) {
    parcelSelectionMap.remove();
    parcelSelectionMap = null;
  }
  parcelLayers = {};

  parcelSelectionMap = L.map('parcel-map').setView([lat, lon], 18);
  L.tileLayer('https://data.geopf.fr/wmts?REQUEST=GetTile&SERVICE=WMTS&VERSION=1.0.0&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', {
    maxZoom: 19,
    attribution: '© IGN'
  }).addTo(parcelSelectionMap);

  const idPrincipale = parcellePrincipale.properties.idu;

  function drawParcel(feature, isPrincipale) {
    const idu = feature.properties.idu;
    const layer = L.geoJSON(feature.geometry, {
      style: {
        color: isPrincipale ? '#1B3A5C' : '#00B4D8',
        weight: 2,
        fillOpacity: selectedParcelIds.has(idu) ? 0.25 : 0.05,
        dashArray: isPrincipale ? null : '4,4'
      }
    }).addTo(parcelSelectionMap);

    // La parcelle détectée automatiquement reste cochable/décochable comme les autres : la
    // détection peut se tromper (parcelle voisine, parcelle de voirie...), l'utilisateur doit
    // pouvoir corriger en la retirant et en cochant la bonne à la place. toggleParcel()
    // empêche de tout décocher, donc il n'y a pas de risque d'envoyer une sélection vide.
    layer.on('click', () => {
      toggleParcel(idu);
    });

    parcelLayers[idu] = layer;
  }

  drawParcel(parcellePrincipale, true);
  parcellesVoisines.forEach(v => {
    drawParcel({ properties: { idu: v.idu }, geometry: v.geometry }, false);
  });

  setTimeout(() => { if (parcelSelectionMap) parcelSelectionMap.invalidateSize(); }, 200);

  // Liste textuelle avec cases à cocher (plus accessible que cliquer uniquement sur la carte)
  const listEl = document.getElementById('parcel-list');
  listEl.innerHTML = '';

  const principaleRow = document.createElement('div');
  principaleRow.className = 'parcel-row parcel-row-main';
  const checkboxIdPrincipale = `chk-parcel-${idPrincipale}`;
  principaleRow.innerHTML = `
    <label>
      <input type="checkbox" id="${checkboxIdPrincipale}" checked />
      <strong>Détectée automatiquement</strong> — Section ${parcellePrincipale.properties.section}, n°${parcellePrincipale.properties.numero}
      (${parcellePrincipale.properties.contenance || '?'} m²)
    </label>`;
  listEl.appendChild(principaleRow);
  principaleRow.querySelector('input').addEventListener('change', () => toggleParcel(idPrincipale));

  if (parcellesVoisines.length === 0) {
    const noNeighborRow = document.createElement('div');
    noNeighborRow.className = 'parcel-row parcel-row-empty';
    noNeighborRow.textContent = 'Aucune parcelle contiguë détectée.';
    listEl.appendChild(noNeighborRow);
  } else {
    parcellesVoisines.forEach(v => {
      const row = document.createElement('div');
      row.className = 'parcel-row';
      const checkboxId = `chk-parcel-${v.idu}`;
      row.innerHTML = `
        <label>
          <input type="checkbox" id="${checkboxId}" />
          Section ${v.section}, n°${v.numero} (${v.contenance || '?'} m²)
        </label>`;
      listEl.appendChild(row);
      row.querySelector('input').addEventListener('change', () => toggleParcel(v.idu));
    });
  }
}

function toggleParcel(idu) {
  // On autorise désormais de tout décocher temporairement (ex: pendant qu'on bascule d'une
  // parcelle à une autre) : le vrai contrôle se fait au moment de lancer l'analyse
  // (cf. handleAnalyze), pas ici, sinon on ne peut jamais décocher la dernière case restante
  // pour la remplacer par une autre.
  if (selectedParcelIds.has(idu)) {
    selectedParcelIds.delete(idu);
  } else {
    selectedParcelIds.add(idu);
  }

  const layer = parcelLayers[idu];
  if (layer) {
    layer.setStyle({ fillOpacity: selectedParcelIds.has(idu) ? 0.25 : 0.05 });
  }

  const checkbox = document.getElementById(`chk-parcel-${idu}`);
  if (checkbox) checkbox.checked = selectedParcelIds.has(idu);

  // Si le bandeau affichait l'erreur "sélection vide" et qu'on vient de cocher quelque chose,
  // on l'efface — sans toucher au cas où il affichait l'avertissement de géocodage approximatif.
  if (selectedParcelIds.size > 0) {
    const warningEl = document.getElementById('parcel-warning');
    if (warningEl && warningEl.dataset.kind === 'selection-vide') {
      warningEl.style.display = 'none';
      warningEl.innerHTML = '';
      delete warningEl.dataset.kind;
    }
  }
}

// ── Étape 2 : lancement de l'analyse IA sur la sélection ──

document.getElementById('launch-analysis-btn').addEventListener('click', handleAnalyze);

async function handleAnalyze() {
  if (!currentLocationData) return;

  const btn = document.getElementById('launch-analysis-btn');
  const loader = document.getElementById('loader');
  const loaderText = document.getElementById('loader-text');
  const resultsArea = document.getElementById('results-area');

  const allParcels = [currentLocationData.parcellePrincipale, ...currentLocationData.parcellesVoisines.map(v => ({
    type: 'Feature',
    properties: { idu: v.idu },
    geometry: v.geometry
  }))];
  const selectedFeatures = allParcels.filter(f => selectedParcelIds.has(f.properties.idu));

  // On bloque ici plutôt que dans toggleParcel : l'utilisateur doit pouvoir décocher la
  // dernière case restante librement (par exemple pour la remplacer par une autre), mais on
  // ne lance pas une analyse sans aucune parcelle sélectionnée. Le message est affiché dans
  // la page (bandeau au-dessus de la carte) plutôt qu'en popup, pour rester cohérent avec le
  // reste de l'interface.
  if (selectedFeatures.length === 0) {
    const warningEl = document.getElementById('parcel-warning');
    if (warningEl) {
      warningEl.style.display = 'block';
      warningEl.dataset.kind = 'selection-vide';
      warningEl.innerHTML = '⚠️ Veuillez sélectionner au moins une parcelle avant de lancer l\'analyse.';
      warningEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  btn.disabled = true;
  loaderText.textContent = "Récupération de l'image satellite et analyse IA en cours...";
  loader.style.display = 'block';
  resultsArea.classList.remove('visible');

  try {
    const resAnalyze = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parcelles: selectedFeatures
      })
    });

    const data = await resAnalyze.json();
    if (!resAnalyze.ok) throw new Error(data.error || "Erreur lors de l'analyse IA.");

    const historyEntry = {
      id: Date.now(),
      address: validatedAddress,
      pool: data.pool,
      pool_confidence: data.pool_confidence,
      solar: data.solar,
      solar_confidence: data.solar_confidence,
      cadastre: currentLocationData,
      image_base64: data.image_base64
    };

    historyData.unshift(historyEntry);
    saveHistory();
    renderHistory();

    displayResults(historyEntry);
    resultsArea.classList.add('visible');
    resultsArea.scrollIntoView({ behavior: 'smooth' });

  } catch (err) {
    alert(err.message || "Une erreur est survenue lors de l'analyse.");
  } finally {
    btn.disabled = false;
    loader.style.display = 'none';
  }
}

// ── Affichage des résultats ──

function confidenceLabel(confidence) {
  if (confidence === null || confidence === undefined) return '';
  const pct = Math.round(confidence * 100);
  let niveau = 'Fiabilité faible';
  if (confidence >= 0.85) niveau = 'Fiabilité élevée';
  else if (confidence >= 0.6) niveau = 'Fiabilité moyenne';
  return `${niveau} (${pct}%)`;
}

function displayResults(entry) {
  if (!entry) return;

  const cardPool = document.getElementById('card-pool');
  const poolV    = document.getElementById('pool-verdict');
  const poolC    = document.getElementById('pool-confidence');

  if (cardPool && poolV && poolC) {
    cardPool.className = 'detection-card ' + (entry.pool ? 'pool-yes' : 'pool-no');
    poolV.textContent = entry.pool ? 'Oui' : 'Non';
    poolC.textContent = confidenceLabel(entry.pool_confidence);
  }

  const cardSolar = document.getElementById('card-solar');
  const solarV    = document.getElementById('solar-verdict');
  const solarC    = document.getElementById('solar-confidence');

  if (cardSolar && solarV && solarC) {
    cardSolar.className = 'detection-card ' + (entry.solar ? 'solar-yes' : 'solar-no');
    solarV.textContent = entry.solar ? 'Oui' : 'Non';
    solarC.textContent = confidenceLabel(entry.solar_confidence);
  }

  const cadastreOutput = document.getElementById('cadastre-output');
  if (cadastreOutput) {
    const cad = entry.cadastre;
    if (cad) {
      cadastreOutput.innerHTML = `
        <ul style="list-style: none; padding: 0; margin: 0; line-height: 1.6;">
          <li><strong>Commune :</strong> ${cad.city || 'Inconnue'}</li>
          <li><strong>ID Parcelle principale :</strong> ${cad.idParcelle || 'Inconnu'}</li>
          <li><strong>Superficie :</strong> ${cad.superficie ? cad.superficie + ' m²' : 'Inconnue'}</li>
          <li><strong>Code INSEE :</strong> ${cad.codeInsee || 'Inconnu'}</li>
        </ul>
      `;
    } else {
      cadastreOutput.textContent = "Données cadastrales indisponibles.";
    }
  }

  const imgEl = document.getElementById('analyzed-image');
  if (imgEl && entry.image_base64) {
    imgEl.src = `data:image/png;base64,${entry.image_base64}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderHistory();
});