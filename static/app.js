/* 국수 하수처리 GIS+AI — 3패널 프론트
 * 지도: KAKAO_JS_KEY 있으면 카카오맵(지도/스카이뷰 전환), 없으면 Leaflet+OSM/위성
 * 점 객체는 클릭 가능한 오버레이로 렌더, 질의 결과는 지도 하이라이트 */

const STYLE = {
  pipes: f => ({
    color: { "자연유하추정": "#1f77b4", "압송추정": "#d62728" }[f.properties.kind] || "#888",
    weight: 2.2,
  }),
  manholes: { radius: 3, color: "#333", fillColor: "#ffb300", fillOpacity: 0.9, weight: 1 },
  pumpstations: { radius: 8, color: "#1b5e20", fillColor: "#4caf50", fillOpacity: 0.95, weight: 2 },
  equipment: { radius: 5, color: "#4a148c", fillColor: "#ab47bc", fillOpacity: 0.9, weight: 1 },
  facility: f => f.properties.geom === "polygon"
    ? { color: "#e65100", fillColor: "#ffcc80", fillOpacity: 0.45, weight: 1 }
    : f.properties.geom === "label"
    ? { radius: 4, color: "#37474f", fillColor: "#eceff1", fillOpacity: 0.95, weight: 1.5 }
    : { color: "#8d6e63", weight: 1 },
};
const SWATCH = { pipes: "#1f77b4", manholes: "#ffb300", pumpstations: "#4caf50", facility: "#ffcc80", equipment: "#ab47bc" };
const DOT_PX = { manholes: 7, pumpstations: 14, equipment: 11 };  // 카카오 점 크기(px)

let map, cfg, kakaoMode = false;
const leafletLayers = {};
const kakaoObjects = {};
const geojsonCache = {};
let highlightObjs = [];   // 질의 하이라이트 (양쪽 모드 공용 컨테이너)
let kakaoInfo = null;     // 카카오 정보창 (단일 재사용)

init();

async function init() {
  cfg = await (await fetch("/api/config")).json();
  const layers = await (await fetch("/api/layers")).json();

  if (cfg.kakao_js_key) await initKakao(cfg.kakao_js_key);
  else initLeaflet();

  document.getElementById("map-status").innerHTML =
    `지도: ${kakaoMode ? "카카오맵" : "OSM (카카오 키 대기)"}<br>그래프: ${cfg.triples.toLocaleString()} 트리플` +
    `<br>LLM 폴백: ${cfg.llm_enabled ? "on" : "off"}`;

  const list = document.getElementById("layer-list");
  for (const ly of layers) {
    const el = document.createElement("label");
    el.className = "layer-item";
    el.innerHTML = `<input type="checkbox" ${ly.default ? "checked" : ""} data-id="${ly.id}">
      <span class="swatch" style="background:${SWATCH[ly.id] || "#999"}"></span>${ly.name}`;
    el.querySelector("input").addEventListener("change", e => toggleLayer(ly, e.target.checked));
    list.appendChild(el);
    if (ly.default) toggleLayer(ly, true);
  }
  document.getElementById("chat-form").addEventListener("submit", onAsk);
}

/* ---------- Leaflet (키 없이 즉시 동작) ---------- */
function initLeaflet() {
  map = L.map("map").setView([cfg.site_center.lat, cfg.site_center.lng], 15);
  map.on("click", e => L.popup().setLatLng(e.latlng)
    .setContent(`${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`).openOn(map));
  const base = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    { attribution: "&copy; OpenStreetMap", maxZoom: 19 }).addTo(map);
  const sat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Esri World Imagery", maxZoom: 19 });
  L.control.layers({ "일반지도": base, "항공사진": sat }, null,
    { position: "topright" }).addTo(map);
}

/* ---------- 카카오맵 ---------- */
function initKakao(key) {
  return new Promise(res => {
    const s = document.createElement("script");
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${key}&autoload=false`;
    s.onload = () => kakao.maps.load(() => {
      map = new kakao.maps.Map(document.getElementById("map"), {
        center: new kakao.maps.LatLng(cfg.site_center.lat, cfg.site_center.lng), level: 4,
      });
      map.addControl(new kakao.maps.MapTypeControl(), kakao.maps.ControlPosition.TOPRIGHT); // 지도|스카이뷰
      map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
      kakaoInfo = new kakao.maps.CustomOverlay({ yAnchor: 1.4, zIndex: 30 });
      kakao.maps.event.addListener(map, "click", (e) => {
        showKakaoInfo(e.latLng, `${e.latLng.getLat().toFixed(6)}, ${e.latLng.getLng().toFixed(6)}`);
      });
      kakaoMode = true; res();
    });
    document.head.appendChild(s);
  });
}

function showKakaoInfo(latlng, text) {
  const div = document.createElement("div");
  div.className = "kk-info";
  div.textContent = text;
  kakaoInfo.setContent(div);
  kakaoInfo.setPosition(latlng);
  kakaoInfo.setMap(map);
}

function kakaoDot(lon, lat, st, sizePx, text, zIndex = 10) {
  const div = document.createElement("div");
  div.className = "kk-dot";
  div.style.cssText = `width:${sizePx}px;height:${sizePx}px;background:${st.fillColor};
    border:1.5px solid ${st.color};`;
  if (text) div.title = text;
  const pos = new kakao.maps.LatLng(lat, lon);
  const ov = new kakao.maps.CustomOverlay({ position: pos, content: div, zIndex });
  if (text) div.addEventListener("click", ev => { ev.stopPropagation(); showKakaoInfo(pos, text); });
  return ov;
}

async function loadGeojson(file) {
  if (!geojsonCache[file])
    geojsonCache[file] = await (await fetch(`/static/geojson/${file}`)).json();
  return geojsonCache[file];
}

function featureText(f) {
  const p = f.properties;
  if (p.label) return p.tag ? `${p.label} (${p.tag})` : p.label;
  return p.name || p.kind || p.block || p.layer || String(f.id || "");
}

async function toggleLayer(ly, on) {
  const gj = await loadGeojson(ly.file);
  if (!kakaoMode) {
    if (on) {
      if (!leafletLayers[ly.id]) {
        const styler = STYLE[ly.id];
        leafletLayers[ly.id] = L.geoJSON(gj, {
          style: typeof styler === "function" ? styler : () => styler,
          pointToLayer: (f, latlng) =>
            L.circleMarker(latlng, typeof styler === "function" ? styler(f) : styler),
          onEachFeature: (f, l) => {
            const t = featureText(f); if (t) l.bindPopup(t);
            if (ly.id === "equipment") l.on("click", () => {
              const key = (f.properties.tag || "").split(" ")[0] || f.properties.label;
              showAssetCard(key);
            });
          },
        });
      }
      leafletLayers[ly.id].addTo(map);
    } else if (leafletLayers[ly.id]) map.removeLayer(leafletLayers[ly.id]);
  } else {
    if (on) {
      if (!kakaoObjects[ly.id]) kakaoObjects[ly.id] = buildKakao(gj, ly.id);
      kakaoObjects[ly.id].forEach(o => o.setMap(map));
    } else if (kakaoObjects[ly.id]) kakaoObjects[ly.id].forEach(o => o.setMap(null));
  }
}

function buildKakao(gj, id) {
  const objs = [];
  const styler = STYLE[id];
  for (const f of gj.features) {
    const st = typeof styler === "function" ? styler(f) : styler;
    const g = f.geometry;
    const toLL = c => new kakao.maps.LatLng(c[1], c[0]);
    const text = featureText(f);
    if (g.type === "LineString") {
      const pl = new kakao.maps.Polyline({
        path: g.coordinates.map(toLL), strokeColor: st.color, strokeWeight: st.weight || 2 });
      kakao.maps.event.addListener(pl, "click", (e) => showKakaoInfo(e.latLng, text));
      objs.push(pl);
    } else if (g.type === "Polygon") {
      const pg = new kakao.maps.Polygon({
        path: g.coordinates[0].map(toLL), strokeColor: st.color, strokeWeight: st.weight || 1,
        fillColor: st.fillColor, fillOpacity: st.fillOpacity || 0.5 });
      kakao.maps.event.addListener(pg, "click", (e) => showKakaoInfo(e.latLng, text));
      objs.push(pg);
    } else if (g.type === "Point") {
      const ov = kakaoDot(g.coordinates[0], g.coordinates[1], st,
        DOT_PX[id] || 9, text, id === "equipment" ? 15 : 10);
      if (id === "equipment") {
        const key = (f.properties.tag || "").split(" ")[0] || f.properties.label;
        ov.getContent().addEventListener("click", () => showAssetCard(key));
      }
      objs.push(ov);
    }
  }
  return objs;
}

/* ---------- 질의 결과 지도 하이라이트 ---------- */
function clearHighlights() {
  for (const o of highlightObjs) {
    if (kakaoMode) o.setMap(null); else map.removeLayer(o);
  }
  highlightObjs = [];
}

function drawHighlights(features) {
  clearHighlights();
  const HL = { color: "#d500f9", weight: 4 };
  const pts = [];
  for (const f of features) {
    if (f.kind === "edge") {
      pts.push(f.from, f.to);
      if (kakaoMode) {
        const pl = new kakao.maps.Polyline({
          path: [new kakao.maps.LatLng(f.from[1], f.from[0]), new kakao.maps.LatLng(f.to[1], f.to[0])],
          strokeColor: HL.color, strokeWeight: HL.weight, strokeStyle: "shortdash", zIndex: 20 });
        kakao.maps.event.addListener(pl, "click", (e) => showKakaoInfo(e.latLng, f.label));
        pl.setMap(map); highlightObjs.push(pl);
      } else {
        const l = L.polyline([[f.from[1], f.from[0]], [f.to[1], f.to[0]]],
          { color: HL.color, weight: HL.weight, dashArray: "6 6" }).bindPopup(f.label).addTo(map);
        highlightObjs.push(l);
      }
    } else if (f.kind === "point") {
      pts.push(f.coord);
      if (kakaoMode) {
        const ov = kakaoDot(f.coord[0], f.coord[1],
          { fillColor: "#ffff00", color: "#d500f9" }, 13, f.label, 25);
        ov.setMap(map); highlightObjs.push(ov);
      } else {
        const m = L.circleMarker([f.coord[1], f.coord[0]],
          { radius: 7, color: "#d500f9", fillColor: "#ffff00", fillOpacity: 0.95, weight: 2 })
          .bindPopup(f.label).addTo(map);
        highlightObjs.push(m);
      }
    }
  }
  if (!pts.length) return;
  // 하이라이트 범위로 이동
  if (kakaoMode) {
    const b = new kakao.maps.LatLngBounds();
    pts.forEach(c => b.extend(new kakao.maps.LatLng(c[1], c[0])));
    map.setBounds(b, 80, 80, 80, 80);
  } else {
    map.fitBounds(pts.map(c => [c[1], c[0]]), { padding: [60, 60] });
  }
}

/* ---------- AI 질의 ---------- */
async function ask(q) {
  addMsg("user", q);
  const btn = document.querySelector("#chat-form button");
  btn.disabled = true;
  try {
    const r = await (await fetch("/api/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    })).json();
    addBotMsg(r);
    if (r.map && r.map.features && r.map.features.length) drawHighlights(r.map.features);
  } catch (err) {
    addMsg("bot", "질의 실패: " + err);
  }
  btn.disabled = false;
}

function onAsk(e) {
  e.preventDefault();
  const input = document.getElementById("chat-input");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  ask(q);
}

/* ---------- 장비 종합 카드 (노드/점 클릭 → AI 패널) ---------- */
async function showAssetCard(key) {
  try {
    const resp = await fetch("/api/asset_card", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const c = await resp.json();
    if (!resp.ok) { addMsg("bot", c.error || "카드 조회 실패"); return; }
    renderAssetCard(c);
    if (c.coord) drawHighlights([{ kind: "point", coord: c.coord, label: c.label }]);
  } catch (err) {
    addMsg("bot", "카드 조회 실패: " + err);
  }
}

function renderAssetCard(c) {
  const log = document.getElementById("chat-log");
  const d = document.createElement("div");
  d.className = "msg bot asset-card";
  const rows = [];
  rows.push(`<div class="ac-head">${c.label}${c.tag ? ` <b>[${c.tag}]</b>` : ""}</div>`);
  if (c.sysl) rows.push(`<div>계통: ${c.sysl}</div>`);
  if (c.spec) rows.push(`<div>사양: ${c.spec}</div>`);
  if (c.qty) rows.push(`<div>수량: ${c.qty}</div>`);
  if (c.kw) rows.push(`<div>동력: ${c.kw} kW</div>`);
  if (c.status) rows.push(`<div>검증상태: ${c.status}</div>`);
  const fi = (c.feeds_in || []).map(r => r.al).join(", ");
  const fo = (c.feeds_out || []).map(r => r.bl + (r.m ? `[${r.m}]` : "")).join(", ");
  if (fi) rows.push(`<div>← 유입: ${fi}</div>`);
  if (fo) rows.push(`<div>→ 유출: ${fo}</div>`);
  if (c.iso_sheets && c.iso_sheets.length) {
    const sh = c.iso_sheets.map(s => s.no).join(", ");
    rows.push(`<div>아이소시트: ${sh}</div>`);
  }
  if (c.pipe_summary) {
    const p = c.pipe_summary;
    const len = p.len ? `${Math.round(+p.len)}m` : "-";
    const wt = p.wt ? `${Math.round(+p.wt)}kg` : "-";
    rows.push(`<div>관련 배관: ${p.n}항목, 연장 ${len}, 중량 ${wt}</div>`);
  }
  if (!c.coord) rows.push(`<div class="ac-dim">(실좌표 미보유 — 지도 표시 불가)</div>`);
  d.innerHTML = rows.join("");

  // 추천 질문 버튼 — 클릭 = AI 질의 자동 실행
  const key = c.tag ? c.tag.split(" ")[0] : c.label;
  const sugg = [
    [`배관 물량`, `${key} 배관 물량`],
    [`고장 시 하류 영향`, `${c.label} 정지하면 하류 영향 범위는?`],
    [`소속 계통`, `${c.label}은 어느 계통이야?`],
  ];
  const bar = document.createElement("div");
  bar.className = "ac-suggest";
  for (const [lbl, q] of sugg) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = lbl;
    b.onclick = () => ask(q);
    bar.appendChild(b);
  }
  d.appendChild(bar);
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function addMsg(cls, text) {
  const log = document.getElementById("chat-log");
  const d = document.createElement("div");
  d.className = "msg " + cls;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function addBotMsg(r) {
  const log = document.getElementById("chat-log");
  const d = document.createElement("div");
  d.className = "msg bot";
  d.textContent = r.answer || JSON.stringify(r);
  if (r.map && r.map.features && r.map.features.length) {
    const c = document.createElement("span");
    c.className = "toggle-sparql";
    c.textContent = "지도 표시 지우기";
    c.onclick = () => clearHighlights();
    d.appendChild(document.createElement("br"));
    d.appendChild(c);
  }
  if (r.sparql) {
    const t = document.createElement("span");
    t.className = "toggle-sparql";
    t.textContent = ` SPARQL 보기 (${r.route})`;
    const pre = document.createElement("div");
    pre.className = "sparql";
    pre.textContent = r.sparql;
    t.onclick = () => pre.classList.toggle("open");
    d.appendChild(t); d.appendChild(pre);
  }
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}


/* ============ 관계 시각화 (Cytoscape, 3뷰) ============ */
let cy = null, graphData = null, curMode = "flow";
const SYS_COLOR = {
  SYS_PRETREAT: "#5b8def", SYS_BIO: "#2ca25f", SYS_IPR: "#d95f0e",
  SYS_UTILITY: "#8856a7", SYS_DEWATER: "#c51b8a", SYS_DEODOR: "#636363",
};
const sysKey = uri => (uri || "").split("/").pop();

document.querySelectorAll(".view-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".view-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const v = tab.dataset.view;
    document.getElementById("map").hidden = v !== "map";
    document.getElementById("graph-view").hidden = v !== "graph";
    if (v === "graph") ensureGraph();
    else if (map && map.invalidateSize) setTimeout(() => map.invalidateSize(), 50);
  });
});
document.querySelectorAll(".gc-btn").forEach(b => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".gc-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    curMode = b.dataset.mode;
    renderGraph();
  });
});

async function ensureGraph() {
  if (!graphData) {
    graphData = await (await fetch("/api/graph")).json();
  }
  if (!cy) renderGraph();
  else setTimeout(() => { cy.resize(); cy.fit(null, 30); }, 30);
}

function baseStyle() {
  return [
    { selector: "node", style: {
      "label": "data(label)", "font-size": 10, "color": "#223",
      "text-wrap": "wrap", "text-max-width": 90, "text-valign": "bottom",
      "text-margin-y": 3, "width": 22, "height": 22,
      "background-color": "#9db3c6", "border-width": 1, "border-color": "#fff" } },
    { selector: 'node[kind="system"]', style: {
      "shape": "round-rectangle", "width": 130, "height": 34, "font-size": 12,
      "font-weight": "bold", "color": "#fff", "text-valign": "center",
      "text-max-width": 120, "text-margin-y": 0 } },
    { selector: 'node[kind="pumpstation"]', style: {
      "shape": "round-rectangle", "background-color": "#1b5e20", "color": "#fff",
      "width": 110, "height": 28, "font-size": 11, "text-valign": "center", "text-max-width": 100 } },
    { selector: 'node[kind="mcc"]', style: {
      "shape": "diamond", "background-color": "#f9a825", "width": 26, "height": 26 } },
    { selector: "edge", style: {
      "curve-style": "bezier", "target-arrow-shape": "triangle", "width": 1.6,
      "line-color": "#b7c3cf", "target-arrow-color": "#b7c3cf", "arrow-scale": 0.9 } },
    { selector: 'edge[rel="partOf"]', style: {
      "line-color": "#dbe3ea", "target-arrow-shape": "none", "width": 1.2 } },
    { selector: 'edge[rel="feeds"]', style: {
      "label": "data(media)", "font-size": 8, "color": "#8a5a2b",
      "text-rotation": "autorotate", "line-color": "#7d97ad", "target-arrow-color": "#7d97ad" } },
    { selector: 'edge[rel="powers"]', style: {
      "line-color": "#f9a825", "target-arrow-color": "#f9a825", "line-style": "dashed" } },
    { selector: 'edge[rel="contains"]', style: {
      "line-color": "#9e9e9e", "target-arrow-shape": "none" } },
    { selector: ".dim", style: { "opacity": 0.15 } },
    { selector: ".hl", style: { "border-width": 3, "border-color": "#ff6d00" } },
  ];
}

function colorNodes() {
  cy.nodes('[kind="system"]').forEach(n => {
    n.style("background-color", SYS_COLOR[sysKey(n.id())] || "#555");
  });
  cy.nodes('[kind="asset"]').forEach(n => {
    const s = sysKey(n.data("system"));
    n.style("background-color", SYS_COLOR[s] || "#9db3c6");
  });
}

function renderGraph() {
  if (!graphData) return;
  const legend = document.getElementById("gc-legend");
  const sysLegend = graphData.systems.map(s =>
    `<span><i style="background:${SYS_COLOR[sysKey(s.id)]}"></i>${s.label}</span>`).join("");

  // 모드별 요소 필터
  let els;
  if (curMode === "tree") {
    // 계통 → 장비 (partOf) 계층
    els = graphData.nodes.filter(n => ["system", "asset"].includes(n.data.kind))
      .concat(graphData.edges.filter(e => e.data.rel === "partOf"));
  } else {
    // flow / qty: feeds + 펌프 전원, 계통노드는 제외(위상 흐름 중심)
    const keepRels = ["feeds", "powers", "contains"];
    const edges = graphData.edges.filter(e => keepRels.includes(e.data.rel));
    const usedIds = new Set();
    edges.forEach(e => { usedIds.add(e.data.source); usedIds.add(e.data.target); });
    els = graphData.nodes.filter(n => usedIds.has(n.data.id) || n.data.kind === "pumpstation")
      .concat(edges);
  }

  if (cy) cy.destroy();
  cy = cytoscape({
    container: document.getElementById("cy"),
    elements: els, style: baseStyle(),
    layout: curMode === "tree"
      ? { name: "dagre", rankDir: "LR", nodeSep: 16, rankSep: 90, edgeSep: 8 }
      : { name: "dagre", rankDir: "LR", nodeSep: 22, rankSep: 70 },
    wheelSensitivity: 0.2,
  });
  colorNodes();

  if (curMode === "qty") {
    // 엣지 굵기·색 = 배관 물량(m), 노드 크기 = 관련 물량
    const qs = cy.edges('[rel="feeds"]').map(e => e.data("pipeQty") || 0);
    const qmax = Math.max(1, ...qs);
    cy.edges('[rel="feeds"]').forEach(e => {
      const q = e.data("pipeQty") || 0;
      const w = 1.5 + (q / qmax) * 9;
      const c = q > 0 ? `hsl(${210 - (q / qmax) * 190}, 75%, 45%)` : "#c8d2db";
      e.style({ "width": w, "line-color": c, "target-arrow-color": c,
        "label": q > 0 ? `${Math.round(q)}m` : "", "font-size": 9, "color": c });
    });
    cy.nodes('[kind="asset"]').forEach(n => {
      const q = n.data("pipeQty") || 0;
      const sz = 20 + Math.sqrt(q) * 2.5;
      n.style({ "width": sz, "height": sz });
    });
    legend.innerHTML = `<span><i style="background:hsl(20,75%,45%)"></i>물량 많음</span>` +
      `<span><i style="background:hsl(210,75%,45%)"></i>적음</span>` +
      `　엣지 굵기·라벨 = 배관 연장(m)`;
  } else if (curMode === "tree") {
    legend.innerHTML = sysLegend + `　<span>계통 → 소속 장비 (partOf)</span>`;
  } else {
    legend.innerHTML = sysLegend +
      `<span><i style="background:#f9a825"></i>MCC/전원</span>` +
      `　<span>화살표 = feeds 흐름</span>`;
  }

  cy.on("tap", "node", evt => {
    const d = evt.target.data();
    cy.elements().removeClass("hl dim");
    const nb = evt.target.closedNeighborhood();
    cy.elements().not(nb).addClass("dim");
    evt.target.addClass("hl");
    let t = `${d.label}`;
    if (d.tag) t += `  [${d.tag}]`;
    if (d.kind === "asset" && d.pipeQty) t += `\n관련 배관 물량 ≈ ${d.pipeQty} m`;
    if (d.kind === "system") t += `  (계통)`;
    if (d.kind === "pumpstation") t += `  (중계펌프장)`;
    document.getElementById("cy-tip").textContent = t;
    if (d.kind === "asset") showAssetCard(d.id);   // 클릭 = 종합 카드 질의
  });
  cy.on("tap", evt => {
    if (evt.target === cy) { cy.elements().removeClass("hl dim");
      document.getElementById("cy-tip").textContent = "노드를 클릭하면 상세가 표시됩니다."; }
  });
  setTimeout(() => cy.fit(null, 30), 40);
}
