// ── Config API ────────────────────────────────────────────────────────────────
var API_URL =
  "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-annuaire-education/records";
var API_WHERE =
  'code_departement="044" AND statut_public_prive="Public" AND ecole_maternelle IS NOT NULL AND ecole_elementaire IS NOT NULL';
var PAGE_SIZE = 100;

// ── Palette de couleurs pour les circonscriptions ─────────────────────────────
var PALETTE = [
  "#ff4d4d", "#3366ff", "#cc00ff", "#ff00aa", "#ff6600",
  "#0099ff", "#9933ff", "#ff3399", "#ff6699", "#00ccff",
  "#ff0066", "#ff4d4d", "#3366ff", "#cc00ff", "#ff00aa",
  "#ff6600", "#0099ff", "#9933ff", "#ff3399", "#ff6699",
];

// ── Couleurs durée ────────────────────────────────────────────────────────────
function couleurDuree(min) {
  if (min === null || min === undefined) return "#7c85ff";
  if (min <= 20) return "#22c55e";
  if (min <= 30) return "#f97316";
  if (min <= 40) return "#ef4444";
  return "#111827";
}

// ── État global ───────────────────────────────────────────────────────────────
var ecoleMarkers = [];
var referenceMarker = null;
var referenceLatLng = null;
var ongletActif = "distances"; // "distances" | "circonscriptions"
var circonscriptionCouleurs = {};    // nom → couleur hex
var circonscriptionPolygones = {};   // nom → L.Polygon

// ── Carte Leaflet ─────────────────────────────────────────────────────────────
var map = L.map("map").setView([47.2184, -1.5536], 9);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

// ── Chargement ────────────────────────────────────────────────────────────────
async function chargerDonnees() {
  var loader = document.getElementById("loader");
  var loaderPct = document.getElementById("loader-progress");
  loader.classList.remove("hidden");
  document.getElementById("loader-text").textContent = "Chargement des établissements...";

  var allResults = [];
  var offset = 0;
  var totalCount = null;

  do {
    var url = API_URL + "?where=" + encodeURIComponent(API_WHERE) +
      "&limit=" + PAGE_SIZE + "&offset=" + offset;
    var res = await fetch(url);
    var data = await res.json();
    if (totalCount === null) totalCount = data.total_count;
    allResults = allResults.concat(data.results);
    offset += PAGE_SIZE;
    var pct = Math.round((allResults.length / totalCount) * 100);
    loaderPct.textContent = allResults.length + " / " + totalCount + " (" + pct + "%)";
  } while (offset < totalCount);

  assignerCouleursCirconscriptions(allResults);
  initialiserMarqueurs(allResults);
  loader.classList.add("hidden");
  document.getElementById("counter").textContent = allResults.length + " établissements";
  rafraichirListe();
}

// ── Assigner une couleur par circonscription ──────────────────────────────────
function assignerCouleursCirconscriptions(etablissements) {
  var noms = [];
  etablissements.forEach(function (e) {
    var n = e.nom_circonscription || "Inconnue";
    if (noms.indexOf(n) === -1) noms.push(n);
  });
  noms.sort();
  noms.forEach(function (n, i) {
    circonscriptionCouleurs[n] = PALETTE[i % PALETTE.length];
  });
}

// ── Création des marqueurs ────────────────────────────────────────────────────
function initialiserMarqueurs(etablissements) {
  var valides = etablissements.filter(function (e) {
    return e.latitude != null && e.longitude != null;
  });

  ecoleMarkers = valides.map(function (e) {
    var ecole = {
      lat: e.latitude,
      lng: e.longitude,
      nom: e.nom_etablissement,
      type: e.type_etablissement,
      adresse: [e.adresse_1, e.adresse_2, e.adresse_3].filter(Boolean).join(", "),
      commune: e.nom_commune,
      tel: e.telephone || "—",
      mail: e.mail || "—",
      ecole_maternelle: e.ecole_maternelle === 1,
      ecole_elementaire: e.ecole_elementaire === 1,
      rep: e.appartenance_education_prioritaire || null,
      circonscription: e.nom_circonscription || "Inconnue",
    };

    var marker = L.circleMarker([ecole.lat, ecole.lng], {
      radius: 6, fillColor: "#7c85ff",
      color: "#fff", weight: 1.5, fillOpacity: 0.9,
    }).addTo(map);

    marker.bindPopup(buildPopup(ecole));

    marker.on("click", function () {
      if (referenceLatLng) afficherOuCalculerDistance(ecole);
      mettreEnSurbrillanceListe(ecole.lat, ecole.lng);
    });

    return { marker: marker, ecole: ecole, dureeMin: null, distKm: null, visible: true };
  });
}

function buildPopup(ecole) {
  return '<div class="popup-box">' +
    "<h3>" + ecole.nom + "</h3>" +
    '<span class="tag">' + ecole.type + "</span>" +
    '<div class="row" style="align-items:flex-start">' +
    '<span class="label" style="flex-shrink:0">Circonscription</span>' +
    '<span style="display:flex;align-items:flex-start;gap:5px">' +
    '<span style="width:10px;height:10px;border-radius:50%;background:' + (circonscriptionCouleurs[ecole.circonscription] || "#888") + ';flex-shrink:0;margin-top:2px"></span>' +
    '<span>' + ecole.circonscription + '</span>' +
    '</span></div>' +
    '<div class="row"><span class="label">Commune</span><span>' + ecole.commune + "</span></div>" +
    '<div class="row"><span class="label">Adresse</span><span>' + ecole.adresse + "</span></div>" +
    '<div class="row"><span class="label">Tél.</span><span>' + ecole.tel + "</span></div>" +
    '<div class="row"><span class="label">Mail</span><span>' + ecole.mail + "</span></div>" +
    (ecole.rep ? '<div class="row"><span class="label">Prioritaire</span><span class="tag-rep tag-rep-' + ecole.rep.replace("+", "plus") + '">' + ecole.rep + "</span></div>" : "") +
    '<div class="row"><span class="label">Maternelle</span><span>' + (ecole.ecole_maternelle ? "✓" : "—") + "</span></div>" +
    '<div class="row"><span class="label">Élémentaire</span><span>' + (ecole.ecole_elementaire ? "✓" : "—") + "</span></div>" +
    '<div class="row" id="dist-' + ecole.lat + "-" + ecole.lng + '"><span class="label">Distance</span><span>—</span></div>' +
    "</div>";
}

// ── Onglets ───────────────────────────────────────────────────────────────────
// ── Convex Hull (algorithme de Graham scan simplifié) ────────────────────────
function convexHull(points) {
  if (points.length < 3) return points;
  points = points.slice().sort(function (a, b) { return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]; });
  var lower = [];
  for (var i = 0; i < points.length; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], points[i]) <= 0) lower.pop();
    lower.push(points[i]);
  }
  var upper = [];
  for (var i = points.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], points[i]) <= 0) upper.pop();
    upper.push(points[i]);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}
function cross(O, A, B) {
  return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
}

// ── Dessiner / effacer les polygones de circonscription ───────────────────────
function dessinerPolygones() {
  // Regrouper les points visibles par circonscription
  var groupes = {};
  ecoleMarkers.forEach(function (em) {
    if (!em.visible) return;
    var n = em.ecole.circonscription;
    if (!groupes[n]) groupes[n] = [];
    groupes[n].push([em.ecole.lat, em.ecole.lng]);
  });

  // Supprimer les anciens polygones
  Object.keys(circonscriptionPolygones).forEach(function (n) {
    circonscriptionPolygones[n].remove();
  });
  circonscriptionPolygones = {};

  // Dessiner les nouveaux
  Object.keys(groupes).forEach(function (n) {
    var pts = groupes[n];
    if (pts.length < 2) return;
    var couleur = circonscriptionCouleurs[n] || "#888";
    var hull = pts.length >= 3 ? convexHull(pts) : pts;
    var poly = L.polygon(hull, {
      color: couleur,
      weight: 2,
      opacity: 0.8,
      fillColor: couleur,
      fillOpacity: 0.06,
      dashArray: "5,4",
      interactive: false,
    }).addTo(map);
    poly.bindTooltip(n, { sticky: false, direction: "center", className: "circo-tooltip" });
    circonscriptionPolygones[n] = poly;
  });
}

function effacerPolygones() {
  Object.keys(circonscriptionPolygones).forEach(function (n) {
    circonscriptionPolygones[n].remove();
  });
  circonscriptionPolygones = {};
}

function basculerOnglet(onglet) {
  ongletActif = onglet;
  document.getElementById("tab-distances").classList.toggle("actif", onglet === "distances");
  document.getElementById("tab-circo").classList.toggle("actif", onglet === "circonscriptions");
  if (onglet === "circonscriptions") { dessinerPolygones(); }
  else { effacerPolygones(); }
  appliquerCouleursMarqueurs();
  rafraichirListe();
}

function appliquerCouleursMarqueurs() {
  ecoleMarkers.forEach(function (em) {
    if (!em.visible) return;
    if (ongletActif === "circonscriptions") {
      em.marker.setStyle({ fillColor: circonscriptionCouleurs[em.ecole.circonscription] || "#888" });
    } else {
      em.marker.setStyle({ fillColor: couleurDuree(em.dureeMin) });
    }
  });
}

document.getElementById("tab-distances").addEventListener("click", function () { basculerOnglet("distances"); });
document.getElementById("tab-circo").addEventListener("click", function () { basculerOnglet("circonscriptions"); });

// ── Filtres ───────────────────────────────────────────────────────────────────
function appliquerFiltre() {
  var showMat = document.getElementById("filtre-maternelle").checked;
  var showElem = document.getElementById("filtre-elementaire").checked;
  var showRep = document.getElementById("filtre-rep").checked;
  var showRepPlus = document.getElementById("filtre-rep-plus").checked;
  var visibles = 0;

  ecoleMarkers.forEach(function (em) {
    var e = em.ecole;
    var estSeulMat = e.ecole_maternelle && !e.ecole_elementaire;
    var estSeulElem = e.ecole_elementaire && !e.ecole_maternelle;
    var estLesDeux = e.ecole_maternelle && e.ecole_elementaire;
    var okType = (!estSeulMat || showMat) && (!estSeulElem || showElem) && (!estLesDeux || showMat || showElem);
    var okRep = (e.rep !== "REP" || showRep) && (e.rep !== "REP+" || showRepPlus);
    var ok = okType && okRep;
    em.visible = ok;
    if (ok) { em.marker.addTo(map); visibles++; }
    else { em.marker.remove(); }
  });

  document.getElementById("counter").textContent = visibles + " établissements";
  appliquerCouleursMarqueurs();
  if (ongletActif === "circonscriptions") dessinerPolygones();
  rafraichirListe();
}
document.getElementById("filtre-maternelle").addEventListener("change", appliquerFiltre);
document.getElementById("filtre-elementaire").addEventListener("change", appliquerFiltre);
document.getElementById("filtre-rep").addEventListener("change", appliquerFiltre);
document.getElementById("filtre-rep-plus").addEventListener("change", appliquerFiltre);

// ── Géocodage ─────────────────────────────────────────────────────────────────
async function geocodeAdresse(adresse) {
  var url = "https://nominatim.openstreetmap.org/search?format=json&q=" + encodeURIComponent(adresse) + "&limit=1";
  var res = await fetch(url, { headers: { "Accept-Language": "fr" } });
  var data = await res.json();
  if (!data.length) throw new Error("Adresse introuvable");
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), label: data[0].display_name };
}

// ── Distance unitaire ─────────────────────────────────────────────────────────
async function afficherOuCalculerDistance(ecole) {
  var el = document.getElementById("dist-" + ecole.lat + "-" + ecole.lng);
  var em = ecoleMarkers.find(function (e) { return e.ecole.lat === ecole.lat && e.ecole.lng === ecole.lng; });

  if (em && em.dureeMin !== null) {
    if (el) el.querySelector("span:last-child").textContent = em.dureeMin + " min — " + em.distKm + " km";
    return;
  }

  var url = "https://router.project-osrm.org/route/v1/driving/" +
    referenceLatLng.lng + "," + referenceLatLng.lat + ";" + ecole.lng + "," + ecole.lat + "?overview=false";
  var res = await fetch(url);
  var data = await res.json();
  if (data.code !== "Ok") return;
  var distKm = (data.routes[0].distance / 1000).toFixed(1);
  var dureeMin = Math.round(data.routes[0].duration / 60);
  if (em) {
    em.dureeMin = dureeMin;
    em.distKm = parseFloat(distKm);
    if (ongletActif === "distances") em.marker.setStyle({ fillColor: couleurDuree(dureeMin) });
  }
  if (el) el.querySelector("span:last-child").textContent = dureeMin + " min — " + distKm + " km";
}

// ── Calcul toutes distances ───────────────────────────────────────────────────
async function calculerToutesDistances() {
  if (!referenceLatLng) return;
  var btn = document.getElementById("btn-calc");
  btn.disabled = true;
  ecoleMarkers.forEach(function (em) { em.dureeMin = null; em.distKm = null; });

  var cibles = ecoleMarkers;
  var total = cibles.length;
  var traites = 0;
  majProgression(0, total);

  var BATCH = 100;
  var lots = [];
  for (var i = 0; i < cibles.length; i += BATCH) lots.push(cibles.slice(i, i + BATCH));

  await Promise.all(lots.map(async function (lot) {
    try {
      var coords = referenceLatLng.lng + "," + referenceLatLng.lat;
      for (var j = 0; j < lot.length; j++) coords += ";" + lot[j].ecole.lng + "," + lot[j].ecole.lat;
      var res = await fetch("https://router.project-osrm.org/table/v1/driving/" + coords + "?sources=0&annotations=duration,distance");
      var data = await res.json();
      if (data.code === "Ok") {
        var durees = data.durations[0];
        var distances = data.distances ? data.distances[0] : null;
        for (var j = 0; j < lot.length; j++) {
          var duree = durees[j + 1];
          if (duree !== null && duree !== undefined) {
            lot[j].dureeMin = Math.round(duree / 60);
            lot[j].distKm = distances ? parseFloat((distances[j + 1] / 1000).toFixed(1)) : null;
          }
        }
      }
    } catch (e) { }
    traites += lot.length;
    majProgression(Math.min(traites, total), total);
  }));

  appliquerCouleursMarqueurs();
  rafraichirListe();
}

function majProgression(fait, total) {
  var pct = total > 0 ? Math.round((fait / total) * 100) : 0;
  var btn = document.getElementById("btn-calc");
  var barre = document.getElementById("progress-bar");
  var label = document.getElementById("progress-label");
  if (fait === 0) {
    btn.textContent = "Calcul... 0%";
    barre.style.display = "block";
    barre.querySelector(".progress-fill").style.width = "0%";
    label.textContent = "0 / " + total;
  } else if (fait >= total) {
    btn.textContent = "Recalculer";
    btn.disabled = false;
    barre.style.display = "none";
    label.textContent = "";
  } else {
    btn.textContent = "Calcul... " + pct + "%";
    barre.querySelector(".progress-fill").style.width = pct + "%";
    label.textContent = fait + " / " + total;
  }
}

// ── Liste latérale ────────────────────────────────────────────────────────────
function rafraichirListe() {
  if (ongletActif === "distances") {
    rafraichirListeDistances();
  } else {
    rafraichirListeCirconscriptions();
  }
}

// Liste onglet Distances
function rafraichirListeDistances() {
  var panel = document.getElementById("liste-panel");
  var liste = document.getElementById("liste-etablissements");
  var visibles = ecoleMarkers.filter(function (em) { return em.visible; });

  var avecDuree = visibles.filter(function (em) { return em.dureeMin !== null; });
  var sansDuree = visibles.filter(function (em) { return em.dureeMin === null; });
  avecDuree.sort(function (a, b) { return a.dureeMin !== b.dureeMin ? a.dureeMin - b.dureeMin : (a.distKm || 0) - (b.distKm || 0); });
  sansDuree.sort(function (a, b) { return a.ecole.nom.localeCompare(b.ecole.nom); });

  var tries = avecDuree.concat(sansDuree);
  var html = "";
  for (var i = 0; i < tries.length; i++) {
    var em = tries[i];
    var couleur = couleurDuree(em.dureeMin);
    var distLabel = em.dureeMin !== null
      ? '<span class="liste-dist">' + em.dureeMin + " min · " + em.distKm + " km</span>"
      : '<span class="liste-dist sans-dist">—</span>';
    html += '<div class="liste-item" data-lat="' + em.ecole.lat + '" data-lng="' + em.ecole.lng + '" title="' + em.ecole.nom + ' — ' + em.ecole.commune + '">' +
      '<span class="liste-dot" style="background:' + couleur + '"></span>' +
      '<div class="liste-info">' +
      '<div class="liste-nom">' + em.ecole.nom + "</div>" +
      '<div class="liste-meta">' + em.ecole.commune + " · " + distLabel + "</div>" +
      "</div></div>";
  }
  liste.innerHTML = html;
  bindClicsListe();
  panel.style.display = "flex";
}

// Liste onglet Circonscriptions
function rafraichirListeCirconscriptions() {
  var panel = document.getElementById("liste-panel");
  var liste = document.getElementById("liste-etablissements");
  var visibles = ecoleMarkers.filter(function (em) { return em.visible; });

  // Regrouper par circonscription
  var groupes = {};
  visibles.forEach(function (em) {
    var n = em.ecole.circonscription;
    if (!groupes[n]) groupes[n] = [];
    groupes[n].push(em);
  });

  // Calculer stats par circonscription
  var stats = Object.keys(groupes).map(function (nom) {
    var membres = groupes[nom];
    var avecDuree = membres.filter(function (em) { return em.dureeMin !== null; });
    var min = null, max = null, moy = null;
    if (avecDuree.length > 0) {
      var durees = avecDuree.map(function (em) { return em.dureeMin; });
      min = Math.min.apply(null, durees);
      max = Math.max.apply(null, durees);
      moy = Math.round(durees.reduce(function (a, b) { return a + b; }, 0) / durees.length);
    }
    return { nom: nom, couleur: circonscriptionCouleurs[nom] || "#888", count: membres.length, min: min, max: max, moy: moy };
  });

  // Trier : celles avec moyenne d'abord, puis par nom
  var avecMoy = stats.filter(function (s) { return s.moy !== null; });
  var sansMoy = stats.filter(function (s) { return s.moy === null; });
  avecMoy.sort(function (a, b) { return a.moy - b.moy; });
  sansMoy.sort(function (a, b) { return a.nom.localeCompare(b.nom); });
  var tries = avecMoy.concat(sansMoy);

  var html = "";
  for (var i = 0; i < tries.length; i++) {
    var s = tries[i];
    var statsHtml = s.moy !== null
      ? '<span class="circo-moy">' + s.moy + ' min moy.</span>' +
      '<span class="circo-range">↓ ' + s.min + ' min  ↑ ' + s.max + ' min</span>'
      : '<span class="circo-moy sans-dist">—</span>';
    html += '<div class="liste-item circo-item" data-circo="' + encodeURIComponent(s.nom) + '" title="' + s.nom + '">' +
      '<span class="liste-dot" style="background:' + s.couleur + '"></span>' +
      '<div class="liste-info">' +
      '<div class="liste-nom">' + s.nom + '</div>' +
      '<div class="liste-meta">' + s.count + ' établissements · ' + statsHtml + '</div>' +
      '</div></div>';
  }
  liste.innerHTML = html;

  // Clic sur une circonscription → zoom + surligner tous ses établissements
  liste.querySelectorAll(".circo-item").forEach(function (item) {
    item.addEventListener("click", function () {
      var nom = decodeURIComponent(item.dataset.circo);
      var membres = ecoleMarkers.filter(function (em) { return em.ecole.circonscription === nom && em.visible; });
      if (!membres.length) return;
      var lats = membres.map(function (em) { return em.ecole.lat; });
      var lngs = membres.map(function (em) { return em.ecole.lng; });
      map.fitBounds([[Math.min.apply(null, lats), Math.min.apply(null, lngs)], [Math.max.apply(null, lats), Math.max.apply(null, lngs)]], { padding: [40, 40] });
      // Surligner dans la liste
      liste.querySelectorAll(".circo-item").forEach(function (el) { el.classList.remove("actif"); });
      item.classList.add("actif");
    });
  });

  panel.style.display = "flex";
}

function bindClicsListe() {
  document.querySelectorAll(".liste-item:not(.circo-item)").forEach(function (item) {
    item.addEventListener("click", function () {
      var lat = parseFloat(item.dataset.lat);
      var lng = parseFloat(item.dataset.lng);
      map.setView([lat, lng], 14);
      var found = ecoleMarkers.find(function (em) { return em.ecole.lat === lat && em.ecole.lng === lng; });
      if (found) {
        found.marker.openPopup();
        if (referenceLatLng) afficherOuCalculerDistance(found.ecole);
      }
      mettreEnSurbrillanceListe(lat, lng);
    });
  });
}

function mettreEnSurbrillanceListe(lat, lng) {
  document.querySelectorAll(".liste-item:not(.circo-item)").forEach(function (el) {
    el.classList.toggle("actif", parseFloat(el.dataset.lat) === lat && parseFloat(el.dataset.lng) === lng);
  });
  var actif = document.querySelector(".liste-item.actif");
  if (actif) actif.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ── Formulaire adresse ────────────────────────────────────────────────────────
document.getElementById("form-adresse").addEventListener("submit", async function (e) {
  e.preventDefault();
  var input = document.getElementById("input-adresse");
  var status = document.getElementById("status-adresse");
  status.textContent = "Recherche...";
  try {
    var result = await geocodeAdresse(input.value);
    referenceLatLng = result;
    if (referenceMarker) referenceMarker.remove();
    referenceMarker = L.marker([result.lat, result.lng], {
      icon: L.divIcon({ className: "ref-icon", html: "📍", iconSize: [24, 24] }),
    }).addTo(map).bindPopup("📍 Adresse de référence").openPopup();
    map.setView([result.lat, result.lng], 10);
    status.textContent = "✓ " + result.label.split(",").slice(0, 2).join(",");
    document.getElementById("btn-calc").style.display = "inline-block";
    rafraichirListe();
  } catch (err) {
    status.textContent = "❌ Adresse introuvable";
  }
});

document.getElementById("btn-calc").addEventListener("click", calculerToutesDistances);
chargerDonnees();