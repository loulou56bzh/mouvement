// ── Config API ────────────────────────────────────────────────────────────────
var API_URL =
  "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-annuaire-education/records";
var API_WHERE =
  'code_departement="044" AND statut_public_prive="Public" AND ecole_maternelle IS NOT NULL AND ecole_elementaire IS NOT NULL';
var PAGE_SIZE = 100;

// ── Couleurs par seuil ────────────────────────────────────────────────────────
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

// ── Carte Leaflet ─────────────────────────────────────────────────────────────
var map = L.map("map").setView([47.2184, -1.5536], 9);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

// ── Chargement des données depuis l'API ───────────────────────────────────────
async function chargerDonnees() {
  var loader = document.getElementById("loader");
  var loaderText = document.getElementById("loader-text");
  var loaderPct = document.getElementById("loader-progress");

  loader.classList.remove("hidden");
  loaderText.textContent = "Chargement des établissements...";

  var allResults = [];
  var offset = 0;
  var totalCount = null;

  do {
    var url =
      API_URL +
      "?where=" +
      encodeURIComponent(API_WHERE) +
      "&limit=" +
      PAGE_SIZE +
      "&offset=" +
      offset;
    var res = await fetch(url);
    var data = await res.json();

    if (totalCount === null) {
      totalCount = data.total_count;
    }

    allResults = allResults.concat(data.results);
    offset += PAGE_SIZE;

    var pct = Math.round((allResults.length / totalCount) * 100);
    loaderPct.textContent =
      allResults.length + " / " + totalCount + " (" + pct + "%)";
  } while (offset < totalCount);

  initialiserMarqueurs(allResults);
  loader.classList.add("hidden");
  document.getElementById("counter").textContent =
    allResults.length + " établissements";
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
      adresse: [e.adresse_1, e.adresse_2, e.adresse_3]
        .filter(Boolean)
        .join(", "),
      commune: e.nom_commune,
      tel: e.telephone || "—",
      mail: e.mail || "—",
      ecole_maternelle: e.ecole_maternelle === 1,
      ecole_elementaire: e.ecole_elementaire === 1,
      rep: e.appartenance_education_prioritaire || null,
    };

    var marker = L.circleMarker([ecole.lat, ecole.lng], {
      radius: 6,
      fillColor: "#7c85ff",
      color: "#fff",
      weight: 1.5,
      fillOpacity: 0.9,
    }).addTo(map);

    marker.bindPopup(
      '<div class="popup-box">' +
        "<h3>" +
        ecole.nom +
        "</h3>" +
        '<span class="tag">' +
        ecole.type +
        "</span>" +
        '<div class="row"><span class="label">Commune</span><span>' +
        ecole.commune +
        "</span></div>" +
        '<div class="row"><span class="label">Adresse</span><span>' +
        ecole.adresse +
        "</span></div>" +
        '<div class="row"><span class="label">Tél.</span><span>' +
        ecole.tel +
        "</span></div>" +
        '<div class="row"><span class="label">Mail</span><span>' +
        ecole.mail +
        "</span></div>" +
        '<div class="row"><span class="label">Maternelle</span><span>' +
        (ecole.ecole_maternelle ? "✓" : "—") +
        "</span></div>" +
        (ecole.rep
          ? '<div class="row"><span class="label">Prioritaire</span><span class="tag-rep tag-rep-' +
            ecole.rep.replace("+", "plus") +
            '">' +
            ecole.rep +
            "</span></div>"
          : "") +
        '<div class="row"><span class="label">Élémentaire</span><span>' +
        (ecole.ecole_elementaire ? "✓" : "—") +
        "</span></div>" +
        '<div class="row" id="dist-' +
        ecole.lat +
        "-" +
        ecole.lng +
        '"><span class="label">Distance</span><span>—</span></div>' +
        "</div>",
    );

    marker.on("click", function () {
      if (referenceLatLng) afficherOuCalculerDistance(ecole);
      mettreEnSurbrillanceListe(ecole.lat, ecole.lng);
    });

    return {
      marker: marker,
      ecole: ecole,
      dureeMin: null,
      distKm: null,
      visible: true,
    };
  });
}

// ── Filtres ───────────────────────────────────────────────────────────────────
function appliquerFiltre() {
  var showMat = document.getElementById("filtre-maternelle").checked;
  var showElem = document.getElementById("filtre-elementaire").checked;
  var showRep = document.getElementById("filtre-rep").checked;
  var showRepPlus = document.getElementById("filtre-rep-plus").checked;
  var visibles = 0;

  ecoleMarkers.forEach(function (em) {
    var e = em.ecole;

    // Logique type d'école :
    // Un établissement est visible si sa catégorie est cochée.
    // "Uniquement maternelle"  = maternelle=true  ET elementaire=false
    // "Uniquement élémentaire" = elementaire=true ET maternelle=false
    // "Les deux"               = maternelle=true  ET elementaire=true
    var estSeulMat = e.ecole_maternelle && !e.ecole_elementaire;
    var estSeulElem = e.ecole_elementaire && !e.ecole_maternelle;
    var estLesDeux = e.ecole_maternelle && e.ecole_elementaire;

    var okType =
      (estSeulMat && showMat) ||
      (estSeulElem && showElem) ||
      (estLesDeux && showMat && showElem) ||
      (estLesDeux && !showMat && showElem) ||
      (estLesDeux && showMat && !showElem);
    // si les deux décochés → tout masqué
    // Simplification : visible si au moins une catégorie applicable est cochée
    okType =
      (!estSeulMat || showMat) &&
      (!estSeulElem || showElem) &&
      (!estLesDeux || showMat || showElem);

    // Logique REP
    var okRep =
      (e.rep !== "REP" || showRep) && (e.rep !== "REP+" || showRepPlus);

    var ok = okType && okRep;
    em.visible = ok;
    if (ok) {
      em.marker.addTo(map);
      visibles++;
    } else {
      em.marker.remove();
    }
  });

  document.getElementById("counter").textContent = visibles + " établissements";
  rafraichirListe();
}
document
  .getElementById("filtre-maternelle")
  .addEventListener("change", appliquerFiltre);
document
  .getElementById("filtre-elementaire")
  .addEventListener("change", appliquerFiltre);
document
  .getElementById("filtre-rep")
  .addEventListener("change", appliquerFiltre);
document
  .getElementById("filtre-rep-plus")
  .addEventListener("change", appliquerFiltre);

// ── Géocodage ─────────────────────────────────────────────────────────────────
async function geocodeAdresse(adresse) {
  var url =
    "https://nominatim.openstreetmap.org/search?format=json&q=" +
    encodeURIComponent(adresse) +
    "&limit=1";
  var res = await fetch(url, { headers: { "Accept-Language": "fr" } });
  var data = await res.json();
  if (!data.length) throw new Error("Adresse introuvable");
  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    label: data[0].display_name,
  };
}

// ── Distance unitaire (clic sur un marqueur) ──────────────────────────────────
async function afficherOuCalculerDistance(ecole) {
  var el = document.getElementById("dist-" + ecole.lat + "-" + ecole.lng);

  // Chercher les données déjà calculées en mémoire
  var em = ecoleMarkers.find(function (e) {
    return e.ecole.lat === ecole.lat && e.ecole.lng === ecole.lng;
  });

  if (em && em.dureeMin !== null) {
    // Données déjà disponibles → affichage instantané
    if (el)
      el.querySelector("span:last-child").textContent =
        em.dureeMin + " min — " + em.distKm + " km";
    return;
  }

  // Pas encore calculé → requête OSRM
  var url =
    "https://router.project-osrm.org/route/v1/driving/" +
    referenceLatLng.lng +
    "," +
    referenceLatLng.lat +
    ";" +
    ecole.lng +
    "," +
    ecole.lat +
    "?overview=false";
  var res = await fetch(url);
  var data = await res.json();
  if (data.code !== "Ok") return;
  var distKm = (data.routes[0].distance / 1000).toFixed(1);
  var dureeMin = Math.round(data.routes[0].duration / 60);
  // Stocker en mémoire pour les prochains clics
  if (em) {
    em.dureeMin = dureeMin;
    em.distKm = parseFloat(distKm);
    em.marker.setStyle({ fillColor: couleurDuree(dureeMin) });
  }
  if (el)
    el.querySelector("span:last-child").textContent =
      dureeMin + " min — " + distKm + " km";
}

// ── Calcul toutes distances (OSRM Table + lots parallèles) ────────────────────
async function calculerToutesDistances() {
  if (!referenceLatLng) return;
  var btn = document.getElementById("btn-calc");
  btn.disabled = true;

  ecoleMarkers.forEach(function (em) {
    em.dureeMin = null;
    em.distKm = null;
  });

  var cibles = ecoleMarkers; // calcul sur tous les établissements, filtre indépendant
  var total = cibles.length;
  var traites = 0;
  majProgression(0, total);

  var BATCH = 100;
  var CONCURRENCY = 3;
  var lots = [];
  for (var i = 0; i < cibles.length; i += BATCH) {
    lots.push(cibles.slice(i, i + BATCH));
  }

  for (var l = 0; l < lots.length; l += CONCURRENCY) {
    var lotActuels = lots.slice(l, l + CONCURRENCY);
    await Promise.all(
      lotActuels.map(async function (lot) {
        try {
          var coords = referenceLatLng.lng + "," + referenceLatLng.lat;
          for (var j = 0; j < lot.length; j++) {
            coords += ";" + lot[j].ecole.lng + "," + lot[j].ecole.lat;
          }
          var url =
            "https://router.project-osrm.org/table/v1/driving/" +
            coords +
            "?sources=0&annotations=duration,distance";
          var res = await fetch(url);
          var data = await res.json();
          if (data.code === "Ok") {
            var durees = data.durations[0];
            var distances = data.distances ? data.distances[0] : null;
            for (var j = 0; j < lot.length; j++) {
              var duree = durees[j + 1];
              if (duree !== null && duree !== undefined) {
                lot[j].dureeMin = Math.round(duree / 60);
                lot[j].distKm = distances
                  ? parseFloat((distances[j + 1] / 1000).toFixed(1))
                  : null;
                lot[j].marker.setStyle({
                  fillColor: couleurDuree(lot[j].dureeMin),
                });
              }
            }
          }
        } catch (e) {}
        traites += lot.length;
        majProgression(Math.min(traites, total), total);
      }),
    );
  }

  majProgression(total, total);
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
  var panel = document.getElementById("liste-panel");
  var liste = document.getElementById("liste-etablissements");

  var visibles = ecoleMarkers.filter(function (em) {
    return em.visible;
  });
  var avecDuree = visibles.filter(function (em) {
    return em.dureeMin !== null;
  });
  var sansDuree = visibles.filter(function (em) {
    return em.dureeMin === null;
  });

  avecDuree.sort(function (a, b) {
    return a.dureeMin - b.dureeMin;
  });
  sansDuree.sort(function (a, b) {
    return a.ecole.nom.localeCompare(b.ecole.nom);
  });

  var tries = avecDuree.concat(sansDuree);
  var html = "";

  for (var i = 0; i < tries.length; i++) {
    var em = tries[i];
    var couleur = couleurDuree(em.dureeMin);
    var distLabel =
      em.dureeMin !== null
        ? '<span class="liste-dist">' +
          em.dureeMin +
          " min · " +
          em.distKm +
          " km</span>"
        : '<span class="liste-dist sans-dist">—</span>';
    html +=
      '<div class="liste-item" data-lat="' +
      em.ecole.lat +
      '" data-lng="' +
      em.ecole.lng +
      '">' +
      '<span class="liste-dot" style="background:' +
      couleur +
      '"></span>' +
      '<div class="liste-info">' +
      '<div class="liste-nom">' +
      em.ecole.nom +
      "</div>" +
      '<div class="liste-meta">' +
      em.ecole.commune +
      " · " +
      distLabel +
      "</div>" +
      "</div></div>";
  }

  liste.innerHTML = html;

  liste.querySelectorAll(".liste-item").forEach(function (item) {
    item.addEventListener("click", function () {
      var lat = parseFloat(item.dataset.lat);
      var lng = parseFloat(item.dataset.lng);
      map.setView([lat, lng], 14);
      var found = ecoleMarkers.find(function (em) {
        return em.ecole.lat === lat && em.ecole.lng === lng;
      });
      if (found) {
        found.marker.openPopup();
        if (referenceLatLng) afficherOuCalculerDistance(found.ecole);
      }
      mettreEnSurbrillanceListe(lat, lng);
    });
  });

  panel.style.display = "flex";
}

function mettreEnSurbrillanceListe(lat, lng) {
  document.querySelectorAll(".liste-item").forEach(function (el) {
    el.classList.toggle(
      "actif",
      parseFloat(el.dataset.lat) === lat && parseFloat(el.dataset.lng) === lng,
    );
  });
  var actif = document.querySelector(".liste-item.actif");
  if (actif) actif.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ── Formulaire adresse ────────────────────────────────────────────────────────
document
  .getElementById("form-adresse")
  .addEventListener("submit", async function (e) {
    e.preventDefault();
    var input = document.getElementById("input-adresse");
    var status = document.getElementById("status-adresse");
    status.textContent = "Recherche...";
    try {
      var result = await geocodeAdresse(input.value);
      referenceLatLng = result;
      if (referenceMarker) referenceMarker.remove();
      referenceMarker = L.marker([result.lat, result.lng], {
        icon: L.divIcon({
          className: "ref-icon",
          html: "📍",
          iconSize: [24, 24],
        }),
      })
        .addTo(map)
        .bindPopup("📍 Adresse de référence")
        .openPopup();
      map.setView([result.lat, result.lng], 10);
      status.textContent = "✓ " + result.label.split(",").slice(0, 2).join(",");
      document.getElementById("btn-calc").style.display = "inline-block";
      rafraichirListe();
    } catch (err) {
      status.textContent = "❌ Adresse introuvable";
    }
  });

document
  .getElementById("btn-calc")
  .addEventListener("click", calculerToutesDistances);

// ── Lancement automatique au chargement ──────────────────────────────────────
chargerDonnees();
