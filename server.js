require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const turf = require('@turf/turf');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const https = require('https');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

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

// ──────────────────────────────────────────────────────────────────────────
// CADASTRE : géométrie réelle (et non plus un simple point de centroïde)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Interroge le module Cadastre d'API Carto par intersection géométrique.
 * geomObj doit être un objet GeoJSON (Point ou Polygon).
 */
async function queryParcelles(geomObj, codeInsee) {
    const params = new URLSearchParams();
    params.set('geom', JSON.stringify(geomObj));
    if (codeInsee) params.set('code_insee', codeInsee);
    params.set('source', 'pci');
    const url = `https://apicarto.ign.fr/api/cadastre/parcelle?${params.toString()}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`ApiCarto parcelle a répondu ${res.status} : ${detail.slice(0, 200)}`);
    }
    return res.json();
}

/**
 * Heuristique de détection des parcelles de voirie/domaine public : en zone urbaine, les rues,
 * places et chemins sont souvent cadastrés comme une "parcelle" à part entière dans le PCI.
 * Quand le géocodage BAN tombe dans l'emprise de la voie (très fréquent : le point est
 * interpolé SUR le tracé de la rue), cette parcelle de voirie contient littéralement le point
 * et passe donc le test booleanPointInPolygon — alors qu'elle ne correspond à aucun bien réel.
 *
 * On la repère par sa forme : une parcelle de voirie est très allongée (grande longueur, faible
 * largeur), ce qui se traduit par un ratio périmètre²/aire nettement plus élevé qu'une parcelle
 * "normale" (un carré a un ratio de 16, un rectangle 10×100 m a un ratio proche de 242).
 * Combiné à une surface significative, ce ratio permet de distinguer un linéaire de voie d'une
 * parcelle bâtie classique sans dépendre d'une source de données supplémentaire (BD TOPO, etc.).
 */
function ressembleAUneVoirie(feature) {
    try {
        const aire = turf.area(feature); // m²
        if (aire < 400) return false; // trop petit pour être une voie qui pose problème ici
        const perimetre = turf.length(turf.polygonToLine(feature), { units: 'kilometers' }) * 1000; // m
        const ratio = (perimetre * perimetre) / aire;
        return ratio > 60; // seuil empirique : bien au-dessus d'un rectangle "raisonnable" (~25-30)
    } catch {
        return false;
    }
}

/**
 * Choisit, parmi une liste de features cadastrales, celle dont le centroïde est le plus
 * proche du point donné. Utilisé en repli quand aucune parcelle ne contient littéralement
 * le point (géocodage BAN interpolé sur la voie, imprécision de tracé, etc.).
 */
function parcelleLaPlusProche(features, lon, lat) {
    const pt = turf.point([lon, lat]);
    let meilleure = null;
    let meilleureDistance = Infinity;
    for (const f of features) {
        try {
            const centre = turf.centroid(f);
            const distance = turf.distance(pt, centre, { units: 'kilometers' });
            if (distance < meilleureDistance) {
                meilleureDistance = distance;
                meilleure = f;
            }
        } catch {
            // géométrie invalide pour ce feature : on l'ignore plutôt que de planter tout le calcul
        }
    }
    return { feature: meilleure, distanceKm: meilleureDistance };
}

/**
 * Récupère la parcelle exacte contenant un point, puis les parcelles dont la géométrie
 * touche ou recoupe un buffer autour de cette parcelle (= parcelles "contiguës" candidates).
 * Le regroupement final (quelles parcelles appartiennent réellement au même bien) reste
 * une décision humaine : on ne fait ici que proposer les voisines plausibles.
 *
 * Le point passé en entrée vient du géocodage de la BAN, qui est parfois interpolé le long
 * de la voie plutôt qu'exactement positionné sur le bâtiment : il peut donc tomber juste à
 * côté de la parcelle réelle. matchType indique la méthode utilisée pour identifier la
 * parcelle principale ('point_exact' | 'centroide_proche' | 'premier_resultat_brut').
 */
async function getParcelleEtVoisines(lon, lat, codeInsee) {
    const pointGeom = { type: 'Point', coordinates: [lon, lat] };
    let resultPoint = await queryParcelles(pointGeom, codeInsee);
    let matchType = 'point_exact';

    // Le géocodage de la BAN interpole souvent le numéro le long du tracé de la voie : le
    // point obtenu peut tomber légèrement à côté de la parcelle réelle (dans la rue, sur la
    // parcelle voisine, etc.), ou carrément À L'INTÉRIEUR de la parcelle cadastrale de la
    // voie elle-même (la rue est souvent sa propre "parcelle" dans le PCI). On exclut donc ce
    // cas du match "point exact", sinon on validerait à tort la parcelle de voirie.
    let principale = (resultPoint.features || []).find(f => {
        try {
            return turf.booleanPointInPolygon(turf.point([lon, lat]), f) && !ressembleAUneVoirie(f);
        } catch {
            return false;
        }
    }) || null;

    // Repli n°1 : aucune des parcelles retournées par la requête ponctuelle ne contient le
    // point (ou seule une parcelle de voirie le contient). On élargit la recherche dans un
    // petit rayon (35 m) autour du point BAN et on prend, parmi les parcelles qui ne
    // ressemblent pas à de la voirie, celle dont le centroïde est le plus proche — bien plus
    // fiable que de prendre arbitrairement le premier résultat de l'API.
    if (!principale) {
        matchType = 'centroide_proche';
        try {
            const zoneRecherche = turf.buffer(turf.point([lon, lat]), 0.035, { units: 'kilometers' });
            const resultZoneElargie = await queryParcelles(zoneRecherche.geometry, codeInsee);
            const candidatsBruts = resultZoneElargie.features || resultPoint.features || [];
            const candidats = candidatsBruts.filter(f => !ressembleAUneVoirie(f));
            const poolFinal = candidats.length > 0 ? candidats : candidatsBruts; // si tout ressemble à de la voirie, mieux vaut prendre quand même le plus proche que rien
            if (poolFinal.length > 0) {
                const { feature } = parcelleLaPlusProche(poolFinal, lon, lat);
                principale = feature;
                resultPoint = resultZoneElargie; // pour que le calcul des voisines réutilise le même jeu de données
            }
        } catch (e) {
            console.error('Erreur repli centroïde le plus proche :', e.message);
        }
    }

    // Repli n°2 (filet de sécurité ultime) : même la recherche élargie n'a rien donné, on
    // revient au comportement précédent plutôt que d'échouer complètement.
    if (!principale && resultPoint.features && resultPoint.features.length > 0) {
        principale = resultPoint.features[0];
        matchType = 'premier_resultat_brut';
    }

    if (!principale) {
        return { principale: null, voisines: [], matchType: 'aucune_parcelle' };
    }

    // Rayon de recherche des voisines : l'ancien buffer fixe de 15 m était trop court dès que
    // la parcelle principale est petite (ex: maison sur un terrain de 300-400 m²) alors que la
    // piscine ou l'annexe du même bien peut être sur une parcelle distincte à 30-50 m du bord
    // — cas fréquent en zone pavillonnaire avec grand jardin. On élargit à 35 m : assez pour
    // couvrir ce genre de cas, sans capter des parcelles clairement extérieures au bien (un
    // voisin de l'autre côté de la rue, par exemple).
    let voisines = [];
    try {
        const buffered = turf.buffer(principale, 0.035, { units: 'kilometers' });
        const bufferBbox = turf.bbox(buffered);
        const bboxPolygon = turf.bboxPolygon(bufferBbox);
        const resultZone = await queryParcelles(bboxPolygon.geometry, codeInsee);

        const idPrincipale = principale.properties?.idu;
        voisines = (resultZone.features || []).filter(f => {
            if (f.properties?.idu === idPrincipale) return false;
            try {
                return turf.booleanIntersects(f, buffered);
            } catch {
                return false;
            }
        });
    } catch (e) {
        console.error('Erreur recherche parcelles voisines :', e.message);
    }

    return { principale, voisines, matchType };
}

async function getCadastreData(address) {
    const urlAdresses = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`;
    const resAddr = await fetchWithRetry(urlAdresses);
    if (!resAddr.ok) throw new Error(`API Adresse a répondu ${resAddr.status}`);
    const jsonAddr = await resAddr.json();

    if (!jsonAddr.features || jsonAddr.features.length === 0) return null;

    const feature = jsonAddr.features[0];
    const [lon, lat] = feature.geometry.coordinates;
    const codeInsee = feature.properties.citycode;
    const city = feature.properties.city;
    // "housenumber" = la BAN a bien géocodé ce numéro précis ; "street"/"locality" = position
    // approximative (interpolée sur la voie ou la localité), donc plus susceptible de tomber
    // légèrement à côté de la bonne parcelle cadastrale.
    const geocodeType = feature.properties.type;
    const geocodeScore = feature.properties.score;

    const { principale, voisines, matchType } = await getParcelleEtVoisines(lon, lat, codeInsee);

    if (!principale) {
        return {
            lon, lat, codeInsee, city,
            idParcelle: null, superficie: null,
            parcellePrincipale: null, parcellesVoisines: [],
            geocodeType, geocodeScore, matchType,
            info: 'Aucune parcelle cadastrale trouvée à ces coordonnées (ApiCarto IGN).'
        };
    }

    return {
        lon, lat, codeInsee, city,
        idParcelle: principale.properties.idu,
        superficie: principale.properties.contenance || null,
        parcellePrincipale: principale,
        parcellesVoisines: voisines.map(v => ({
            idu: v.properties.idu,
            numero: v.properties.numero,
            section: v.properties.section,
            contenance: v.properties.contenance,
            geometry: v.geometry
        })),
        geocodeType,
        geocodeScore,
        matchType,
        info: 'OK'
    };
}

// ──────────────────────────────────────────────────────────────────────────
// IMAGE SATELLITE CADRÉE SUR LA PARCELLE (OU LE GROUPE DE PARCELLES)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Calcule la bbox (en degrés) d'une géométrie (Feature, FeatureCollection ou liste de Features)
 * avec une marge proportionnelle, pour cadrer l'image satellite sur le bien réel et non
 * sur un delta fixe autour d'un point qui peut être décentré par rapport à la parcelle.
 */
function bboxAvecMarge(geojsonOuListe, margeRatio = 0.18) {
    const collection = Array.isArray(geojsonOuListe)
        ? turf.featureCollection(geojsonOuListe)
        : geojsonOuListe;
    const [minLon, minLat, maxLon, maxLat] = turf.bbox(collection);
    const largeur = maxLon - minLon;
    const hauteur = maxLat - minLat;
    // Marge minimale absolue pour les très petites parcelles (sinon la bbox serait trop serrée
    // pour voir un bassin ou des panneaux qui dépassent légèrement du tracé cadastral).
    const margeLon = Math.max(largeur * margeRatio, 0.00025);
    const margeLat = Math.max(hauteur * margeRatio, 0.00018);
    return [minLon - margeLon, minLat - margeLat, maxLon + margeLon, maxLat + margeLat];
}

async function fetchSatelliteImageBuffer(bbox, widthPx = 800, heightPx = 800) {
    try {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        const wmsBbox = `${minLat},${minLon},${maxLat},${maxLon}`;
        const wmsUrl = `https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ORTHOIMAGERY.ORTHOPHOTOS&STYLES=&CRS=EPSG:4326&BBOX=${wmsBbox}&WIDTH=${widthPx}&HEIGHT=${heightPx}&FORMAT=image/png`;

        const response = await fetch(wmsUrl);
        if (!response.ok) return null;

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) {
        console.error('Erreur récupération image IGN :', e);
        return null;
    }
}

/**
 * Convertit une coordonnée géographique en pixel dans l'image générée par fetchSatelliteImageBuffer,
 * pour pouvoir dessiner le contour de la/des parcelle(s) par-dessus l'image satellite.
 */
function lonLatToPixel(lon, lat, bbox, widthPx, heightPx) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const x = ((lon - minLon) / (maxLon - minLon)) * widthPx;
    const y = ((maxLat - lat) / (maxLat - minLat)) * heightPx;
    return [x, y];
}

/**
 * Génère un overlay SVG (composité en PNG) traçant le contour des parcelles sélectionnées
 * par-dessus l'image satellite, pour que l'IA sache visuellement où s'arrête le bien analysé.
 */
async function genererImageAvecContour(satelliteBuffer, parcellesGeoJSON, bbox, widthPx, heightPx) {
    const sharp = require('sharp');

    let pathData = '';
    for (const feature of parcellesGeoJSON) {
        const polygons = feature.geometry.type === 'MultiPolygon'
            ? feature.geometry.coordinates
            : [feature.geometry.coordinates];
        for (const polygon of polygons) {
            for (const ring of polygon) {
                const pts = ring.map(([lon, lat]) => lonLatToPixel(lon, lat, bbox, widthPx, heightPx));
                pathData += 'M' + pts.map(p => p.join(',')).join('L') + 'Z ';
            }
        }
    }

    const svgOverlay = `
        <svg width="${widthPx}" height="${heightPx}" xmlns="http://www.w3.org/2000/svg">
            <path d="${pathData}" fill="rgba(255,40,40,0.08)" stroke="#FF2828" stroke-width="4" stroke-dasharray="10,6"/>
        </svg>`;

    const composite = await sharp(satelliteBuffer)
        .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
        .png()
        .toBuffer();

    return composite;
}

// ──────────────────────────────────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────────────────────────────────

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

/**
 * POST /api/analyze
 * Body attendu :
 * {
 *   codeInsee: string,
 *   parcelles: GeoJSON.Feature[]   // parcelle principale + voisines cochées par l'utilisateur
 * }
 *
 * Sortie volontairement minimale (coût des tokens de sortie) :
 * {
 *   pool: boolean,
 *   pool_confidence: number (0-1),
 *   solar: boolean,
 *   solar_confidence: number (0-1),
 *   image_base64: string   // pour vérification visuelle par l'utilisateur
 * }
 */
app.post('/api/analyze', async (req, res) => {
    const { parcelles } = req.body;

    if (!Array.isArray(parcelles) || parcelles.length === 0) {
        return res.status(400).json({ error: 'Au moins une parcelle est requise.' });
    }

    try {
        const bbox = bboxAvecMarge(parcelles);
        const WIDTH = 800, HEIGHT = 800;

        const satelliteBuffer = await fetchSatelliteImageBuffer(bbox, WIDTH, HEIGHT);
        if (!satelliteBuffer) {
            return res.status(502).json({ error: "Impossible de récupérer l'image satellite IGN pour cette zone." });
        }

        const imageAvecContour = await genererImageAvecContour(satelliteBuffer, parcelles, bbox, WIDTH, HEIGHT);

        const systemInstruction = `Tu es un expert en photo-interprétation de vues aériennes cadastrales. ` +
            `Le contour en pointillés rouges délimite STRICTEMENT la parcelle (ou le groupe de parcelles) à analyser. ` +
            `Ignore tout équipement situé hors de ce contour, même s'il est visible sur l'image. ` +
            `Réponds UNIQUEMENT par un objet JSON valide, sans aucun texte avant ou après, sans bloc de code markdown. ` +
            `Le JSON doit contenir exactement ces clés : ` +
            `{"pool": boolean, "pool_confidence": number entre 0 et 1, "solar": boolean, "solar_confidence": number entre 0 et 1}. ` +
            `pool = présence d'un bassin de piscine (eau visible, structure de bassin) à l'intérieur du contour. ` +
            `solar = présence de panneaux photovoltaïques sur une toiture ou au sol à l'intérieur du contour. ` +
            `confidence = ta confiance dans le verdict (0 = incertain, 1 = certain), tenant compte de la résolution image, ` +
            `des ombres, de la qualité de la vue et de toute ambiguïté visuelle. Ne donne aucune explication textuelle.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: ANTHROPIC_MODEL,
                max_tokens: 150,
                temperature: 0,
                system: systemInstruction,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageAvecContour.toString('base64') } },
                        { type: 'text', text: 'Analyse la parcelle délimitée par le contour rouge. Réponds en JSON strict.' }
                    ]
                }]
            })
        });

        const data = await response.json();
        if (!response.ok) return res.status(response.status).json(data);

        let rawText = (data.content?.[0]?.text || '{}').trim();
        let jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/) || rawText.match(/({[\s\S]*?})/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[1] : rawText);

        return res.json({
            pool: !!parsed.pool,
            pool_confidence: typeof parsed.pool_confidence === 'number' ? parsed.pool_confidence : null,
            solar: !!parsed.solar,
            solar_confidence: typeof parsed.solar_confidence === 'number' ? parsed.solar_confidence : null,
            image_base64: imageAvecContour.toString('base64')
        });
    } catch (error) {
        res.status(500).json({ error: 'Erreur analyse.', details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur opérationnel sur`, process.env.API_URL || `http://localhost:${PORT}`));