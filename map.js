// =============================================================================
// CONFIG
// =============================================================================

const API_BASE_URL = "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-annuaire-education/records";
const OSRM_BASE_URL = "https://router.project-osrm.org";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Département lu dans l'URL (?dept=044), 044 par défaut
const DEPT_ACTIF = new URLSearchParams(window.location.search).get("dept") || "044";

// Filtre API : uniquement les écoles publiques avec au moins un cycle renseigné
const API_FILTRE = `code_departement="${DEPT_ACTIF}" AND statut_public_prive="Public" AND ecole_maternelle IS NOT NULL AND ecole_elementaire IS NOT NULL`;

const API_PAGE_SIZE = 100; // nombre de résultats par requête (max autorisé par l'API)
const OSRM_BATCH_SIZE = 100; // nombre d'écoles envoyées en une seule requête OSRM table

// Décalage en degrés appliqué quand plusieurs écoles partagent exactement les mêmes coordonnées,
// pour qu'elles restent cliquables séparément (~3 mètres).
const COORDS_OFFSET_DEG = 0.00003;

// Seuils de durée (minutes) pour la palette de couleurs des marqueurs
const SEUILS_DUREE = { vert: 20, orange: 30, rouge: 40 };
const COULEURS_DUREE = {
  nonCalculee: "#7c85ff", // violet (état initial)
  vert:        "#22c55e", // ≤ 20 min
  orange:      "#f97316", // ≤ 30 min
  rouge:       "#ef4444", // ≤ 40 min
  noir:        "#111827", // > 40 min
};

// Palette cyclique pour colorier les circonscriptions (20 couleurs distinctes)
const PALETTE_CIRCONSCRIPTIONS = [
  "#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00",
  "#ffff33", "#a65628", "#f781bf", "#1b9e77", "#d95f02",
  "#7570b3", "#e7298a", "#66a61e", "#e6ab02", "#a6761d",
  "#666666", "#1f78b4", "#6a3d9a", "#33a02c", "#e31a1c",
];

// Valeurs possibles du filtre rythme scolaire
const RYTHME = {
  TOUS:       "tous",
  QUATRE_J:   "4j",
  QUATRE_5J:  "4-5j",
};

// Libellés affichés dans les badges / la liste / la popup
const RYTHME_LABEL = {
  "4 jours":   "4 jours",
  "4,5 jours": "4,5 jours",
};

// Couleurs des badges rythme (fond + texte)
const RYTHME_STYLE = {
  "4 jours":   { bg: "#14532d", color: "#4ade80", icone: "📅" }, // vert
  "4,5 jours": { bg: "#1e3a5f", color: "#60a5fa", icone: "📆" }, // bleu
};


// =============================================================================
// ÉTAT GLOBAL
// =============================================================================

// Liste des entrées { marker: L.CircleMarker, ecole: {...}, dureeMin, distKm, visible }
let marqueurs = [];

// Marqueur 📍 positionné à l'adresse de référence saisie par l'utilisateur
let marqueurReference = null;

// Coordonnées { lat, lng } de l'adresse de référence (null si non renseignée)
let coordsReference = null;

// Onglet actif dans le panneau latéral : "distances" ou "circonscriptions"
let ongletActif = "distances";

// Map nom de circonscription → couleur hex (construit au chargement)
let couleursCirconscriptions = {};

// Map nom de circonscription → L.Polygon affiché sur la carte
let polygonesCirconscriptions = {};

// Set des UAI (identifiants) des écoles à 4 jours — chargé depuis ecoles_4_jours_44.json
const uaisEcoles4Jours = new Set();


// =============================================================================
// INITIALISATION DE LA CARTE
// =============================================================================

const map = L.map("map").setView([46.5, 2.5], 6);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);


// =============================================================================
// RYTHME SCOLAIRE (4 jours / 4,5 jours) — dept 044 uniquement
// =============================================================================

/**
 * Charge le fichier ecoles_4_jours_44.json et remplit le Set uaisEcoles4Jours.
 * Le fichier peut contenir des objets { uai } ou { identifiant_de_l_etablissement }
 * ou directement des chaînes UAI.
 * Une fois chargé, injecte le sélecteur de filtre rythme dans le header.
 */
async function chargerEcoles4Jours() {
  if (DEPT_ACTIF !== "044") return;

  try {
    const reponse = await fetch("ecoles_4_jours_44.json");
    if (!reponse.ok) return;

    const donnees = await reponse.json();
    donnees.forEach(entree => {
      const uai = typeof entree === "string"
        ? entree
        : (entree.uai || entree.identifiant_de_l_etablissement || "");
      if (uai) uaisEcoles4Jours.add(uai.trim().toUpperCase());
    });

    console.log(`Rythme 4 jours : ${uaisEcoles4Jours.size} écoles chargées.`);
    injecterFiltreRythme();

  } catch (erreur) {
    console.warn("Impossible de charger ecoles_4_jours_44.json :", erreur);
  }
}

/**
 * Retourne le rythme scolaire d'une école sous forme de chaîne :
 *   "4 jours" si l'UAI est dans le Set, "4,5 jours" sinon.
 * Retourne null pour les départements autres que 044.
 */
function getRythmeEcole(ecole) {
  if (DEPT_ACTIF !== "044") return null;
  const uai = String(ecole.identifiant || "").trim().toUpperCase();
  return uaisEcoles4Jours.has(uai) ? "4 jours" : "4,5 jours";
}

/**
 * Injecte dynamiquement le sélecteur "Rythme" dans le header,
 * juste avant la légende de couleurs.
 * N'est appelé qu'une seule fois, uniquement pour le dept 044.
 */
function injecterFiltreRythme() {
  if (document.getElementById("filtre-rythme")) return; // garde-fou : déjà injecté

  const header  = document.querySelector("header");
  const legende = document.getElementById("legende-distances");

  // Libellé
  const label = document.createElement("span");
  label.style.cssText = "font-size:0.78rem;color:#b0b8d0;white-space:nowrap;";
  label.textContent = "Rythme :";

  // Selecteur
  const select = document.createElement("select");
  select.id        = "filtre-rythme";
  select.className = "dept-select";
  select.style.cssText = "max-width:140px;";

  const options = [
    { value: RYTHME.TOUS,      label: "Tous" },
    { value: RYTHME.QUATRE_J,  label: "📅 4 jours" },
    { value: RYTHME.QUATRE_5J, label: "📆 4,5 jours" },
  ];
  options.forEach(({ value, label: texte }) => {
    const option = document.createElement("option");
    option.value       = value;
    option.textContent = texte;
    select.appendChild(option);
  });
  select.addEventListener("change", appliquerFiltres);

  // Conteneur
  const wrapper = document.createElement("div");
  wrapper.id = "filtre-rythme-wrapper";
  wrapper.style.cssText = "display:flex;align-items:center;gap:6px;";
  wrapper.appendChild(label);
  wrapper.appendChild(select);

  // Insertion dans le header avant la légende
  if (legende) header.insertBefore(wrapper, legende);
  else header.appendChild(wrapper);
}


// =============================================================================
// CHARGEMENT DES DONNÉES (API éducation nationale)
// =============================================================================

/**
 * Point d'entrée principal : charge toutes les données et initialise la carte.
 */
async function initialiserApplication() {
  afficherLoader(true);

  // Les deux chargements peuvent se faire en parallèle
  await Promise.all([
    chargerEcoles4Jours(),
    chargerEtablissements(),
  ]);

  afficherLoader(false);
  mettreAJourCompteur();
  mettreAJourTitreDept();
  centrerCarteEtablissements();
  rafraichirPanneauLateral();
}

/**
 * Récupère tous les établissements du département via l'API en paginant
 * par tranches de API_PAGE_SIZE, puis initialise les marqueurs.
 */
async function chargerEtablissements() {
  const loaderProgression = document.getElementById("loader-progress");

  let tousLesResultats = [];
  let offset     = 0;
  let totalCount = null;

  // Pagination : on boucle jusqu'à avoir tout récupéré
  do {
    const url = `${API_BASE_URL}?where=${encodeURIComponent(API_FILTRE)}&limit=${API_PAGE_SIZE}&offset=${offset}`;
    const reponse = await fetch(url);
    const page    = await reponse.json();

    if (totalCount === null) totalCount = page.total_count;
    tousLesResultats = tousLesResultats.concat(page.results);
    offset += API_PAGE_SIZE;

    const pct = Math.round((tousLesResultats.length / totalCount) * 100);
    loaderProgression.textContent = `${tousLesResultats.length} / ${totalCount} (${pct}%)`;

  } while (offset < totalCount);

  // Dédupliquer par identifiant (l'API peut renvoyer des doublons sur certains filtres)
  const etabUniques = dedupliquerParIdentifiant(tousLesResultats);

  assignerCouleursCirconscriptions(etabUniques);
  creerMarqueurs(etabUniques);
}

/**
 * Retourne une liste dédupliquée par identifiant_de_l_etablissement.
 */
function dedupliquerParIdentifiant(etablissements) {
  const vus = new Set();
  return etablissements.filter(etab => {
    const id = etab.identifiant_de_l_etablissement;
    if (vus.has(id)) return false;
    vus.add(id);
    return true;
  });
}

/**
 * Construit la map couleursCirconscriptions en attribuant une couleur
 * de la palette à chaque nom de circonscription (trié alphabétiquement).
 */
function assignerCouleursCirconscriptions(etablissements) {
  const nomsUniques = [...new Set(
    etablissements.map(e => e.nom_circonscription || "Inconnue")
  )].sort();

  nomsUniques.forEach((nom, index) => {
    couleursCirconscriptions[nom] = PALETTE_CIRCONSCRIPTIONS[index % PALETTE_CIRCONSCRIPTIONS.length];
  });
}


// =============================================================================
// MARQUEURS
// =============================================================================

/**
 * Crée un marqueur Leaflet pour chaque établissement valide (avec coordonnées).
 * Applique un léger décalage angulaire aux établissements partageant
 * exactement les mêmes coordonnées GPS pour les rendre tous cliquables.
 */
function creerMarqueurs(etablissements) {
  const etablissementsAvecCoords = etablissements.filter(
    e => e.latitude != null && e.longitude != null
  );

  appliquerDecalageCoords(etablissementsAvecCoords);

  marqueurs = etablissementsAvecCoords.map(etab => {
    const ecole = normaliserEtablissement(etab);

    const marker = L.circleMarker([etab._lat, etab._lng], {
      radius:      6,
      fillColor:   COULEURS_DUREE.nonCalculee,
      color:       "#fff",
      weight:      1.5,
      fillOpacity: 0.9,
    }).addTo(map);

    marker.bindPopup(() => construirePopup(ecole));

    marker.on("click", () => {
      // Au clic : calcul de la distance si une adresse de référence est définie,
      // et mise en surbrillance dans la liste latérale
      if (coordsReference) calculerDistanceUnitaire(ecole);
      surbrillanceListe(ecole.coordsMarqueur.lat, ecole.coordsMarqueur.lng);
    });

    return {
      marker,
      ecole,
      dureeMin: null, // calculé à la demande ou en masse
      distKm:   null,
      visible:  true,
    };
  });
}

/**
 * Transforme un objet brut de l'API en un objet ecole normalisé,
 * avec des noms de champs explicites.
 */
function normaliserEtablissement(etab) {
  return {
    identifiant:      etab.identifiant_de_l_etablissement,
    nom:              etab.nom_etablissement,
    type:             etab.type_etablissement,
    adresse:          [etab.adresse_1, etab.adresse_2, etab.adresse_3].filter(Boolean).join(", "),
    commune:          etab.nom_commune,
    telephone:        etab.telephone   || "—",
    mail:             etab.mail        || "—",
    estMaternelle:    etab.ecole_maternelle   === 1,
    estElementaire:   etab.ecole_elementaire  === 1,
    rep:              etab.appartenance_education_prioritaire || null,
    circonscription:  etab.nom_circonscription || "Inconnue",
    // Coordonnées réelles (pour les requêtes de distance)
    coordsReelles: { lat: etab.latitude,  lng: etab.longitude },
    // Coordonnées du marqueur (légèrement décalées si superposition)
    coordsMarqueur: { lat: etab._lat, lng: etab._lng },
  };
}

/**
 * Pour chaque groupe d'établissements partageant les mêmes coordonnées exactes,
 * applique un décalage angulaire régulier afin qu'ils ne se superposent pas.
 * Les coordonnées décalées sont stockées dans _lat / _lng sur l'objet.
 */
function appliquerDecalageCoords(etablissements) {
  // Compter les occurrences de chaque paire de coordonnées
  const nbParCoords = {};
  etablissements.forEach(e => {
    const cle = `${e.latitude},${e.longitude}`;
    nbParCoords[cle] = (nbParCoords[cle] || 0) + 1;
  });

  // Appliquer le décalage angulaire
  const indexParCoords = {};
  etablissements.forEach(e => {
    const cle   = `${e.latitude},${e.longitude}`;
    const total = nbParCoords[cle];

    if (total > 1) {
      const index = indexParCoords[cle] || 0;
      const angle = (2 * Math.PI * index) / total;
      e._lat = e.latitude  + COORDS_OFFSET_DEG * Math.cos(angle);
      e._lng = e.longitude + COORDS_OFFSET_DEG * Math.sin(angle);
      indexParCoords[cle] = index + 1;
    } else {
      e._lat = e.latitude;
      e._lng = e.longitude;
    }
  });
}

/**
 * Retourne la couleur de marqueur correspondant à une durée en minutes.
 */
function couleurPourDuree(dureeMin) {
  if (dureeMin === null || dureeMin === undefined) return COULEURS_DUREE.nonCalculee;
  if (dureeMin <= SEUILS_DUREE.vert)   return COULEURS_DUREE.vert;
  if (dureeMin <= SEUILS_DUREE.orange) return COULEURS_DUREE.orange;
  if (dureeMin <= SEUILS_DUREE.rouge)  return COULEURS_DUREE.rouge;
  return COULEURS_DUREE.noir;
}

/**
 * Met à jour la couleur de remplissage de tous les marqueurs visibles
 * selon l'onglet actif (distance ou circonscription).
 */
function rafraichirCouleursMarqueurs() {
  marqueurs.forEach(({ marker, ecole, dureeMin, visible }) => {
    if (!visible) return;
    const couleur = ongletActif === "circonscriptions"
      ? (couleursCirconscriptions[ecole.circonscription] || "#888")
      : couleurPourDuree(dureeMin);
    marker.setStyle({ fillColor: couleur });
  });
}


// =============================================================================
// POPUP
// =============================================================================

/**
 * Construit et retourne le HTML de la popup Leaflet pour une école.
 * La ligne "Rythme" n'est affichée que pour le département 044.
 */
function construirePopup(ecole) {
  const couleurCirco = couleursCirconscriptions[ecole.circonscription] || "#888";
  const rythme       = getRythmeEcole(ecole);
  const styleRythme  = rythme ? RYTHME_STYLE[rythme] : null;

  const ligneRep = ecole.rep
    ? `<div class="row">
         <span class="label">Prioritaire</span>
         <span class="tag-rep tag-rep-${ecole.rep.replace("+", "plus")}">${ecole.rep}</span>
       </div>`
    : "";

  const ligneRythme = styleRythme
    ? `<div class="row">
         <span class="label">Rythme</span>
         <span style="display:inline-flex;align-items:center;gap:4px;
                      background:${styleRythme.bg};color:${styleRythme.color};
                      font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px">
           ${styleRythme.icone} ${rythme}
         </span>
       </div>`
    : "";

  return `
    <div class="popup-box">
      <h3>${ecole.nom}</h3>
      <span class="tag">${ecole.type}</span>

      <div class="row" style="align-items:flex-start">
        <span class="label" style="flex-shrink:0">Circonscription</span>
        <span style="display:flex;align-items:flex-start;gap:5px">
          <span style="width:10px;height:10px;border-radius:50%;background:${couleurCirco};
                       flex-shrink:0;margin-top:2px"></span>
          <span>${ecole.circonscription}</span>
        </span>
      </div>

      <div class="row"><span class="label">Commune</span><span>${ecole.commune}</span></div>
      <div class="row"><span class="label">Adresse</span><span>${ecole.adresse}</span></div>
      <div class="row"><span class="label">Tél.</span><span>${ecole.telephone}</span></div>
      <div class="row"><span class="label">Mail</span><span>${ecole.mail}</span></div>
      ${ligneRep}
      <div class="row"><span class="label">Maternelle</span><span>${ecole.estMaternelle  ? "✓" : "—"}</span></div>
      <div class="row"><span class="label">Élémentaire</span><span>${ecole.estElementaire ? "✓" : "—"}</span></div>
      ${ligneRythme}
      <div class="row" id="dist-${ecole.identifiant}">
        <span class="label">Distance</span><span>—</span>
      </div>
    </div>
  `;
}


// =============================================================================
// ONGLETS (Distances / Circonscriptions)
// =============================================================================

/**
 * Bascule entre les onglets "distances" et "circonscriptions".
 * Met à jour l'UI, les polygones et les couleurs des marqueurs.
 */
function basculerOnglet(nouvelOnglet) {
  ongletActif = nouvelOnglet;

  document.getElementById("tab-distances").classList.toggle("actif", nouvelOnglet === "distances");
  document.getElementById("tab-circo").classList.toggle("actif", nouvelOnglet === "circonscriptions");

  if (nouvelOnglet === "circonscriptions") dessinerPolygones();
  else effacerPolygones();

  rafraichirCouleursMarqueurs();
  rafraichirPanneauLateral();
}

document.getElementById("tab-distances").addEventListener("click", () => basculerOnglet("distances"));
document.getElementById("tab-circo").addEventListener("click",     () => basculerOnglet("circonscriptions"));


// =============================================================================
// POLYGONES DE CIRCONSCRIPTION (Convex Hull)
// =============================================================================

/**
 * Dessine un polygone (convex hull) pour chaque circonscription visible.
 * Les polygones précédents sont d'abord supprimés.
 */
function dessinerPolygones() {
  effacerPolygones();

  // Regrouper les coordonnées des écoles visibles par circonscription
  const pointsParCirco = {};
  marqueurs.forEach(({ ecole, visible }) => {
    if (!visible) return;
    if (!pointsParCirco[ecole.circonscription]) pointsParCirco[ecole.circonscription] = [];
    pointsParCirco[ecole.circonscription].push([ecole.coordsReelles.lat, ecole.coordsReelles.lng]);
  });

  Object.entries(pointsParCirco).forEach(([nom, points]) => {
    if (points.length < 2) return;

    const couleur  = couleursCirconscriptions[nom] || "#888";
    const contour  = points.length >= 3 ? calculerConvexHull(points) : points;

    const polygone = L.polygon(contour, {
      color:       couleur,
      weight:      2,
      opacity:     0.9,
      fillColor:   couleur,
      fillOpacity: 0.25,
      dashArray:   "5,4",
      interactive: false,
    }).addTo(map);

    polygone.bindTooltip(nom, { sticky: false, direction: "center", className: "circo-tooltip" });
    polygonesCirconscriptions[nom] = polygone;
  });
}

/** Supprime tous les polygones de circonscription de la carte. */
function effacerPolygones() {
  Object.values(polygonesCirconscriptions).forEach(poly => poly.remove());
  polygonesCirconscriptions = {};
}

/**
 * Calcule l'enveloppe convexe (convex hull) d'un ensemble de points 2D
 * via l'algorithme de Graham scan.
 * @param {Array<[number, number]>} points
 * @returns {Array<[number, number]>}
 */
function calculerConvexHull(points) {
  if (points.length < 3) return points;

  const tries = points.slice().sort(([ax, ay], [bx, by]) => ax !== bx ? ax - bx : ay - by);

  function produitVectoriel([ox, oy], [ax, ay], [bx, by]) {
    return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
  }

  const coque = enveloppeMonotone(tries, produitVectoriel);
  return coque;
}

function enveloppeMonotone(pointsTries, produitVectoriel) {
  const bas = [];
  for (const p of pointsTries) {
    while (bas.length >= 2 && produitVectoriel(bas[bas.length - 2], bas[bas.length - 1], p) <= 0)
      bas.pop();
    bas.push(p);
  }

  const haut = [];
  for (let i = pointsTries.length - 1; i >= 0; i--) {
    const p = pointsTries[i];
    while (haut.length >= 2 && produitVectoriel(haut[haut.length - 2], haut[haut.length - 1], p) <= 0)
      haut.pop();
    haut.push(p);
  }

  bas.pop();
  haut.pop();
  return bas.concat(haut);
}


// =============================================================================
// FILTRES
// =============================================================================

/**
 * Applique tous les filtres actifs (type d'école, REP, rythme scolaire)
 * et met à jour la visibilité de chaque marqueur.
 */
function appliquerFiltres() {
  const afficherMaternelle = document.getElementById("filtre-maternelle").checked;
  const afficherElementaire = document.getElementById("filtre-elementaire").checked;
  const afficherRep         = document.getElementById("filtre-rep").checked;
  const afficherRepPlus     = document.getElementById("filtre-rep-plus").checked;

  // Le sélecteur rythme n'existe que pour le dept 044
  const selectRythme  = document.getElementById("filtre-rythme");
  const filtreRythme  = selectRythme ? selectRythme.value : RYTHME.TOUS;

  let nbVisibles = 0;

  marqueurs.forEach(entree => {
    const ecole = entree.ecole;

    const ecoleEstSeulementMaternelle  = ecole.estMaternelle  && !ecole.estElementaire;
    const ecoleEstSeulementElementaire = ecole.estElementaire && !ecole.estMaternelle;
    const ecoleEstLesDeux              = ecole.estMaternelle  && ecole.estElementaire;

    const okType = (
      (!ecoleEstSeulementMaternelle  || afficherMaternelle) &&
      (!ecoleEstSeulementElementaire || afficherElementaire) &&
      (!ecoleEstLesDeux              || afficherMaternelle || afficherElementaire)
    );

    const okRep = (
      (ecole.rep !== "REP"  || afficherRep) &&
      (ecole.rep !== "REP+" || afficherRepPlus)
    );

    let okRythme = true;
    if (filtreRythme !== RYTHME.TOUS) {
      const rythme = getRythmeEcole(ecole);
      okRythme = filtreRythme === RYTHME.QUATRE_J
        ? rythme === "4 jours"
        : rythme === "4,5 jours";
    }

    entree.visible = okType && okRep && okRythme;

    if (entree.visible) { entree.marker.addTo(map); nbVisibles++; }
    else                  entree.marker.remove();
  });

  document.getElementById("counter").textContent = `${nbVisibles} établissements`;
  rafraichirCouleursMarqueurs();
  if (ongletActif === "circonscriptions") dessinerPolygones();
  rafraichirPanneauLateral();
}

document.getElementById("filtre-maternelle").addEventListener("change",  appliquerFiltres);
document.getElementById("filtre-elementaire").addEventListener("change", appliquerFiltres);
document.getElementById("filtre-rep").addEventListener("change",         appliquerFiltres);
document.getElementById("filtre-rep-plus").addEventListener("change",    appliquerFiltres);
// Le filtre rythme est injecté dynamiquement — son listener est ajouté dans injecterFiltreRythme()


// =============================================================================
// GÉOCODAGE (Nominatim)
// =============================================================================

/**
 * Géocode une adresse via Nominatim et retourne { lat, lng, label }.
 * @throws {Error} si aucun résultat n'est trouvé
 */
async function geocoderAdresse(adresse) {
  const url = `${NOMINATIM_URL}?format=json&q=${encodeURIComponent(adresse)}&limit=1`;
  const reponse = await fetch(url, { headers: { "Accept-Language": "fr" } });
  const resultats = await reponse.json();

  if (!resultats.length) throw new Error("Adresse introuvable");

  return {
    lat:   parseFloat(resultats[0].lat),
    lng:   parseFloat(resultats[0].lon),
    label: resultats[0].display_name,
  };
}

document.getElementById("form-adresse").addEventListener("submit", async e => {
  e.preventDefault();

  const champAdresse  = document.getElementById("input-adresse");
  const statusAdresse = document.getElementById("status-adresse");
  statusAdresse.textContent = "Recherche...";

  try {
    const resultat = await geocoderAdresse(champAdresse.value);
    coordsReference = resultat;

    // Remplacer l'éventuel marqueur précédent
    if (marqueurReference) marqueurReference.remove();
    marqueurReference = L.marker([resultat.lat, resultat.lng], {
      icon: L.divIcon({ className: "ref-icon", html: "📍", iconSize: [24, 24] }),
    }).addTo(map).bindPopup("📍 Adresse de référence").openPopup();

    map.setView([resultat.lat, resultat.lng], 10);
    statusAdresse.textContent = "✓ " + resultat.label.split(",").slice(0, 2).join(",");
    document.getElementById("btn-calc").style.display = "inline-block";
    rafraichirPanneauLateral();

  } catch {
    statusAdresse.textContent = "❌ Adresse introuvable";
  }
});


// =============================================================================
// CALCUL DE DISTANCES (OSRM)
// =============================================================================

/**
 * Calcule la distance et la durée entre l'adresse de référence et UNE école.
 * Met à jour l'entrée du marqueur et la ligne "Distance" de la popup si ouverte.
 * Si la distance a déjà été calculée, l'affiche directement.
 */
async function calculerDistanceUnitaire(ecole) {
  const lignePopup = document.getElementById(`dist-${ecole.identifiant}`);
  const entree     = marqueurs.find(m => m.ecole.identifiant === ecole.identifiant);

  // Distance déjà connue : on l'affiche sans refaire la requête
  if (entree?.dureeMin !== null) {
    if (lignePopup) lignePopup.querySelector("span:last-child").textContent =
      `${entree.dureeMin} min — ${entree.distKm} km`;
    return;
  }

  try {
    const url = `${OSRM_BASE_URL}/route/v1/driving/` +
      `${coordsReference.lng},${coordsReference.lat};` +
      `${ecole.coordsReelles.lng},${ecole.coordsReelles.lat}?overview=false`;

    const reponse = await fetch(url);
    const donnees = await reponse.json();
    if (donnees.code !== "Ok") return;

    const dureeMin = Math.round(donnees.routes[0].duration / 60);
    const distKm   = parseFloat((donnees.routes[0].distance / 1000).toFixed(1));

    if (entree) {
      entree.dureeMin = dureeMin;
      entree.distKm   = distKm;
      if (ongletActif === "distances")
        entree.marker.setStyle({ fillColor: couleurPourDuree(dureeMin) });
    }

    if (lignePopup) lignePopup.querySelector("span:last-child").textContent =
      `${dureeMin} min — ${distKm} km`;

  } catch { /* échec silencieux */ }
}

/**
 * Calcule les distances entre l'adresse de référence et TOUTES les écoles
 * via l'API OSRM /table, par lots de OSRM_BATCH_SIZE pour rester dans les limites.
 * Met à jour la progression et rafraîchit la carte à chaque lot.
 */
async function calculerToutesLesDistances() {
  if (!coordsReference) return;

  const boutonCalcul = document.getElementById("btn-calc");
  boutonCalcul.disabled = true;

  // Réinitialiser toutes les distances
  marqueurs.forEach(m => { m.dureeMin = null; m.distKm = null; });

  const total = marqueurs.length;
  let traites = 0;
  mettreAJourProgression(0, total);

  // Découper en lots
  const lots = [];
  for (let i = 0; i < marqueurs.length; i += OSRM_BATCH_SIZE)
    lots.push(marqueurs.slice(i, i + OSRM_BATCH_SIZE));

  for (const lot of lots) {
    try {
      // Format OSRM : "lng,lat;lng,lat;..."  — le premier point est la référence
      const coordsString = [
        `${coordsReference.lng},${coordsReference.lat}`,
        ...lot.map(m => `${m.ecole.coordsReelles.lng},${m.ecole.coordsReelles.lat}`),
      ].join(";");

      const url = `${OSRM_BASE_URL}/table/v1/driving/${coordsString}?sources=0&annotations=duration,distance`;
      const reponse = await fetch(url);
      const donnees = await reponse.json();

      if (donnees.code === "Ok") {
        const durees    = donnees.durations[0]; // tableau indexé depuis la source (index 0)
        const distances = donnees.distances ? donnees.distances[0] : null;

        lot.forEach((entree, j) => {
          const dureeSecondes = durees[j + 1]; // +1 car l'index 0 est le point source lui-même
          if (dureeSecondes != null) {
            entree.dureeMin = Math.round(dureeSecondes / 60);
            entree.distKm   = distances
              ? parseFloat((distances[j + 1] / 1000).toFixed(1))
              : null;
          }
        });
      }
    } catch { /* lot ignoré en cas d'erreur réseau */ }

    traites += lot.length;
    mettreAJourProgression(Math.min(traites, total), total);
    rafraichirCouleursMarqueurs();
    rafraichirPanneauLateral();
  }
}

/**
 * Met à jour la barre de progression et le libellé du bouton de calcul.
 */
function mettreAJourProgression(fait, total) {
  const pct           = total > 0 ? Math.round((fait / total) * 100) : 0;
  const bouton        = document.getElementById("btn-calc");
  const barre         = document.getElementById("progress-bar");
  const remplissage   = barre.querySelector(".progress-fill");
  const labelProgres  = document.getElementById("progress-label");

  if (fait === 0) {
    bouton.textContent       = "Calcul... 0%";
    barre.style.display      = "block";
    remplissage.style.width  = "0%";
    labelProgres.textContent = `0 / ${total}`;
  } else if (fait >= total) {
    bouton.textContent       = "Recalculer";
    bouton.disabled          = false;
    barre.style.display      = "none";
    labelProgres.textContent = "";
  } else {
    bouton.textContent       = `Calcul... ${pct}%`;
    remplissage.style.width  = `${pct}%`;
    labelProgres.textContent = `${fait} / ${total}`;
  }
}

document.getElementById("btn-calc").addEventListener("click", calculerToutesLesDistances);


// =============================================================================
// PANNEAU LATÉRAL
// =============================================================================

/**
 * Rafraîchit le panneau latéral selon l'onglet actif.
 */
function rafraichirPanneauLateral() {
  if (ongletActif === "distances") afficherListeDistances();
  else afficherListeCirconscriptions();
}

/**
 * Affiche dans le panneau la liste des écoles visibles,
 * triées par durée croissante (les écoles sans durée calculée en dernier, par ordre alpha).
 */
function afficherListeDistances() {
  const panel = document.getElementById("liste-panel");
  const liste = document.getElementById("liste-etablissements");

  const visibles = marqueurs.filter(m => m.visible);

  // Tri : d'abord par durée croissante, puis alphabétique pour celles sans durée
  const avecDuree  = visibles.filter(m => m.dureeMin !== null)
    .sort((a, b) => a.dureeMin !== b.dureeMin ? a.dureeMin - b.dureeMin : (a.distKm || 0) - (b.distKm || 0));
  const sansDuree  = visibles.filter(m => m.dureeMin === null)
    .sort((a, b) => a.ecole.nom.localeCompare(b.ecole.nom));

  const html = [...avecDuree, ...sansDuree].map(entree => {
    const { ecole, dureeMin, distKm } = entree;
    const couleur = couleurPourDuree(dureeMin);

    const distanceHtml = dureeMin !== null
      ? `<span class="liste-dist">${dureeMin} min · ${distKm} km</span>`
      : `<span class="liste-dist sans-dist">—</span>`;

    const rythme      = getRythmeEcole(ecole);
    const styleRythme = rythme ? RYTHME_STYLE[rythme] : null;
    const rythmeHtml  = styleRythme
      ? `<span style="display:inline-block;flex-shrink:0;font-size:10px;font-weight:700;
                      padding:1px 6px;border-radius:5px;
                      background:${styleRythme.bg};color:${styleRythme.color}">
           ${rythme}
         </span>`
      : "";

    return `
      <div class="liste-item"
           data-lat="${ecole.coordsMarqueur.lat}"
           data-lng="${ecole.coordsMarqueur.lng}"
           title="${ecole.nom} — ${ecole.commune}">
        <span class="liste-dot" style="background:${couleur}"></span>
        <div class="liste-info">
          <div class="liste-nom">${ecole.nom}</div>
          <div class="liste-meta" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
            ${ecole.commune} · ${distanceHtml} ${rythmeHtml}
          </div>
        </div>
      </div>`;
  }).join("");

  liste.innerHTML = html;
  bindClicsListeDistances();
  panel.style.display = "flex";
}

/**
 * Affiche dans le panneau la liste des circonscriptions visibles,
 * avec stats de durée (moyenne, min, max) si des distances ont été calculées.
 */
function afficherListeCirconscriptions() {
  const panel = document.getElementById("liste-panel");
  const liste = document.getElementById("liste-etablissements");

  // Regrouper les écoles visibles par circonscription
  const parCirco = {};
  marqueurs.filter(m => m.visible).forEach(entree => {
    const nom = entree.ecole.circonscription;
    if (!parCirco[nom]) parCirco[nom] = [];
    parCirco[nom].push(entree);
  });

  // Calculer les stats par circonscription
  const statsCircos = Object.entries(parCirco).map(([nom, membres]) => {
    const dureesCalculees = membres
      .filter(m => m.dureeMin !== null)
      .map(m => m.dureeMin);

    const stats = dureesCalculees.length > 0 ? {
      moyenne: Math.round(dureesCalculees.reduce((a, b) => a + b, 0) / dureesCalculees.length),
      min:     Math.min(...dureesCalculees),
      max:     Math.max(...dureesCalculees),
    } : null;

    return {
      nom,
      couleur:    couleursCirconscriptions[nom] || "#888",
      nbEcoles:   membres.length,
      stats,
    };
  });

  // Tri : circonscriptions avec moyenne d'abord (par moyenne croissante), puis alphabétique
  const avecStats  = statsCircos.filter(c => c.stats).sort((a, b) => a.stats.moyenne - b.stats.moyenne);
  const sansStats  = statsCircos.filter(c => !c.stats).sort((a, b) => a.nom.localeCompare(b.nom));

  const html = [...avecStats, ...sansStats].map(circo => {
    const statsHtml = circo.stats
      ? `<span class="circo-moy">${circo.stats.moyenne} min moy.</span>
         <span class="circo-range">↓ ${circo.stats.min} min  ↑ ${circo.stats.max} min</span>`
      : `<span class="circo-moy sans-dist">—</span>`;

    return `
      <div class="liste-item circo-item"
           data-circo="${encodeURIComponent(circo.nom)}"
           title="${circo.nom}">
        <span class="liste-dot" style="background:${circo.couleur}"></span>
        <div class="liste-info">
          <div class="liste-nom">${circo.nom}</div>
          <div class="liste-meta">${circo.nbEcoles} établissements · ${statsHtml}</div>
        </div>
      </div>`;
  }).join("");

  liste.innerHTML = html;

  // Clic sur une circonscription → zoom sur ses écoles et surbrillance
  liste.querySelectorAll(".circo-item").forEach(item => {
    item.addEventListener("click", () => {
      const nom     = decodeURIComponent(item.dataset.circo);
      const membres = marqueurs.filter(m => m.ecole.circonscription === nom && m.visible);
      if (!membres.length) return;

      const lats = membres.map(m => m.ecole.coordsReelles.lat);
      const lngs = membres.map(m => m.ecole.coordsReelles.lng);
      map.fitBounds([
        [Math.min(...lats), Math.min(...lngs)],
        [Math.max(...lats), Math.max(...lngs)],
      ], { padding: [40, 40] });

      liste.querySelectorAll(".circo-item").forEach(el => el.classList.remove("actif"));
      item.classList.add("actif");
    });
  });

  panel.style.display = "flex";
}

/**
 * Attache les listeners de clic sur les items de la liste Distances.
 * Au clic : zoom sur l'école, ouverture popup, calcul de distance si référence définie.
 */
function bindClicsListeDistances() {
  document.querySelectorAll(".liste-item:not(.circo-item)").forEach(item => {
    item.addEventListener("click", () => {
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lng);

      map.setView([lat, lng], 14);

      const entree = marqueurs.find(
        m => m.ecole.coordsMarqueur.lat === lat && m.ecole.coordsMarqueur.lng === lng
      );
      if (entree) {
        entree.marker.openPopup();
        if (coordsReference) calculerDistanceUnitaire(entree.ecole);
      }

      surbrillanceListe(lat, lng);
    });
  });
}

/**
 * Met en surbrillance l'item de la liste correspondant aux coordonnées données,
 * et scrolle jusqu'à lui.
 */
function surbrillanceListe(lat, lng) {
  document.querySelectorAll(".liste-item:not(.circo-item)").forEach(el => {
    el.classList.toggle(
      "actif",
      parseFloat(el.dataset.lat) === lat && parseFloat(el.dataset.lng) === lng
    );
  });

  const itemActif = document.querySelector(".liste-item.actif");
  if (itemActif) itemActif.scrollIntoView({ block: "nearest", behavior: "smooth" });
}


// =============================================================================
// UTILITAIRES UI
// =============================================================================

function afficherLoader(visible) {
  document.getElementById("loader").classList.toggle("hidden", !visible);
  if (visible) {
    document.getElementById("loader-text").textContent = "Chargement des établissements...";
  }
}

function mettreAJourCompteur() {
  const nbVisibles = marqueurs.filter(m => m.visible).length;
  document.getElementById("counter").textContent = `${nbVisibles} établissements`;
}

function mettreAJourTitreDept() {
  const select  = document.getElementById("dept-select");
  const nomDept = select ? select.options[select.selectedIndex].text : DEPT_ACTIF;
  document.getElementById("titre-dept").textContent = `🏫 Écoles publiques — ${nomDept}`;
}

/** Ajuste le zoom de la carte pour englober tous les marqueurs chargés. */
function centrerCarteEtablissements() {
  if (!marqueurs.length) return;

  const lats = marqueurs.map(m => m.ecole.coordsReelles.lat);
  const lngs = marqueurs.map(m => m.ecole.coordsReelles.lng);

  map.fitBounds([
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ], { padding: [30, 30] });
}


// =============================================================================
// DÉMARRAGE
// =============================================================================

initialiserApplication();