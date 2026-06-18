require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); // Autorise votre fichier HTML à interroger ce serveur
app.use(express.json());
app.use(express.static(__dirname)); // Sert les fichiers statiques (HTML, CSS, JS)

const AI_PROVIDER = process.env.AI_PROVIDER || 'anthropic'; 
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'; 

// Vérification des clés au démarrage selon l'IA sélectionnée
if (AI_PROVIDER === 'anthropic' && !ANTHROPIC_API_KEY) {
    console.error("Erreur : La clé API Anthropic n'est pas configurée dans le fichier .env");
    process.exit(1);
}

if (AI_PROVIDER === 'gemini' && !GEMINI_API_KEY) {
    console.error("Erreur : La clé API Gemini n'est pas configurée dans le fichier .env");
    process.exit(1);
}

// Import dynamique de node-fetch
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

/**
 * Récupère les données géographiques et la superficie cadastrale réelle via l'API Etalab
 */
async function getCadastreData(address) {
    try {
        // 1. Convertir l'adresse en coordonnées géographiques
        const geoRes = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`, {
            headers: { 'User-Agent': 'MonCarnetLogementApp/1.0 (contact@example.com)' }
        });
        const geoData = await geoRes.json();
        
        if (!geoData.features || geoData.features.length === 0) return null;
        
        const props = geoData.features[0].properties;
        const [lon, lat] = geoData.features[0].geometry.coordinates;
        const city = props.city;

        // 2. Récupérer le code INSEE depuis l'API adresse (déjà dans props)
        const codeInsee = props.citycode || props.city_code || null;

        // 3. Interroger l'API Cadastre IGN avec une géométrie GeoJSON Point
        // IMPORTANT : lon/lat seuls retournent toute la commune (1000 parcelles).
        // Il faut encoder le point en GeoJSON et passer le code_insee pour filtrer.
        const pointGeom = JSON.stringify({ type: "Point", coordinates: [lon, lat] });
        let cadastreUrl = `https://apicarto.ign.fr/api/cadastre/parcelle?geom=${encodeURIComponent(pointGeom)}`;
        if (codeInsee) cadastreUrl += `&code_insee=${codeInsee}`;

        const cadastreRes = await fetch(cadastreUrl, {
            headers: {
                'User-Agent': 'MonCarnetLogementApp/1.0 (contact@example.com)',
                'Accept': 'application/json'
            }
        });

        console.log(`IGN cadastre status: ${cadastreRes.status} — code_insee: ${codeInsee}`);

        if (cadastreRes.ok) {
            const cadastreData = await cadastreRes.json();
            const count = cadastreData.features?.length ?? 0;
            console.log(`IGN features count: ${count}`);

            if (count > 0) {
                // Trouver la parcelle dont la géométrie contient réellement notre point
                // (au cas où plusieurs features sont retournées, prendre la plus petite superficie = la plus précise)
                const features = cadastreData.features;
                const best = features.reduce((prev, curr) => {
                    const ps = prev.properties.contenance ?? Infinity;
                    const cs = curr.properties.contenance ?? Infinity;
                    return cs < ps ? curr : prev;
                });

                const parcelle = best.properties;
                console.log('IGN parcelle retenue:', JSON.stringify(parcelle, null, 2));

                return {
                    city: city,
                    idParcelle: parcelle.idu ?? 'N/A',
                    superficie: parcelle.contenance ?? null,
                    codeInsee: parcelle.code_insee ?? codeInsee,
                    info: `Données IGN extraites — ${count} feature(s) — parcelle ${parcelle.idu}`
                };
            }
        } else {
            const errBody = await cadastreRes.text();
            console.warn(`Réponse IGN non-OK : ${cadastreRes.status} — ${errBody}`);
        }

        // 3. Fallback : l'IGN n'a pas trouvé la parcelle (adresse hors zone couverte, etc.)
        return {
            city: city,
            idParcelle: "Non récupérée",
            superficie: null,
            info: "Parcelle non localisée dans le référentiel IGN — superficie indisponible"
        };

    } catch (e) {
        console.error("Erreur lors de la récupération du Cadastre:", e);
        return { city: "Inconnue", idParcelle: "Erreur", superficie: null, info: "Erreur technique lors de l'appel cadastre" };
    }
}

app.post('/api/analyse', async (req, res) => {
  try {
    const { prompt, address } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: "Le champ 'prompt' est requis." });
    }

    // Récupération automatique des données réelles du Cadastre français
    const realCadastre = address ? await getCadastreData(address) : null;
    
    if (realCadastre) {
        console.log(`Données cadastrales récupérées pour ${address} :`, realCadastre);
    }

    // Injection des faits réels dans le prompt envoyé à l'IA (RAG)
    let contextualizedPrompt = prompt;
    if (realCadastre) {
        const superficieStr = realCadastre.superficie
            ? `${realCadastre.superficie} mètres carrés`
            : 'Indisponible (parcelle non localisée dans le référentiel IGN)';

        const consigneSuperficie = realCadastre.superficie
            ? `CONSIGNE IMPÉRATIVE : Utilise explicitement la valeur de SUPERFICIE_REELLE_DE_LA_PARCELLE (${realCadastre.superficie} m²) pour justifier tes choix dans le champ "analyse" du JSON.`
            : `CONSIGNE : La superficie cadastrale est indisponible pour cette adresse. Base-toi uniquement sur la commune, le climat régional et la densité urbaine pour estimer la probabilité. Indique confiance "Faible" dans ce cas.`;

        contextualizedPrompt = `Voici les caractéristiques physiques réelles et officielles issues du Cadastre Français (IGN/DGFiP) pour l'adresse demandée :
- COMMUNE : ${realCadastre.city || 'Inconnue'}
- CODE_INSEE : ${realCadastre.codeInsee || 'Inconnu'}
- ID_PARCELLE : ${realCadastre.idParcelle || 'Inconnu'}
- SUPERFICIE_REELLE_DE_LA_PARCELLE : ${superficieStr}
- ETAT_API : ${realCadastre.info || 'OK'}

---
${consigneSuperficie}

${prompt}`;
    }

    let response;
    let data;

    // --- LOGIQUE ANTHROPIC ---
    if (AI_PROVIDER === 'anthropic') {
        response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: ANTHROPIC_MODEL,
                max_tokens: 1000,
                messages: [{ role: 'user', content: contextualizedPrompt }]
            })
        });

        data = await response.json();
        if (!response.ok) return res.status(response.status).json(data);

        return res.json({ text: data.content[0].text, raw: data });
    } 
    
    // --- LOGIQUE GEMINI ---
    else if (AI_PROVIDER === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: contextualizedPrompt }] }]
            })
        });

        data = await response.json();
        if (!response.ok) return res.status(response.status).json(data);

        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!textResponse) {
            return res.status(500).json({ error: "Structure de réponse Gemini inattendue", details: data });
        }

        return res.json({ text: textResponse, raw: data });
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Écoute sur le port 3000
app.listen(3000, () => console.log(`Serveur Hybride (RAG Cadastre) lancé sur http://localhost:3000 [Mode: ${AI_PROVIDER}]`));