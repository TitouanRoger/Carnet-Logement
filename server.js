require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); 
app.use(express.json());
app.use(express.static(__dirname)); 

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const https = require('https');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Agent HTTPS sans keep-alive : certains serveurs (ex: apicarto.ign.fr) coupent
// agressivement les connexions persistantes, ce qui provoque des ECONNRESET / "socket hang up".
const noKeepAliveAgent = new https.Agent({ keepAlive: false });

// fetch avec nouvelle(s) tentative(s) en cas d'erreur réseau transitoire (ECONNRESET, socket hang up)
async function fetchWithRetry(url, options = {}, retries = 2, delayMs = 400) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fetch(url, { agent: noKeepAliveAgent, ...options });
        } catch (err) {
            const isTransient = err.code === 'ECONNRESET' || /socket hang up/i.test(err.message || '');
            if (!isTransient || attempt === retries) throw err;
            console.warn(`Tentative ${attempt + 1} échouée (${err.code || err.message}), nouvel essai...`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

async function fetchSatelliteImageBuffer(lon, lat, scaleMultiplier = 1) {
    try {
        const deltaLon = 0.0007 * scaleMultiplier; 
        const deltaLat = 0.0005 * scaleMultiplier; 
        const bbox = `${lat - deltaLat},${lon - deltaLon},${lat + deltaLat},${lon + deltaLon}`;
        const wmsUrl = `https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS&STYLES=&CRS=EPSG:4326&BBOX=${bbox}&WIDTH=600&HEIGHT=600&FORMAT=image/png`;
        
        const response = await fetch(wmsUrl);
        if (!response.ok) return null;
        
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) {
        console.error("Erreur récupération image IGN:", e);
        return null;
    }
}

async function getCadastreData(address) {
    try {
        const urlAdresses = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`;
        const resAddr = await fetchWithRetry(urlAdresses);
        const jsonAddr = await resAddr.json();
        
        if (!jsonAddr.features || jsonAddr.features.length === 0) return null;
        
        const feature = jsonAddr.features[0];
        const [lon, lat] = feature.geometry.coordinates;
        const codeInsee = feature.properties.citycode;
        const city = feature.properties.city;

        const urlCadastre = `https://apicarto.ign.fr/api/cadastre/parcelle?code_insee=${codeInsee}&lon=${lon}&lat=${lat}`;
        const resCad = await fetchWithRetry(urlCadastre);
        
        if (!resCad.ok) {
            return { lon, lat, codeInsee, city, idParcelle: 'Non localisée', superficie: null, info: 'Parcelle introuvable sur ApiCarto' };
        }

        const jsonCad = await resCad.json();
        if (!jsonCad.features || jsonCad.features.length === 0) {
            return { lon, lat, codeInsee, city, idParcelle: 'Non localisée', superficie: null, info: 'Aucune parcelle à ces coordonnées' };
        }

        const parcelle = jsonCad.features[0].properties;
        return { lon, lat, codeInsee, city, idParcelle: parcelle.id || 'Inconnu', superficie: parcelle.contenance || null, info: 'OK' };
    } catch (err) {
        console.error("Erreur getCadastreData:", err);
        return null;
    }
}

app.post('/api/analyze', async (req, res) => {
  const { prompt, options, realCadastre } = req.body;

  if (!prompt) return res.status(400).json({ error: 'Le prompt est requis.' });

  let imageLargeBase64 = null;
  let imageSerreeBase64 = null;

  if (realCadastre && realCadastre.lon && realCadastre.lat) {
      const bufLarge = await fetchSatelliteImageBuffer(realCadastre.lon, realCadastre.lat, 1.0);
      if (bufLarge) imageLargeBase64 = bufLarge.toString('base64');
      const bufSerre = await fetchSatelliteImageBuffer(realCadastre.lon, realCadastre.lat, 0.35);
      if (bufSerre) imageSerreeBase64 = bufSerre.toString('base64');
  }

  const systemInstruction = `Tu es un expert en analyse satellite. Analyse la présence de piscine (bassin d'eau) et panneaux solaires. Réponds uniquement en JSON.`;

  const contextualizedPrompt = `Analyse les équipements pour la parcelle. Respecte ce format JSON : {"pool": boolean, "raison_piscine": string, "solar": boolean, "raison_panneaux": string, "analyse": string}`;

  try {
      const contentPayload = [];
      if (imageLargeBase64) {
          contentPayload.push({ type: "text", text: "Vue globale :" });
          contentPayload.push({ type: "image", source: { type: "base64", media_type: "image/png", data: imageLargeBase64 } });
      }
      if (imageSerreeBase64) {
          contentPayload.push({ type: "text", text: "Vue zoomée :" });
          contentPayload.push({ type: "image", source: { type: "base64", media_type: "image/png", data: imageSerreeBase64 } });
      }
      contentPayload.push({ type: "text", text: contextualizedPrompt });

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1000,
          temperature: 0.2,
          system: systemInstruction,
          messages: [{ role: 'user', content: contentPayload }]
        })
      });

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      
      let rawText = data.content?.[0]?.text.trim() || "{}";
      let jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/) || rawText.match(/({[\s\S]*?})/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[1] : rawText);
      return res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: "Erreur analyse.", details: error.message });
  }
});

app.get('/api/location-data', async (req, res) => {
    const address = req.query.address;
    if (!address) return res.status(400).json({ error: 'Adresse manquante.' });
    try {
        const data = await getCadastreData(address);
        data ? res.json(data) : res.status(404).json({ error: 'Introuvable' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur opérationnel sur`, process.env.API_URL || `http://localhost:${PORT}`));