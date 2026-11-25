

import { app } from "../../scripts/app.js";

const EXT_NAME = "ComfyUI.NodeInserter";
const VERSION = "1.0.2";
const LOG = "[NodeInserter]";



function LG() {
  return (
    window.LiteGraph ||
    window.comfyAPI?.litegraph?.LiteGraph ||
    window.comfyAPI?.LiteGraph ||
    null
  );
}


function typeTokens(t) {
  if (t === null || t === undefined) return ["*"];
  if (Array.isArray(t)) {
    const out = [];
    for (const x of t) out.push(...typeTokens(x));
    return out.length ? out : ["*"];
  }
  const s = String(t).trim();
  if (!s) return ["*"];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}


function compatible(destType, srcType) {
  const d = typeTokens(destType);
  const s = typeTokens(srcType);
  if (d.includes("*") || s.includes("*")) return true;
  return s.some((x) => d.includes(x));
}


function getLink(graph, id) {
  if (!graph || id === null || id === undefined) return null;
  const links = graph.links ?? graph._links;
  if (!links) return null;
  if (typeof links.get === "function") return links.get(id) ?? null;
  return links[id] ?? null;
}

function eachLink(graph, fn) {
  const links = graph?.links ?? graph?._links;
  if (!links) return;
  if (typeof links.forEach === "function" && typeof links.get === "function") {
    links.forEach((l, k) => fn(l, k));
    return;
  }
  for (const k of Object.keys(links)) fn(links[k], k);
}

function toast(severity, summary, detail, life = 6000) {
  try {
    const t = app.extensionManager?.toast;
    if (t?.add) {
      t.add({ severity, summary: tr(summary), detail: tr(detail), life });
      return;
    }
  } catch (err) {
    /* ignore */
  }
  const fn = severity === "error" ? console.error : console.log;
  fn(LOG, summary, detail ?? "");
}



let changeDepth = 0;
let piniaCache = null;
let warnedCount = false;

function piniaOf() {
  if (piniaCache) return piniaCache;
  try {

    const el =
      document.getElementById("vue-app") ||
      document.querySelector("#vue-app") ||
      document.body?.firstElementChild;
    const vueApp = el?.__vue_app__;
    const p = vueApp?.config?.globalProperties?.$pinia;
    if (p?._s?.get) piniaCache = p;
  } catch (err) {
    /* ignore */
  }
  return piniaCache;
}


function changeTracker() {
  try {
    const direct =
      app.extensionManager?.workflow?.activeWorkflow ??
      app.workflowManager?.activeWorkflow ??
      null;
    if (direct?.changeTracker) return direct.changeTracker;

    const store = piniaOf()?._s?.get?.("workflow");
    return store?.activeWorkflow?.changeTracker ?? null;
  } catch (err) {
    return null;
  }
}

function beginChange() {
  changeDepth++;
  if (changeDepth > 1) return;


  try {
    app.graph?.beforeChange?.();
  } catch (err) {
    /* ignore */
  }

  try {
    app.canvas?.emitBeforeChange?.();
  } catch (err) {
    /* ignore */
  }

  try {
    changeTracker()?.beforeChange?.();
  } catch (err) {
    /* ignore */
  }
}

function endChange() {
  if (changeDepth === 0) return;
  changeDepth--;
  if (changeDepth > 0) return;

  try {
    app.graph?.afterChange?.();
  } catch (err) {
    /* ignore */
  }
  try {
    app.canvas?.emitAfterChange?.();
  } catch (err) {
    /* ignore */
  }

  const t = changeTracker();
  if (t) {

    try {
      t.afterChange?.();
    } catch (err) {
      /* ignore */
    }


    if (t.changeCount !== 0) {
      if (!warnedCount) {
        warnedCount = true;
        console.warn(LOG, "撤销事务计数没归零，已修正", t.changeCount);
      }
      t.changeCount = 0;
    }
    try {
      t.captureCanvasState?.();
    } catch (err) {
      /* ignore */
    }
  } else {

    try {
      window.dispatchEvent(new MouseEvent("mouseup"));
    } catch (err) {
      /* ignore */
    }
  }
}


function commitUndo() {
  const t = changeTracker();
  if (t?.captureCanvasState) {

    if (t.changeCount > 0) t.changeCount = 0;
    try {
      t.captureCanvasState();
      return true;
    } catch (err) {
      /* ignore */
    }
  }
  try {
    window.dispatchEvent(new MouseEvent("mouseup"));
  } catch (err) {
    /* ignore */
  }
  return false;
}

function nodeName(n) {
  return n?.title || n?.type || "节点";
}


function selectedNodes() {
  const out = [];
  const seen = new Set();
  const add = (n) => {
    if (n && n.id !== undefined && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  };

  const sel = app.canvas?.selected_nodes;
  if (sel) for (const n of Object.values(sel)) add(n);

  if (!out.length && Array.isArray(app.graph?._nodes)) {
    for (const n of app.graph._nodes) if (n?.selected) add(n);
  }
  return out;
}




function canvasElement() {
  try {
    return app.canvas?.canvas ?? app.canvasEl ?? null;
  } catch (err) {
    return null;
  }
}


function eventToGraph(e) {
  const cnv = app.canvas;
  const el = canvasElement();
  if (!cnv || !el) return null;
  const rect = el.getBoundingClientRect();
  const ds = cnv.ds ?? { scale: 1, offset: [0, 0] };
  const scale = ds.scale || 1;
  return {
    x: (e.clientX - rect.left) / scale - (ds.offset?.[0] ?? 0),
    y: (e.clientY - rect.top) / scale - (ds.offset?.[1] ?? 0),
    scale,
    el,
  };
}


function slotPos(node, index, isInput) {
  try {

    if (typeof node.getSlotPosition === "function") {
      const p = node.getSlotPosition(index, isInput);
      if (p && isFinite(p[0]) && isFinite(p[1])) return [p[0], p[1]];
    }
  } catch (err) {
    /* ignore */
  }
  try {
    const p = isInput ? node.getInputPos?.(index) : node.getOutputPos?.(index);
    if (p && isFinite(p[0]) && isFinite(p[1])) return [p[0], p[1]];
  } catch (err) {
    /* ignore */
  }

  const w = node.size?.[0] ?? 200;
  const h = node.size?.[1] ?? 100;
  return isInput ? [node.pos[0], node.pos[1] + h * 0.5] : [node.pos[0] + w, node.pos[1] + h * 0.5];
}


function rerouteChain(graph, link) {
  const out = [];
  const store = graph?.reroutes;
  if (!store) return out;

  let pid = link?.parentId;
  let guard = 0;
  while (pid !== null && pid !== undefined && guard++ < 200) {
    const r = typeof store.get === "function" ? store.get(pid) : store[pid];
    if (!r) break;
    out.unshift([r.pos[0], r.pos[1]]);
    pid = r.parentId;
  }
  return out;
}

function bezier(p0, c1, c2, p1, u) {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
}


function buildPolyline(graph, link, kind) {
  const a = graph.getNodeById(link.origin_id);
  const b = graph.getNodeById(link.target_id);
  if (!a || !b) return null;

  const start = link.origin_slot === -1
    ? [a.pos[0] + 10, a.pos[1] + 10]
    : slotPos(a, link.origin_slot, false);
  const end = link.target_slot === -1
    ? [b.pos[0] + 10, b.pos[1] + 10]
    : slotPos(b, link.target_slot, true);

  const sDir = slotDirOf(a.outputs?.[link.origin_slot]) ?? (kind === "splineClassic" ? "right" : null);
  const eDir = slotDirOf(b.inputs?.[link.target_slot]) ?? (kind === "splineClassic" ? "left" : null);

  const mids = rerouteChain(graph, link);
  const stops = [start, ...mids, end];
  const pts = [];

  for (let i = 0; i < stops.length - 1; i++) {
    const s = stops[i];
    const t = stops[i + 1];
    const dist = Math.hypot(t[0] - s[0], t[1] - s[1]);
    const off = Math.max(30, dist * 0.25);

    if (kind === "chord") {
      pts.push(s, t);
      continue;
    }

    if (kind === "linear") {
      const o1 = sDir ? dirVec(sDir, 15) : [0, 0];
      const o2 = eDir ? dirVec(eDir, 15) : [0, 0];
      pts.push(s, [s[0] + o1[0], s[1] + o1[1]], [t[0] + o2[0], t[1] + o2[1]], t);
      continue;
    }

    if (kind === "straight") {
      const o1 = sDir ? dirVec(sDir, 10) : [0, 0];
      const o2 = eDir ? dirVec(eDir, 10) : [0, 0];
      const p1 = [s[0] + o1[0], s[1] + o1[1]];
      const p2 = [t[0] + o2[0], t[1] + o2[1]];
      const mx = (p1[0] + p2[0]) / 2;
      pts.push(s, p1, [mx, p1[1]], [mx, p2[1]], p2, t);
      continue;
    }


    const o1 = sDir ? dirVec(sDir, off) : [0, 0];
    const o2 = eDir ? dirVec(eDir, off) : [0, 0];
    const c1 = [s[0] + o1[0], s[1] + o1[1]];
    const c2 = [t[0] + o2[0], t[1] + o2[1]];
    const steps = 16;
    for (let k = 0; k <= steps; k++) pts.push(bezier(s, c1, c2, t, k / steps));
  }
  return pts;
}


function slotDirOf(slot) {
  const d = slot?.dir;
  if (d === "left" || d === "right" || d === "up" || d === "down") return d;
  return null;
}

function dirVec(dir, len) {
  switch (dir) {
    case "left": return [-len, 0];
    case "right": return [len, 0];
    case "up": return [0, -len];
    case "down": return [0, len];
    default: return [0, 0];
  }
}


function linkRenderMode() {
  const m = app.canvas?.links_render_mode;
  if (m === 0 || m === "0") return 0;
  if (m === 1 || m === "1") return 1;
  return 2;
}


function linkVariants(graph, link) {
  const mode = linkRenderMode();
  const kind = mode === 0 ? "straight" : mode === 1 ? "linear" : "spline";

  const out = [];
  const primary = buildPolyline(graph, link, kind);
  if (primary && primary.length >= 2) out.push({ kind, pts: primary });

  if (kind === "spline") {
    const legacy = buildPolyline(graph, link, "splineClassic");
    if (legacy && legacy.length >= 2) out.push({ kind: "splineClassic", pts: legacy });
  }
  return out;
}

function distToSegment(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(px - a[0], py - a[1]);
  let t = ((px - a[0]) * vx + (py - a[1]) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a[0] + t * vx), py - (a[1] + t * vy));
}

function distToPolyline(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(px, py, pts[i], pts[i + 1]);
    if (d < best) best = d;
  }
  return best;
}


function nodeAt(graph, x, y) {
  try {
    return graph.getNodeOnPos?.(x, y, graph._nodes, 0) ?? null;
  } catch (err) {
    return null;
  }
}


function findLinkAt(x, y, tol, g) {
  const graph = g ?? app.graph;
  if (!graph) return null;


  const onNode = nodeAt(graph, x, y);
  if (onNode) {
    const viaSlot = inputSlotLinkAt(graph, onNode, x, y);
    if (viaSlot) return viaSlot;



  }

  let best = null;
  let bestD = Infinity;
  eachLink(graph, (link) => {
    if (!link || link.origin_id === undefined || link.target_id === undefined) return;
    const variants = linkVariants(graph, link);
    for (let i = 0; i < variants.length; i++) {
      const lim = i === 0 ? tol : tol * 0.7;
      const d = distToPolyline(x, y, variants[i].pts);
      if (d <= lim && d < bestD) {
        bestD = d;
        best = link;
      }
    }
  });
  return best;
}


function nearestLinkInfo(x, y) {
  const graph = app.graph;
  if (!graph) return null;
  let info = null;
  eachLink(graph, (link) => {
    if (!link || link.origin_id === undefined || link.target_id === undefined) return;
    for (const v of linkVariants(graph, link)) {
      const d = distToPolyline(x, y, v.pts);
      if (!info || d < info.dist) {
        const a = graph.getNodeById(link.origin_id);
        const b = graph.getNodeById(link.target_id);
        info = {
          dist: Math.round(d * 10) / 10,
          kind: v.kind,
          link: `${nodeName(a)}.out[${link.origin_slot}] → ${nodeName(b)}.in[${link.target_slot}]`,
        };
      }
    }
  });
  return info;
}


function inputSlotLinkAt(graph, node, x, y) {
  try {
    const hit = node.getSlotInPosition?.(x, y);
    if (hit) {
      if (hit.input && hit.input.link !== null && hit.input.link !== undefined) {
        return getLink(graph, hit.input.link);
      }
      return null;
    }
  } catch (err) {
    /* ignore */
  }

  let best = null;
  let bestD = 16;
  (node.inputs ?? []).forEach((s, i) => {
    if (s?.link === null || s?.link === undefined) return;
    const p = slotPos(node, i, true);
    if (!p) return;
    const d = Math.hypot(x - p[0], y - p[1]);
    if (d < bestD) {
      bestD = d;
      best = getLink(graph, s.link);
    }
  });
  return best;
}



function slotIsFree(slot, isInput) {


  if (isInput) {
    const v = slot?.link;
    return v === null || v === undefined || v === -1;
  }
  return (slot?.links?.length ?? 0) === 0;
}


function pickSlot(node, isInput, dataType, opts = {}) {
  const slots = (isInput ? node.inputs : node.outputs) ?? [];
  const want = typeTokens(dataType);
  const used = opts.used ?? null;
  const onlyFree = opts.onlyFree === true;

  let best = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s) continue;
    if (used && used.has(i)) continue;
    if (onlyFree && !slotIsFree(s, isInput)) continue;


    const ok = isInput ? compatible(s.type, dataType) : compatible(dataType, s.type);
    if (!ok) continue;

    const st = typeTokens(s.type);
    let score = 0;
    if (!st.includes("*") && st.some((t) => want.includes(t))) score += 100;
    if (st.includes("*") || want.includes("*")) score -= 25;

    const free = slotIsFree(s, isInput);
    if (free) score += 30;
    else if (isInput) score -= 500;





    if (isInput && s.widget) score -= 40;

    score += Math.max(0, 12 - i) * 0.5;

    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}



function ensureSize(node) {
  try {
    if (!node.size || node.size[0] < 10 || node.size[1] < 10) {
      const sz = node.computeSize?.();
      if (Array.isArray(sz) && sz[0] > 0) node.size = [sz[0], sz[1]];
    }
  } catch (err) {
    /* ignore */
  }
}


function shiftDownstream(graph, start, dx) {
  if (!start || !dx) return 0;
  const seen = new Set([start.id]);
  const queue = [start];
  let moved = 0;

  while (queue.length) {
    const n = queue.shift();
    try {
      n.pos[0] += dx;
      n.setDirtyCanvas?.(true, true);
      moved++;
    } catch (err) {
      /* ignore */
    }
    for (const out of n.outputs ?? []) {
      for (const lid of out.links ?? []) {
        const l = getLink(graph, lid);
        if (!l) continue;
        const nxt = graph.getNodeById(l.target_id);
        if (!nxt || seen.has(nxt.id)) continue;
        seen.add(nxt.id);
        queue.push(nxt);
      }
    }
  }
  return moved;
}


function placeNode(node, origin, target, gx, gy, inIdx, fromNode) {
  ensureSize(node);
  const W = node.size?.[0] ?? 200;
  const H = node.size?.[1] ?? 100;


  const anchor = fromNode ?? origin;
  const aRight = anchor.pos[0] + (anchor.size?.[0] ?? 0);
  const bLeft = target.pos[0];
  const gap = bLeft - aRight;
  const pad = 34;

  let x;
  if (fromNode) {
    x = aRight + pad;
  } else if (gap >= W + pad * 2) {
    x = aRight + pad + (gap - W - pad * 2) / 2;
  } else {
    x = bLeft - W - pad;
  }

  node.pos[0] = x;


  const baseY = (typeof gy === "number" ? gy : target.pos[1]) - H / 2;
  node.pos[1] = baseY;
  const p = slotPos(node, inIdx, true);
  if (p && isFinite(p[1])) node.pos[1] += (typeof gy === "number" ? gy : p[1]) - p[1];


  if (node.pos[1] < -2000) node.pos[1] = -2000;


  const need = node.pos[0] + W + 30 - target.pos[0];
  if (need > 1) shiftDownstream(app.graph, target, need);

  node.setDirtyCanvas?.(true, true);
}




let lastInsertOutLinkId = null;

let lastInsertAutoCount = 0;

function safeConnect(fromNode, fromSlot, toNode, toSlot, rerouteId) {
  if (rerouteId !== null && rerouteId !== undefined) {
    try {
      const l = fromNode.connect(fromSlot, toNode, toSlot, rerouteId);
      if (l) return l;
    } catch (err) {
      console.warn(LOG, "带中转点连接失败，改用普通连接", err);
    }
  }
  try {
    return fromNode.connect(fromSlot, toNode, toSlot) ?? null;
  } catch (err) {
    console.warn(LOG, "连接失败", err);
    return null;
  }
}



let lastReport = null;

function nodeTag(n) {
  return n ? `${nodeName(n)}#${n.id}` : "?";
}


function nodeModeTag(n) {
  const m = n?.mode ?? 0;
  if (m === 4) return "【旁路】";
  if (m === 2) return "【静音】";
  if (m && m !== 0) return `【mode=${m}】`;
  return "";
}

function dumpNodeLines(node, graph) {
  if (!node) return ["(节点不存在)"];
  const rows = [];

  rows.push(
    `── ${nodeTag(node)}  [type=${node.type}]  `
      + `pos ${Math.round(node.pos?.[0] ?? 0)},${Math.round(node.pos?.[1] ?? 0)}`
      + nodeModeTag(node),
  );

  (node.inputs ?? []).forEach((s, i) => {
    const l = getLink(graph, s?.link);
    if (!l) {
      rows.push(`  in  [${i}] ${s.name} (${s.type})  ←  —`);
      return;
    }

    const ts = l.target_slot;
    const real = (node.inputs ?? [])[ts];
    const name = real?.name ?? s.name;
    const type = real?.type ?? s.type;
    const tag = ts === i ? "" : `　⚠实际槽位 in[${ts}]（挂在 in[${i}] 的 link 上）`;
    rows.push(
      `  in  [${ts}] ${name} (${type})  ←  ${nodeTag(graph.getNodeById(l.origin_id))}.out[${l.origin_slot}]  link.type=${l.type}${tag}`,
    );
  });

  (node.outputs ?? []).forEach((s, i) => {
    const ids = Array.isArray(s?.links) ? s.links : [];
    if (!ids.length) {
      rows.push(`  out [${i}] ${s.name} (${s.type})  →  —`);
      return;
    }
    for (const id of ids) {
      const l = getLink(graph, id);
      if (!l) {
        rows.push(`  out [${i}] ${s.name} (${s.type})  →  link#${id} 已失效`);
        continue;
      }



      const os = l.origin_slot;
      const real = (node.outputs ?? [])[os];
      const name = real?.name ?? s.name;
      const type = real?.type ?? s.type;
      const tag = os === i ? "" : `　⚠实际槽位 out[${os}]（挂在 out[${i}] 的 links 下）`;
      rows.push(
        `  out [${os}] ${name} (${type})  →  ${nodeTag(graph.getNodeById(l.target_id))}.in[${l.target_slot}]  link.type=${l.type}${tag}`,
      );
    }
  });

  return rows;
}

function dumpText(nodes, graph) {
  const g = graph ?? app.graph;
  return (nodes ?? [])
    .filter(Boolean)
    .flatMap((n) => [...dumpNodeLines(n, g), ""])
    .join("\n")
    .trimEnd();
}


function aroundNodes(node, graph) {
  const g = graph ?? app.graph;
  const out = [];
  const seen = new Set();
  const add = (n) => {
    if (n && n.id !== undefined && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  };
  add(node);
  for (const s of node?.inputs ?? []) {
    const l = getLink(g, s?.link);
    if (l) add(g.getNodeById(l.origin_id));
  }
  for (const s of node?.outputs ?? []) {
    for (const id of s?.links ?? []) {
      const l = getLink(g, id);
      if (l) add(g.getNodeById(l.target_id));
    }
  }
  return out;
}


function publishReport(kind, headline, sections) {
  const text = trBlock([
    `ComfyUI-NodeInserter v${VERSION} — ${tr(kind)}`,
    ...(headline ? [headline] : []),
    "",
    ...(sections ?? []),
  ].join("\n"));
  lastReport = text;

  let copied = false;
  try {
    const nav = globalThis.navigator;
    if (nav?.clipboard?.writeText) {
      nav.clipboard.writeText(text).then(
        () => {},
        () => {},
      );
      copied = true;
    }
  } catch (err) {

  }

  console.log(`${LOG} ${kind}报告\n${text}`);
  return copied;
}


function insertNodeIntoLink(node, link, opts = {}) {
  const graph = app.graph;
  if (!graph || !node || !link) return false;

  const origin = graph.getNodeById(link.origin_id);
  const target = graph.getNodeById(link.target_id);

  if (!origin || !target) {
    toast(
      "error",
      "这条线接不到两端节点",
      "可能指向子图的输入 / 输出，或连线已经失效，暂不支持插入。",
      7000
    );
    return false;
  }
  if (node === origin || node === target) {
    toast("warn", "不能插在自己所在的那条线上", "换一个节点或者换一条线。", 5000);
    return false;
  }


  const inType =
    origin.outputs?.[link.origin_slot]?.type ??
    link.type ??
    target.inputs?.[link.target_slot]?.type ??
    "*";
  const outType =
    target.inputs?.[link.target_slot]?.type ??
    link.type ??
    inType;

  const inIdx = pickSlot(node, true, inType);
  const outIdx = pickSlot(node, false, outType);

  if (inIdx < 0) {
    toast(
      "error",
      `${nodeName(node)} 接不上这条线的上游`,
      `它没有能接收 ${inType} 类型的输入位。`,
      8000
    );
    return false;
  }
  if (outIdx < 0) {
    toast(
      "error",
      `${nodeName(node)} 接不上这条线的下游`,
      `它没有能输出 ${outType} 类型的输出位。`,
      8000
    );
    return false;
  }
  if (!slotIsFree(node.inputs?.[inIdx], true)) {
    toast(
      "warn",
      `${nodeName(node)} 的 ${node.inputs[inIdx]?.name ?? "输入"} 位已经被占用`,
      "为了不破坏别的连线，这次没有插入。",
      8000
    );
    return false;
  }


  const L = LG();
  if (typeof L?.isValidConnection === "function") {
    const slotIn = typeTokens(node.inputs?.[inIdx]?.type);
    const slotOut = typeTokens(node.outputs?.[outIdx]?.type);
    const okIn = L.isValidConnection(inType, node.inputs?.[inIdx]?.type ?? inType);
    const okOut = L.isValidConnection(node.outputs?.[outIdx]?.type ?? outType, outType);
    if (!okIn || !okOut) {
      toast(
        "error",
        `${nodeName(node)} 的类型对不上这条线`,
        `${inType} → [${slotIn.join("/")} … ${slotOut.join("/")}] → ${outType}`,
        9000
      );
      return false;
    }
  }

  const rerouteId = link.parentId ?? null;
  const linkId = link.id;


  const beforeText = dumpText([origin, node, target], graph);

  beginChange();
  try {

    let removed = false;
    try {
      if (typeof graph.removeLink === "function") {
        graph.removeLink(linkId);
        removed = true;
      }
    } catch (err) {
      console.warn(LOG, "removeLink 失败，改用 disconnectInput", err);
    }
    if (!removed) {
      try {
        target.disconnectInput(link.target_slot);
      } catch (err) {
        /* ignore */
      }
    }


    const l1 = safeConnect(origin, link.origin_slot, node, inIdx, rerouteId);
    if (!l1) {

      safeConnect(origin, link.origin_slot, target, link.target_slot, rerouteId);
      toast("error", "上游没接上，已还原原来的连线", "这条线的类型可能不被这个节点接受。", 9000);
      return false;
    }


    const l2 = safeConnect(node, outIdx, target, link.target_slot, null);
    if (!l2) {
      toast(
        "error",
        "下游没接上",
        `已把 ${nodeName(origin)} 接到 ${nodeName(node)}，剩下的请手动补一根线。`,
        9000
      );
      return false;
    }


    lastInsertOutLinkId = l2?.id ?? null;
    lastInsertAutoCount = 0;


    placeNode(node, origin, target, opts.gx, opts.gy, inIdx, opts.placeFrom);









    let extraInfo = null;
    if (!opts.noExtras) {
      try {
        const { plan, skipped } = planExtraLinks(node, link, outIdx, inIdx);


        const auto = plan.filter((x) => x.parallel || x.intoTarget || x.sameFanout);
        const ask = plan.filter((x) => !x.parallel && !x.intoTarget && !x.sameFanout);

        const autoOk = applyExtras(node, auto);
        lastInsertAutoCount = autoOk;



        if (opts.collect) {



          for (const it of [...ask, ...skipped]) opts.collect.push(it.link);
        }
        extraInfo = {
          autoOk,
          autoList: auto.map((x) => ({
            type: String(x.type),
            from: x.from,
            to: x.to,
            kind: x.parallel ? "平行" : x.sameFanout ? "同一输出的分支" : "同下游",
            inName: x.inName,
            outName: x.outName,
          })),
          ask: opts.collect ? [] : ask,
          askList: ask.map((x) => ({ type: String(x.type), from: x.from, to: x.to })),
          skipped: skipped.length,
          skippedList: skipped.map((x) => ({
            type: String(x.type),
            from: `${nodeName(x.origin)}.${slotLabel(x.origin, x.link.origin_slot, false)}`,
            to: `${nodeName(x.target)}.${slotLabel(x.target, x.link.target_slot, true)}`,
          })),
        };
      } catch (err) {
        console.warn(LOG, "补兄弟线时出错", err);
      }
    }





    let feedInfo = null;
    if (!opts.noFeed) {
      try {
        feedInfo = feedEmptyInputs(node, graph, { target });
      } catch (err) {
        console.warn(LOG, "补空口时出错", err);
      }
    }


    node.setDirtyCanvas?.(true, true);
    origin.setDirtyCanvas?.(true, true);
    target.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    try {
      app.canvas?.selectNode?.(node, false);
    } catch (err) {
      try {
        if (app.canvas) app.canvas.selected_nodes = { [node.id]: node };
      } catch (err2) {
        /* ignore */
      }
    }

    const bits = [];
    if (extraInfo?.autoOk) bits.push(`顺路接上 ${extraInfo.autoOk} 条线`);
    if (extraInfo?.ask?.length) bits.push(`另有 ${extraInfo.ask.length} 条等你确认`);
    if (extraInfo?.skipped) bits.push(`${extraInfo.skipped} 条接不上`);
    if (feedInfo?.added) {
      const types = [...new Set(feedInfo.pairs.map((p) => p.type))].join("/");
      bits.push(`补上 ${feedInfo.added} 个空口（${types}）`);
    }
    if (feedInfo?.rewired) bits.push(`改接 ${feedInfo.rewired} 条下游`);
    if (feedInfo?.spliced?.length) bits.push(`串进 ${feedInfo.spliced.length} 条已有的线`);




    const emptyLeft = [];
    (node.inputs ?? []).forEach((s, i) => {
      if (!isAutoPort(s) || !slotIsFree(s, true)) return;
      emptyLeft.push(`in [${i}] ${s.name} (${s.type})`);
    });
    (node.outputs ?? []).forEach((s, i) => {
      if (!isAutoPort(s) || !slotIsFree(s, false)) return;
      emptyLeft.push(`out[${i}] ${s.name} (${s.type})`);
    });

    const sec = [
      `插入：${nodeTag(origin)}.out[${link.origin_slot}] → ${nodeTag(target)}.in[${link.target_slot}]（${inType}）`,
      `新节点：${nodeTag(node)}　进 in[${inIdx}] ${slotLabel(node, inIdx, true)} · 出 out[${outIdx}] ${slotLabel(node, outIdx, false)}`,
      `结果：主线 1 · 顺路 ${extraInfo?.autoOk ?? 0} · 补空口 ${feedInfo?.added ?? 0}`
        + ` · 串进已连线 ${feedInfo?.spliced?.length ?? 0}`
        + ` · 改接下游 ${feedInfo?.rewired ?? 0} · 待确认 ${extraInfo?.ask?.length ?? 0}`
        + ` · 跳过 ${extraInfo?.skipped ?? 0}`,
      "",
    ];

    if (extraInfo?.autoList?.length) {
      sec.push("【顺路一起接上】");
      for (const it of extraInfo.autoList) {
        sec.push(`  ${it.type}（${it.kind}） ${it.from} → ${it.to}　走 [${it.inName}] → [${it.outName}]`);
      }
      sec.push("");
    }
    if (feedInfo?.pairs?.length) {
      sec.push("【往上找料补的空口】");
      for (const p of feedInfo.pairs) sec.push(`  ${p.type}  ${p.from} → [${p.to}]`);
      sec.push("");
    }
    if (feedInfo?.spliced?.length) {
      sec.push("【串进画布上已有的线】");
      for (const p of feedInfo.spliced) {
        sec.push(`  ${p.type}  ${p.from} → [${p.inName}] → [${p.outName}] → ${p.to}`);
      }
      sec.push("");
    }
    if (feedInfo?.rewirePairs?.length) {
      sec.push("【改接到新节点后面的下游】");
      for (const p of feedInfo.rewirePairs) sec.push(`  ${p.type}  → ${p.to}`);
      sec.push("");
    }
    if (feedInfo?.left?.length) {
      sec.push("【没能接出去】");
      for (const p of feedInfo.left) sec.push(`  ${p.type}  ${p.why}`);
      sec.push("");
    }
    if (emptyLeft.length) {
      sec.push("【新节点仍然空着的口】");
      for (const s of emptyLeft) sec.push(`  ${s}`);
      sec.push("");
    }
    if (extraInfo?.skippedList?.length) {
      sec.push("【跳过：新节点没有对应的空口】");
      for (const it of extraInfo.skippedList) sec.push(`  ${it.type}  ${it.from} → ${it.to}`);
      sec.push("");
    }
    if (extraInfo?.askList?.length) {
      sec.push("【等你确认的兄弟线】");
      for (const it of extraInfo.askList) sec.push(`  ${it.type}  ${it.from} → ${it.to}`);
      sec.push("");
    }



    const seenId = new Set([origin.id, node.id, target.id]);
    const around = [origin, node, target];
    for (const s of target.inputs ?? []) {
      const l = getLink(graph, s?.link);
      const n = l ? graph.getNodeById(l.origin_id) : null;
      if (n && !seenId.has(n.id)) {
        seenId.add(n.id);
        around.push(n);
      }
    }

    sec.push("【插入前】", beforeText, "");
    sec.push("【插入后】", dumpText(around, graph));



    if (!opts.silent) {
      const copied = publishReport(
        "插入",
        `${nodeName(node)} 插进 ${nodeName(origin)} → ${nodeName(target)} 之间`,
        sec,
      );
      toast(
        "success",
        `已插入 ${nodeName(node)}`,
        [
          `${nodeName(origin)} → ${nodeName(node)} → ${nodeName(target)}`,
          ...bits,
          copied ? "连线报告已复制到剪贴板" : "连线报告已写入控制台（F12）",
        ].join("　·　"),
        5200
      );
    }

    console.log(LOG, "插入完成", {
      node: nodeName(node),
      from: nodeName(origin),
      to: nodeName(target),
      inIdx,
      outIdx,
      extras: extraInfo,
      补空口: feedInfo,
    });


    if (extraInfo?.ask?.length && !opts.silent) {
      const waiting = extraInfo.ask;
      setTimeout(() => askConnectExtras(node, waiting), 80);
    }

    return true;
  } catch (err) {
    console.error(LOG, "插入过程中出错", err);
    toast("error", "插入失败", String(err?.message ?? err));
    return false;
  } finally {
    endChange();
    app.canvas?.setDirty?.(true, true);
  }
}




function linkParts(l) {
  if (Array.isArray(l)) {
    return {
      id: l[0],
      origin_id: l[1],
      origin_slot: l[2],
      target_id: l[3],
      target_slot: l[4],
      type: l[5],
      parentId: l[6] ?? null,
    };
  }
  return l ?? null;
}


function linkTypeOf(l) {
  const p = linkParts(l);
  const graph = app.graph;
  const o = graph?.getNodeById?.(p.origin_id);
  const t = graph?.getNodeById?.(p.target_id);

  const concrete = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const ts = typeTokens(v);
    return ts.length && !ts.includes("*") ? v : null;
  };

  return (
    concrete(p.type) ??
    concrete(o?.outputs?.[p.origin_slot]?.type) ??
    concrete(t?.inputs?.[p.target_slot]?.type) ??
    p.type ??
    o?.outputs?.[p.origin_slot]?.type ??
    "*"
  );
}

function slotLabel(node, idx, isInput) {
  const s = (isInput ? node.inputs : node.outputs)?.[idx];
  return s?.name ?? (isInput ? "输入" : "输出");
}


function planExtraLinks(node, primaryLink, primaryOutIdx = -1, primaryInIdx = -1) {
  const graph = app.graph;
  const prim = linkParts(primaryLink);
  if (!graph || !prim) return { plan: [], skipped: [] };


  const usedIn = new Set();
  const usedOut = new Set();
  (node.inputs ?? []).forEach((s, i) => {
    if (!slotIsFree(s, true)) usedIn.add(i);
  });
  (node.outputs ?? []).forEach((s, i) => {
    if (!slotIsFree(s, false)) usedOut.add(i);
  });

  const plan = [];
  const skipped = [];
  const seen = new Set([prim.id]);


  const line = lineBelow(graph, graph.getNodeById(prim.target_id));

  eachLink(graph, (raw) => {
    const l = linkParts(raw);
    if (!l || l.id === undefined || l.id === null) return;
    if (seen.has(l.id)) return;
    if (l.origin_id === undefined || l.origin_id === null) return;
    if (l.target_id === undefined || l.target_id === null) return;

    if (l.origin_id === node.id || l.target_id === node.id) return;

    const sameOrigin = l.origin_id === prim.origin_id;
    const sameTarget = l.target_id === prim.target_id;
    if (!sameOrigin && !sameTarget) return;






    const sameOutSlot = sameOrigin && l.origin_slot === prim.origin_slot;




    if (!sameOutSlot && line.size && !line.has(l.target_id)) return;

    seen.add(l.id);

    const origin = graph.getNodeById(l.origin_id);
    const target = graph.getNodeById(l.target_id);
    if (!origin || !target) return;
    if (origin === node || target === node) return;

    const type = linkTypeOf(l);



    const reuseInput =
      l.origin_id === prim.origin_id && l.origin_slot === prim.origin_slot;

    const inIdx = reuseInput
      ? primaryInIdx
      : pickSlot(node, true, type, { used: usedIn, onlyFree: true });



    let outIdx = -1;
    if (
      primaryOutIdx >= 0 &&
      node.outputs?.[primaryOutIdx] &&
      compatible(type, node.outputs[primaryOutIdx].type)
    ) {
      outIdx = primaryOutIdx;
    } else {
      outIdx = pickSlot(node, false, type, { used: usedOut, onlyFree: true });
    }

    if (inIdx < 0 || outIdx < 0) {
      skipped.push({ link: l, type, origin, target });
      return;
    }

    usedIn.add(inIdx);
    usedOut.add(outIdx);
    plan.push({
      link: l,
      inIdx,
      outIdx,
      type,
      reuseInput,
      parallel: sameOrigin && sameTarget,



      intoTarget: sameTarget && !sameOrigin,

      sameFanout: sameOutSlot && !sameTarget,
      origin,
      target,

      from: `${nodeName(origin)}.${slotLabel(origin, l.origin_slot, false)}`,
      to: `${nodeName(target)}.${slotLabel(target, l.target_slot, true)}`,
      inName: slotLabel(node, inIdx, true),
      outName: slotLabel(node, outIdx, false),
    });
  });


  plan.sort((a, b) => Number(b.parallel) - Number(a.parallel));
  return { plan, skipped };
}


function rerouteThroughNode(node, item) {
  const graph = app.graph;
  const { link, inIdx, outIdx } = item;
  const origin = graph.getNodeById(link.origin_id);
  const target = graph.getNodeById(link.target_id);
  if (!origin || !target) return false;

  try {
    if (typeof graph.removeLink === "function") graph.removeLink(link.id);
    else target.disconnectInput(link.target_slot);
  } catch (err) {
    console.warn(LOG, "断开补线失败", err);
    try {
      target.disconnectInput(link.target_slot);
    } catch (err2) {
      return false;
    }
  }

  if (!item.reuseInput) {
    const l1 = safeConnect(origin, link.origin_slot, node, inIdx, link.parentId ?? null);
    if (!l1) {

      safeConnect(origin, link.origin_slot, target, link.target_slot, link.parentId ?? null);
      return false;
    }
  }
  const l2 = safeConnect(node, outIdx, target, link.target_slot, null);
  if (!l2) {



    if (!item.reuseInput) {
      try {
        node.disconnectInput(inIdx);
      } catch (err) {
        /* ignore */
      }
    }
    safeConnect(origin, link.origin_slot, target, link.target_slot, link.parentId ?? null);
    return false;
  }

  node.setDirtyCanvas?.(true, true);
  origin.setDirtyCanvas?.(true, true);
  target.setDirtyCanvas?.(true, true);
  return true;
}

function applyExtras(node, items) {
  if (!items?.length) return 0;
  let ok = 0;
  beginChange();
  try {
    for (const it of items) {
      try {
        if (rerouteThroughNode(node, it)) ok++;
      } catch (err) {
        console.warn(LOG, "补线出错", err);
      }
    }
  } finally {
    endChange();
  }
  app.graph?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
  return ok;
}




const AUTO_SKIP_TYPES = new Set(["COMBO"]);


function isAutoPort(slot) {
  if (!slot) return false;
  if (slot.widget) return false;
  const ts = typeTokens(slot.type);
  if (!ts.length || ts.includes("*")) return false;
  return ts.every((x) => !AUTO_SKIP_TYPES.has(String(x).toUpperCase()));
}


function isTraversable(slot) {
  if (!slot) return false;
  if (slot.widget) return false;
  const ts = typeTokens(slot.type);
  if (!ts.length) return false;
  return ts.every((x) => !AUTO_SKIP_TYPES.has(String(x).toUpperCase()));
}


function typeKeyOf(t) {
  return typeTokens(t)
    .map((x) => String(x).toUpperCase())
    .sort()
    .join("|");
}

function sameType(a, b) {
  const ka = typeKeyOf(a);
  const kb = typeKeyOf(b);
  return !!ka && ka !== "*" && ka === kb;
}


function upstreamSources(node, graph, maxDepth = 6) {
  const out = [];
  const seen = new Set([node.id]);
  let frontier = [node];

  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const s of n.inputs ?? []) {
        if (!s) continue;
        const l = getLink(graph, s.link);
        if (!l) continue;
        if (!isTraversable(s)) continue;
        const src = graph.getNodeById(l.origin_id);
        if (!src || seen.has(src.id)) continue;
        seen.add(src.id);
        out.push(src);
        next.push(src);
      }
    }
    frontier = next;
  }
  return out;
}


function lineBelow(graph, start, maxDepth = 6) {
  const ids = new Set();
  if (!graph || !start) return ids;
  ids.add(start.id);

  let frontier = [start];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const o of n.outputs ?? []) {
        if (!isTraversable(o)) continue;
        for (const id of o?.links ?? []) {
          const l = getLink(graph, id);
          if (!l) continue;
          const t = graph.getNodeById(l.target_id);
          if (!t || ids.has(t.id)) continue;
          ids.add(t.id);
          next.push(t);
        }
      }
    }
    frontier = next;
  }

  return ids;
}


function isDownstreamOf(graph, src, node, maxDepth = 6) {
  const seen = new Set([node.id]);
  let frontier = [node];

  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const o of n.outputs ?? []) {
        for (const id of o?.links ?? []) {
          const l = getLink(graph, id);
          if (!l) continue;
          if (l.target_id === src.id) return true;
          const t = graph.getNodeById(l.target_id);
          if (!t || seen.has(t.id)) continue;
          seen.add(t.id);
          next.push(t);
        }
      }
    }
    frontier = next;
  }
  return false;
}


function convergesInto(graph, start, line, maxDepth = 6) {
  if (!graph || !start || !line || !line.size) return false;
  const seen = new Set([start.id]);
  let frontier = [start];

  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const o of n.outputs ?? []) {
        for (const id of o?.links ?? []) {
          const l = getLink(graph, id);
          if (!l) continue;
          if (line.has(l.target_id)) return true;
          const t = graph.getNodeById(l.target_id);
          if (!t || seen.has(t.id)) continue;
          seen.add(t.id);
          next.push(t);
        }
      }
    }
    frontier = next;
  }
  return false;
}


function fanoutConverging(graph, src, oi, line, maxDepth = 6) {
  const out = [];
  if (!src || !line || !line.size) return out;
  const ids = src.outputs?.[oi]?.links ?? [];
  if (ids.length < 2) return out;
  for (const id of ids) {
    const l = getLink(graph, id);
    const t = l && graph.getNodeById(l.target_id);
    if (!t || line.has(t.id)) continue;
    if (convergesInto(graph, t, line, maxDepth)) out.push(t);
  }
  return out;
}


function downstreamCandidates(graph, node, preferred, src, oi, chain) {
  const out = [];
  const seen = new Set([node.id]);
  const line = chain ?? lineBelow(graph, preferred);
  const push = (n) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
  };

  if (src) {
    for (const id of src.outputs?.[oi]?.links ?? []) {
      const l = getLink(graph, id);
      const t = l && graph.getNodeById(l.target_id);

      if (t && (line.has(t.id) || t.id === preferred?.id)) push(t);
    }
  }
  push(preferred);
  for (const o of node.outputs ?? []) {
    for (const id of o?.links ?? []) {
      const l = getLink(graph, id);
      if (l) push(graph.getNodeById(l.target_id));
    }
  }

  for (const t of fanoutConverging(graph, src, oi, line)) push(t);
  return out;
}


function fillDownstream(node, outIdx, type, graph, start, maxDepth = 6) {
  if (!start) return { ok: false, to: "" };

  const seen = new Set([node.id]);
  let frontier = [];
  if (!seen.has(start.id)) {
    seen.add(start.id);
    frontier.push(start);
  }

  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {





      const idx = (n.inputs ?? []).findIndex(
        (s) => isAutoPort(s) && sameType(s.type, type) && slotIsFree(s, true),
      );
      if (idx >= 0) {
        const l = safeConnect(node, outIdx, n, idx, null);
        if (l) return { ok: true, to: `${nodeName(n)}.${slotLabel(n, idx, true)}` };
      }

      for (const o of n.outputs ?? []) {
        for (const id of o?.links ?? []) {
          const l = getLink(graph, id);
          if (!l) continue;
          const t = graph.getNodeById(l.target_id);
          if (!t || seen.has(t.id)) continue;
          seen.add(t.id);
          next.push(t);
        }
      }
    }
    frontier = next;
  }

  return { ok: false, to: "" };
}


function spliceIntoExistingLines(node, graph, res) {
  const done = [];
  const seen = new Set([node.id]);


  const downs = [];
  for (const o of node.outputs ?? []) {
    for (const id of o?.links ?? []) {
      const l = getLink(graph, id);
      const t = l && graph.getNodeById(l.target_id);
      if (t && !seen.has(t.id)) {
        seen.add(t.id);
        downs.push(t);
      }
    }
  }

  for (const d of downs) {
    for (let si = 0; si < (d.inputs ?? []).length; si++) {
      const slot = d.inputs[si];
      const l = getLink(graph, slot?.link);

      if (!l || l.origin_id === node.id) continue;
      const src = graph.getNodeById(l.origin_id);
      if (!src) continue;

      const type = linkTypeOf(l);



      let inIdx = (node.inputs ?? []).findIndex(
        (s) => isAutoPort(s) && sameType(s.type, type) && slotIsFree(s, true),
      );
      let dropAt = -1;
      if (inIdx < 0) {
        const k = (res.pairs ?? []).findIndex(
          (p) => p.inIdx != null && sameType(node.inputs?.[p.inIdx]?.type, type),
        );
        if (k >= 0) {
          inIdx = res.pairs[k].inIdx;
          dropAt = k;
        }
      }
      if (inIdx < 0) continue;

      const outIdx = (node.outputs ?? []).findIndex(
        (s) => isAutoPort(s) && sameType(s.type, type) && slotIsFree(s, false),
      );
      if (outIdx < 0) continue;

      const backtrack = () => {
        safeConnect(src, l.origin_slot, d, si, l.parentId ?? null);
      };



      let dropped = null;
      if (dropAt >= 0) {
        const p = res.pairs[dropAt];
        const ps = graph.getNodeById(p?.srcId);
        if (ps && typeof p?.oi === "number") dropped = { node: ps, slot: p.oi, inIdx: p.inIdx, i: dropAt };
      }
      const restoreDropped = () => {
        if (dropped && safeConnect(dropped.node, dropped.slot, node, dropped.inIdx, null)) {
          res.pairs.splice(dropped.i, 0, {
            type: String(type),
            from: `${nodeName(dropped.node)}.${slotLabel(dropped.node, dropped.slot, false)}`,
            to: slotLabel(node, dropped.inIdx, true),
            inIdx: dropped.inIdx,
            srcId: dropped.node.id,
            oi: dropped.slot,
          });
          res.added++;
        }
      };


      try {
        d.disconnectInput(si);
      } catch (err) {
        /* ignore */
      }
      if (dropAt >= 0) {
        try {
          node.disconnectInput(inIdx);
        } catch (err) {
          /* ignore */
        }
        res.pairs.splice(dropAt, 1);
        res.added = Math.max(0, res.added - 1);
      }

      const a = safeConnect(src, l.origin_slot, node, inIdx, l.parentId ?? null);
      if (!a) {
        backtrack();
        restoreDropped();
        continue;
      }
      const b = safeConnect(node, outIdx, d, si, null);
      if (!b) {

        try {
          node.disconnectInput(inIdx);
        } catch (err) {
          /* ignore */
        }
        backtrack();
        restoreDropped();
        continue;
      }

      done.push({
        type: String(type),
        from: `${nodeName(src)}.${slotLabel(src, l.origin_slot, false)}`,
        to: `${nodeName(d)}.${slotLabel(d, si, true)}`,
        inName: slotLabel(node, inIdx, true),
        outName: slotLabel(node, outIdx, false),
      });
    }
  }

  res.spliced = done;
  return done;
}


function feedEmptyInputs(node, graph, opts = {}) {
  const res = { added: 0, pairs: [], rewired: 0, rewirePairs: [], spliced: [], left: [] };
  if (!node || !graph) return res;

  const sources = upstreamSources(node, graph, 6);
  if (!sources.length) return res;

  const MAX_ADD = 8;

  for (const src of sources) {
    if (res.added >= MAX_ADD) break;
    if (src === node) continue;
    if (isDownstreamOf(graph, src, node)) continue;

    const outs = src.outputs ?? [];
    for (let oi = 0; oi < outs.length; oi++) {
      if (res.added >= MAX_ADD) break;
      const out = outs[oi];
      if (!isAutoPort(out)) continue;


      const inIdx = (node.inputs ?? []).findIndex(
        (s) => isAutoPort(s) && sameType(s.type, out.type) && slotIsFree(s, true),
      );
      if (inIdx < 0) continue;





      const outsAll = node.outputs ?? [];
      let outIdx = outsAll.findIndex(
        (s) => isAutoPort(s) && sameType(s.type, out.type) && slotIsFree(s, false),
      );
      if (outIdx < 0) {
        outIdx = outsAll.findIndex((s) => isAutoPort(s) && sameType(s.type, out.type));
      }


      const already = (out.links ?? []).some((id) => {
        const l = getLink(graph, id);
        return l && l.target_id === node.id;
      });
      if (already) continue;

      const l1 = safeConnect(src, oi, node, inIdx, null);
      if (!l1) continue;

      res.added++;
      res.pairs.push({
        type: String(out.type),
        from: `${nodeName(src)}.${slotLabel(src, oi, false)}`,
        to: slotLabel(node, inIdx, true),
        inIdx,
        srcId: src.id,
        oi,
      });







      let rewired = 0;
      const taken = new Set();


      if (outIdx < 0) {
        res.left.push({
          type: String(out.type),
          why: "输入补上了，但新节点没有这个类型的出口，数据进来出不去",
        });
        continue;
      }


      const chain = lineBelow(graph, opts.target);



      const filled = fillDownstream(node, outIdx, out.type, graph, opts.target);
      if (filled.ok) {
        rewired++;
        res.rewired++;
        res.rewirePairs.push({ type: String(out.type), to: filled.to });
      }






      for (const t of downstreamCandidates(graph, node, opts.target, src, oi, chain)) {
        const ti = (t.inputs ?? []).findIndex((s, si) => {
          if (taken.has(`${t.id}:${si}`)) return false;
          const l = getLink(graph, s?.link);
          return (
            l &&
            l.origin_id === src.id &&
            l.origin_slot === oi &&
            sameType(s.type, out.type)
          );
        });
        if (ti < 0) continue;

        const back = { node: t, slot: ti };
        try {
          t.disconnectInput(ti);
        } catch (err) {
          /* ignore */
        }
        const l2 = safeConnect(node, outIdx, t, ti, null);
        if (l2) {
          rewired++;
          taken.add(`${t.id}:${ti}`);
          res.rewirePairs.push({
            type: String(out.type),
            to: `${nodeName(t)}.${slotLabel(t, ti, true)}`,
          });
        } else {

          safeConnect(src, oi, back.node, back.slot, null);
        }
      }
      res.rewired += rewired;

      if (!rewired) {
        res.left.push({
          type: String(out.type),
          why: "这条线往下没有能吃这个类型的口，数据到新节点就停在这里",
        });
      }
    }
  }




  try {
    spliceIntoExistingLines(node, graph, res);
  } catch (err) {
    console.warn(LOG, "串进已有连线时出错", err);
  }




  if (res.spliced?.length) {
    const filledTypes = new Set((res.spliced ?? []).map((p) => typeKeyOf(p.type)));
    res.left = (res.left ?? []).filter((p) => !filledTypes.has(typeKeyOf(p.type)));
  }

  return res;
}




function tryChainPass(nodes, type, state) {
  const { usedIn, usedOut } = state;
  const backup = new Map();
  const save = (m) => {
    for (const [k, v] of m) {
      if (!backup.has(m)) backup.set(m, new Map());
      backup.get(m).set(k, new Set(v));
    }
  };
  save(usedIn);
  save(usedOut);
  const restore = () => {
    for (const [m, snap] of backup) {
      m.clear();
      for (const [k, v] of snap) m.set(k, new Set(v));
    }
  };

  const steps = [];
  for (const nd of nodes) {
    const inIdx = pickSlot(nd, true, type, { used: getSet(usedIn, nd), onlyFree: true });
    if (inIdx < 0) {
      restore();
      return { ok: false, node: nd, why: "no-in" };
    }
    getSet(usedIn, nd).add(inIdx);

    const outIdx = pickSlot(nd, false, type, { used: getSet(usedOut, nd), onlyFree: true });
    if (outIdx < 0) {
      restore();
      return { ok: false, node: nd, why: "no-out" };
    }
    getSet(usedOut, nd).add(outIdx);
    steps.push({ node: nd, inIdx, outIdx });
  }
  return { ok: true, steps, exitOut: steps[steps.length - 1].outIdx };
}

function getSet(m, n) {
  if (!m.has(n.id)) m.set(n.id, new Set());
  return m.get(n.id);
}


function planChainExtras(chainNodes, primaryLink, exitLink, candidates) {
  const graph = app.graph;
  const nodes = (chainNodes ?? []).filter(Boolean);
  const items = [];
  const skipped = [];
  if (!graph || !nodes.length) return { items, skipped };

  const prim = linkParts(primaryLink);
  const exit = exitLink ? linkParts(exitLink) : null;
  const last = nodes[nodes.length - 1];
  if (!prim || !exit) return { items, skipped };


  const usedIn = new Map();
  const usedOut = new Map();
  const state = { usedIn, usedOut };
  for (const nd of nodes) {
    (nd.inputs ?? []).forEach((s, i) => {
      if (!slotIsFree(s, true)) getSet(usedIn, nd).add(i);
    });
    (nd.outputs ?? []).forEach((s, i) => {
      if (!slotIsFree(s, false)) getSet(usedOut, nd).add(i);
    });
  }


  const fedBy = new Map();
  fedBy.set(`${prim.origin_id}:${prim.origin_slot}`, exit.origin_slot);

  const seen = new Set([prim.id]);

  for (const raw of candidates ?? []) {
    const l = linkParts(raw);
    if (!l || l.id === undefined || l.id === null) continue;
    if (seen.has(l.id)) continue;
    seen.add(l.id);


    const live = getLink(graph, l.id);
    if (!live) continue;

    const origin = graph.getNodeById(l.origin_id);
    const target = graph.getNodeById(l.target_id);
    if (!origin || !target) continue;
    if (nodes.includes(target) || nodes.includes(origin)) continue;

    const type = linkTypeOf(l);
    const key = `${l.origin_id}:${l.origin_slot}`;
    const from = `${nodeName(origin)}.${slotLabel(origin, l.origin_slot, false)}`;
    const to = `${nodeName(target)}.${slotLabel(target, l.target_slot, true)}`;


    if (fedBy.has(key)) {
      items.push({
        kind: "reuse",
        link: l,
        outIdx: fedBy.get(key),
        last,
        type,
        from,
        to,
      });
      continue;
    }


    const pass = tryChainPass(nodes, type, state);
    if (pass.ok) {
      fedBy.set(key, pass.exitOut);
      items.push({ kind: "pass", link: l, steps: pass.steps, type, from, to });
    } else {
      skipped.push({ link: l, type, node: pass.node, why: pass.why, from, to });
    }
  }

  return { items, skipped };
}


function applyChainExtras(items) {
  const graph = app.graph;
  if (!items?.length) return 0;
  let ok = 0;

  beginChange();
  try {
    for (const it of items) {
      try {
        if (it.kind === "reuse") {
          const l = linkParts(it.link);
          const target = graph.getNodeById(l.target_id);
          const origin = graph.getNodeById(l.origin_id);
          if (!target || !it.last) continue;
          try {
            if (typeof graph.removeLink === "function") graph.removeLink(l.id);
            else target.disconnectInput(l.target_slot);
          } catch (err) {
            /* ignore */
          }
          const nl = safeConnect(it.last, it.outIdx, target, l.target_slot, null);
          if (nl) ok++;
          else if (origin) safeConnect(origin, l.origin_slot, target, l.target_slot, null);
          continue;
        }


        let cur = linkParts(getLink(graph, it.link.id) ?? it.link);
        if (!cur) continue;
        let good = true;

        for (const st of it.steps) {
          if (!rerouteThroughNode(st.node, { link: cur, inIdx: st.inIdx, outIdx: st.outIdx })) {
            good = false;
            break;
          }
          const next = findOutLink(st.node, st.outIdx, cur.target_id, cur.target_slot);
          if (!next) {
            good = false;
            break;
          }
          cur = linkParts(next);
        }
        if (good) ok++;
      } catch (err) {
        console.warn(LOG, "串联补线出错", err);
      }
    }
  } finally {
    endChange();
  }

  graph?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
  return ok;
}


function findOutLink(node, outIdx, targetId, targetSlot) {
  const graph = app.graph;
  for (const id of node?.outputs?.[outIdx]?.links ?? []) {
    const l = linkParts(getLink(graph, id));
    if (l && l.target_id === targetId && l.target_slot === targetSlot) return l;
  }
  return null;
}



const ASK_ID = "nri-ask";
let askBar = null; // { root, onKey, onOutside }

function closeAsk() {
  if (!askBar) return;
  const { root, onKey, onOutside } = askBar;
  askBar = null;
  try {
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
  } catch (err) {
    /* ignore */
  }
  try {
    root?.remove();
  } catch (err) {
    /* ignore */
  }
}


function askConnectExtras(node, items, opts = {}) {
  if (!items?.length) return;
  closeAsk();
  ensureStyle();

  const apply = typeof opts.apply === "function" ? opts.apply : (its) => applyExtras(node, its);
  const avoidText = opts.avoidText ?? escapeHtml(nodeName(node));

  const rows = items
    .map(
      (it) => `
      <div class="nri-ask-row">
        <span class="nri-tag">${escapeHtml(it.type)}</span>
        <span class="nri-path">${escapeHtml(it.from)} <span class="nri-arrow">→</span> ${escapeHtml(it.to)}</span>
      </div>`
    )
    .join("");


  const head = tr(`还有 ${items.length} 条线可以顺路穿过去`);
  const sub = tr(`接上之后这几条线会多绕一道 ${avoidText}，原来的图不会断。`);
  const keyBtn = (label, key, act, cls = "") =>
    `<button type="button" class="nri-btn${cls}" data-act="${act}">${tr(label).replace(
      key,
      `<span class="nri-key">${key}</span>`
    )}</button>`;

  const root = document.createElement("div");
  root.id = ASK_ID;
  root.innerHTML = `
    <div class="nri-ask-head">${head}</div>
    <div class="nri-ask-sub">${sub}</div>
    <div class="nri-ask-list">${rows}</div>
    <div class="nri-ask-btns">
      ${keyBtn("不用（Esc）", "Esc", "no")}
      ${keyBtn("一起接上（Enter）", "Enter", "yes", " pri")}
    </div>
  `;
  document.body.appendChild(root);

  const done = (yes) => {
    closeAsk();
    if (!yes) return;
    const ok = apply(items);
    if (ok === items.length) {
      toast("success", `已一起接上 ${ok} 条线`, `${items.map((i) => i.from).join("、")}`, 5000);
    } else {
      toast(
        "warn",
        `接上了 ${ok} / ${items.length} 条`,
        "剩下那几条先按原样留着，需要的话手动补一下。",
        8000
      );
    }
  };

  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      done(false);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      done(true);
    }
  };
  const onOutside = (ev) => {
    if (root.contains(ev.target)) return;
    done(false);
  };

  root.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  root.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.("button[data-act]");
    if (!btn) return;
    done(btn.dataset.act === "yes");
  });

  window.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onOutside, true);
  askBar = { root, onKey, onOutside };
}




function separateCore(node) {
  const graph = app.graph;
  const res = { ok: false, made: 0, failed: 0, total: 0, lines: [] };
  if (!graph || !node) return res;


  const inLinks = [];
  const outLinks = [];

  (node.inputs ?? []).forEach((s, i) => {
    const id = s?.link;
    if (id === null || id === undefined) return;
    const l = getLink(graph, id);
    if (l) inLinks.push({ slot: i, link: linkParts(l), type: linkTypeOf(l) });
  });
  (node.outputs ?? []).forEach((s, i) => {
    for (const id of s?.links ?? []) {
      const l = getLink(graph, id);
      if (l) outLinks.push({ slot: i, link: linkParts(l), type: linkTypeOf(l) });
    }
  });

  res.total = inLinks.length + outLinks.length;
  if (!res.total) {
    res.why = "empty";
    return res;
  }



  const used = [];
  const pairs = [];
  const unmatched = [];

  for (const out of outLinks) {
    const target = graph.getNodeById(out.link.target_id);
    if (!target) continue;


    const usable = (x) => compatible(out.type, x.type) && !!graph.getNodeById(x.link.origin_id);

    let src = inLinks.find((x) => !used.includes(x) && usable(x));
    if (!src) src = used.find((x) => usable(x));
    if (!src) {
      unmatched.push({ out, target });
      continue;
    }
    if (!used.includes(src)) used.push(src);
    pairs.push({ src, sink: out, target });
  }

  if (unmatched.length) {
    res.why = "unmatched";
    res.detail = unmatched
      .map((u) => `${slotLabel(node, u.out.slot, false)} → ${nodeName(u.target)}`)
      .join("、");
    return res;
  }


  const allLinks = [...inLinks.map((x) => x.link), ...outLinks.map((x) => x.link)];

  for (const l of allLinks) {
    try {
      if (typeof graph.removeLink === "function") graph.removeLink(l.id);
      else graph.getNodeById(l.target_id)?.disconnectInput(l.target_slot);
    } catch (err) {
      console.warn(LOG, "分离时断线失败", err);
    }
  }

  for (const p of pairs) {
    const origin = graph.getNodeById(p.src.link.origin_id);
    if (!origin) {
      res.failed++;
      continue;
    }

    const l = safeConnect(origin, p.src.link.origin_slot, p.target, p.sink.link.target_slot, null);
    if (l) {
      res.made++;
      res.lines.push(
        `${p.src.type}  ${nodeTag(origin)}.out[${p.src.link.origin_slot}] → ${nodeTag(p.target)}.in[${p.sink.link.target_slot}]`,
      );
    } else {
      res.failed++;
    }
  }




  node.setDirtyCanvas?.(true, true);
  graph.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);

  res.ok = true;
  return res;
}


function separateNode(node) {
  if (!node) return false;

  const around = aroundNodes(node, app.graph);
  const beforeText = dumpText(around, app.graph);

  const res = separateCore(node);
  if (!res.ok) {
    if (res.why === "empty") {
      toast("warn", `${nodeName(node)} 本来就是独立的`, "它身上没有任何连线。", 5000);
    } else if (res.why === "unmatched") {
      toast(
        "error",
        `${nodeName(node)} 没法干净地分离`,
        `${res.detail} 找不到同类型的上游接回去，拆掉会断线，所以这次没动。`,
        9000
      );
    }
    return false;
  }

  commitUndo();

  try {
    app.canvas?.selectNode?.(node, false);
  } catch (err) {
    /* ignore */
  }

  if (res.failed) {
    toast(
      "warn",
      `${nodeName(node)} 已分离，但有 ${res.failed} 条没接回去`,
      "那几条的下游现在是断的，麻烦手动补一下。",
      9000
    );
  } else if (res.made) {
    toast(
      "success",
      `已把 ${nodeName(node)} 从连线中分离`,
      `${res.made} 条线直连回去了，节点留在画布上`,
      4500
    );
  } else {
    toast("success", `已把 ${nodeName(node)} 摘下来`, `${res.total} 条线已断开，节点还在画布上。`, 4500);
  }

  console.log(LOG, "分离完成", { node: nodeName(node), bridged: res.made, failed: res.failed });

  const sec = [
    `分离：${nodeTag(node)}　断开 ${res.total} 条 · 直连回去 ${res.made} 条 · 失败 ${res.failed} 条`,
    "",
  ];
  if (res.lines.length) {
    sec.push("【直连回去的线】");
    for (const s of res.lines) sec.push(`  ${s}`);
    sec.push("");
  }
  sec.push("【分离前】", beforeText, "");
  sec.push("【分离后】", dumpText(around, app.graph));
  publishReport("分离", `${nodeName(node)} 从连线中摘出`, sec);

  return true;
}


function separateNodes(nodes) {
  const list = (nodes ?? []).filter(Boolean);
  if (!list.length) return false;
  if (list.length === 1) return separateNode(list[0]);

  const doneList = [];
  const skipped = [];

  beginChange();
  try {
    for (const n of list) {
      const res = separateCore(n);
      if (res.ok) doneList.push({ node: n, res });
      else skipped.push({ node: n, res });
    }
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
  } finally {
    endChange();
  }

  if (!doneList.length) {
    const first = skipped[0];
    if (first?.res.why === "unmatched") {
      toast("error", "一个都没分离", `${nodeName(first.node)} 的 ${first.res.detail} 找不到同类型上游。`, 9000);
    } else {
      toast("warn", "这些节点都没有连线", "选中的节点本来就是独立的。", 6000);
    }
    return false;
  }

  const bridged = doneList.reduce((a, x) => a + x.res.made, 0);
  const bad = doneList.reduce((a, x) => a + x.res.failed, 0);
  const bits = [`${doneList.length} 个节点已摘下`, `${bridged} 条线直连回去`];
  if (bad) bits.push(`${bad} 条没接回`);
  if (skipped.length) bits.push(`${skipped.length} 个跳过（${skipped[0].res.why === "empty" ? "本来就没线" : "接不回去"}）`);

  toast(bad || skipped.length ? "warn" : "success", `已分离 ${doneList.length} 个节点`, bits.join("　·　"), 6000);

  console.log(LOG, "批量分离完成", {
    done: doneList.map((x) => nodeName(x.node)),
    skipped: skipped.map((x) => nodeName(x.node)),
    bridged,
    bad,
  });
  return true;
}



let highlighted = null;

function setLinkHighlight(link) {
  const cnv = app.canvas;
  if (!cnv) return;
  const id = link ? link.id : null;
  if (highlighted === id) return;
  highlighted = id;
  try {
    cnv.highlighted_links = id === null ? {} : { [id]: true };
    cnv.setDirty?.(true, true);
  } catch (err) {
    /* ignore */
  }
}



const BAR_ID = "nri-armed-bar";
const STYLE_ID = "nri-style";

const CSS = `
#nri-armed-bar {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 99999;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid #22c55e;
  background: var(--comfy-menu-bg, #1f1f23);
  color: var(--input-text, #eaeaea);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
  box-shadow: 0 8px 26px rgba(0,0,0,0.45), 0 0 0 3px rgba(34,197,94,0.14);
  pointer-events: none;
  user-select: none;
  animation: nri-in 0.14s ease-out;
}
@keyframes nri-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
#nri-armed-bar .nri-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 0 rgba(34,197,94,0.7);
  animation: nri-pulse 1.1s infinite;
  flex: none;
}
@keyframes nri-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.65); }
  70%  { box-shadow: 0 0 0 7px rgba(34,197,94,0); }
  100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
}
#nri-armed-bar .nri-msg { font-size: 13px; font-weight: 600; }
#nri-armed-bar .nri-body { display: flex; flex-direction: column; gap: 3px; }
#nri-armed-bar .nri-sub {
  font-size: 11px;
  opacity: 0.62;
  max-width: 56vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#nri-armed-bar .nri-key {
  display: inline-block;
  padding: 0 4px;
  margin: 0 1px;
  border: 1px solid rgba(140,140,140,0.45);
  border-radius: 3px;
  font-size: 10px;
  line-height: 14px;
}


/* ---------- confirm bar ---------- */
#nri-ask {
  position: fixed;
  left: 50%;
  bottom: 34px;
  transform: translateX(-50%);
  z-index: 100001;
  width: 400px;
  max-width: 88vw;
  border-radius: 10px;
  border: 1px solid rgba(34,197,94,0.55);
  background: var(--comfy-menu-bg, #202024);
  color: var(--input-text, #eaeaea);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
  box-shadow: 0 14px 38px rgba(0,0,0,0.5);
  overflow: hidden;
  animation: nri-in3 0.14s ease-out;
}
@keyframes nri-in3 {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
#nri-ask .nri-ask-head {
  padding: 10px 13px 4px;
  font-size: 13px;
  font-weight: 600;
  color: #4ade80;
}
#nri-ask .nri-ask-sub {
  padding: 0 13px 8px;
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.62;
}
#nri-ask .nri-ask-list {
  max-height: 26vh;
  overflow-y: auto;
  padding: 2px 13px 9px;
  border-top: 1px solid rgba(140,140,140,0.16);
}
#nri-ask .nri-ask-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 0;
  font-size: 11.5px;
}
#nri-ask .nri-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(34,197,94,0.16);
  border: 1px solid rgba(34,197,94,0.3);
  color: #4ade80;
  font-size: 10px;
  letter-spacing: 0.2px;
}
#nri-ask .nri-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.9;
}
#nri-ask .nri-arrow { opacity: 0.5; margin: 0 2px; }
#nri-ask .nri-ask-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 9px 13px;
  border-top: 1px solid rgba(140,140,140,0.22);
}
#nri-ask .nri-btn {
  padding: 5px 11px;
  border-radius: 6px;
  border: 1px solid rgba(140,140,140,0.4);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
#nri-ask .nri-btn:hover { background: rgba(255,255,255,0.08); }
#nri-ask .nri-btn.pri {
  border-color: transparent;
  background: #22c55e;
  color: #06240f;
  font-weight: 600;
}
#nri-ask .nri-btn.pri:hover { background: #34d86c; }
#nri-ask .nri-key {
  display: inline-block;
  padding: 0 3px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 9.5px;
  line-height: 13px;
  opacity: 0.7;
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}



let armed = null; // { nodes, el, onDown, onMove, onKey }

function showArmedBar(nodes) {
  document.getElementById(BAR_ID)?.remove();
  ensureStyle();

  const list = nodes ?? [];
  const many = list.length > 1;
  const names = list.map((n) => nodeName(n)).join(" → ");

  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.innerHTML = `
    <span class="nri-dot"></span>
    <div class="nri-body">
      <div class="nri-msg">${tr("左键点一下要插入的那条线")}</div>
      <div class="nri-sub">
        ${tr(many ? "串联插入：" : "插入：")}${escapeHtml(names)}${many ? tr("　·　兄弟线会整组一起串") : ""}　·　${tr("取消：")}<span class="nri-key">Esc</span> / ${tr("右键 / 点空白")}
      </div>
    </div>
  `;
  document.body.appendChild(bar);
}

function disarm() {
  if (!armed) return;
  const { el, onDown, onMove, onKey } = armed;
  armed = null;

  try {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("keydown", onKey, true);
  } catch (err) {
    /* ignore */
  }
  try {
    if (el) el.style.cursor = "";
  } catch (err) {
    /* ignore */
  }

  setLinkHighlight(null);
  document.getElementById(BAR_ID)?.remove();
  app.canvas?.setDirty?.(true, true);
}

function arm(nodes) {
  disarm();

  const list = (nodes ?? []).filter(Boolean);
  if (!list.length) {
    toast("info", "先选中要插入的节点", "选中后再右键它。", 5000);
    return;
  }

  const el = canvasElement();
  if (!el) {
    toast("error", "找不到画布", "无法进入插入模式。");
    return;
  }

  const cnv = app.canvas;
  const tolOf = () => {
    const scale = cnv?.ds?.scale || 1;
    return Math.max(5, 13 / scale);
  };


  let raf = 0;
  const onMove = (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!armed) return;
      const g = eventToGraph(e);
      if (!g) return;
      setLinkHighlight(findLinkAt(g.x, g.y, tolOf()));
    });
  };

  const onDown = (e) => {
    const g = eventToGraph(e);


    if (!g || (e.target !== g.el && !g.el.contains?.(e.target))) return;

    if (e.button === 2) {
      e.preventDefault();
      e.stopPropagation();
      disarm();
      return;
    }
    if (e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    const link = findLinkAt(g.x, g.y, tolOf());
    if (!link) {


      const hitNode = nodeAt(app.graph, g.x, g.y);
      const near = nearestLinkInfo(g.x, g.y);
      const hint = near
        ? `最近的线还差 ${near.dist}px（${near.link}）`
        : "画布上没有可插入的线";
      console.warn(LOG, "这次没点中线条", {
        点: [Math.round(g.x), Math.round(g.y)],
        容差: Math.round(tolOf() * 10) / 10,
        缩放: g.scale,
        鼠标下面是: hitNode ? nodeName(hitNode) : "空白",
        最近: near,
      });
      if (hitNode) {
        toast("info", "这里不是线", `${hint}。点在线上，或点下游节点的输入口。`, 4200);
        return;
      }
      toast("info", "已退出插入", hint, 3600);
      disarm();
      return;
    }

    const targets = armed?.nodes ?? [];
    disarm();
    if (!targets.length) return;

    if (targets.length === 1) {
      insertNodeIntoLink(targets[0], link, { gx: g.x, gy: g.y });
      return;
    }



    const primSnap = { ...linkParts(link) };
    const primEnds = [
      app.graph.getNodeById(primSnap.origin_id),
      app.graph.getNodeById(primSnap.target_id),
    ];
    const beforeText = dumpText([...primEnds, ...targets], app.graph);
    const collected = [];
    const placed = [];
    let curLink = link;
    let exitLink = null;
    let done = 0;
    let autoSiblings = 0;
    let failedAt = null;


    beginChange();
    try {
      for (const n of targets) {
        lastInsertOutLinkId = null;
        lastInsertAutoCount = 0;
        const ok = insertNodeIntoLink(n, curLink, {
          gx: g.x,
          gy: g.y,
          silent: true,
          placeFrom: placed[placed.length - 1] ?? null,
          collect: collected,
        });
        if (!ok) {
          failedAt = n;
          break;
        }
        done++;
        placed.push(n);
        autoSiblings += lastInsertAutoCount;

        const next = lastInsertOutLinkId != null ? getLink(app.graph, lastInsertOutLinkId) : null;
        if (!next) break;
        curLink = next;
        exitLink = linkParts(next);
      }
    } finally {
      endChange();
    }

    if (!done) return;


    const plan = planChainExtras(placed, primSnap, exitLink, collected);

    const bits = [];
    if (autoSiblings) bits.push(`顺路接上 ${autoSiblings} 条线`);
    if (plan.items.length) bits.push(`另有 ${plan.items.length} 条兄弟线等你确认`);
    if (plan.skipped.length) bits.push(`${plan.skipped.length} 条没槽位 / 类型对不上，没接`);
    if (failedAt) bits.push(`${nodeName(failedAt)} 和后面那些留在原位`);

    const sec = [
      `主线：${nodeTag(primEnds[0])}.out[${primSnap.origin_slot}] → ${nodeTag(primEnds[1])}.in[${primSnap.target_slot}]`,
      `串联：${placed.map((n) => nodeTag(n)).join(" → ")}`,
      `结果：串进 ${done} / ${targets.length} · 顺路 ${autoSiblings} 条 · 待确认 ${plan.items.length} · 跳过 ${plan.skipped.length}`
        + (failedAt ? ` · 卡在 ${nodeTag(failedAt)}` : ""),
      "",
    ];
    if (plan.items.length) {
      sec.push("【等你确认的兄弟线】");
      for (const it of plan.items) sec.push(`  ${it.type}  ${it.from} → ${it.to}`);
      sec.push("");
    }
    if (plan.skipped.length) {
      sec.push("【跳过：新节点没有对应的空口】");
      for (const it of plan.skipped) {
        sec.push(`  ${it.type ?? "?"}  ${it.from ?? "?"} → ${it.to ?? "?"}`);
      }
      sec.push("");
    }
    sec.push("【插入前】", beforeText, "");
    sec.push("【插入后】", dumpText([...primEnds, ...placed], app.graph));
    const copied = publishReport(
      "串联插入",
      `${done} 个节点串进 ${nodeName(primEnds[0])} → ${nodeName(primEnds[1])}`,
      sec,
    );

    toast(
      failedAt ? "warn" : "success",
      failedAt ? `串联插入到 ${done} / ${targets.length} 个` : `已串联插入 ${done} 个节点`,
      [
        bits.join("　·　") || "已经串进这条线。",
        copied ? "连线报告已复制到剪贴板" : "连线报告已写入控制台（F12）",
      ].join("　·　"),
      failedAt ? 9000 : 6000
    );

    if (plan.items.length) {
      const avoid = placed.map((n) => `「${nodeName(n)}」`).join(" → ");
      setTimeout(
        () =>
          askConnectExtras(placed[placed.length - 1], plan.items, {
            apply: applyChainExtras,
            avoidText: escapeHtml(avoid),
          }),
        80
      );
    }

    console.log(LOG, "串联插入完成", {
      nodes: placed.map((n) => nodeName(n)),
      autoSiblings,
      pending: plan.items.length,
      skipped: plan.skipped.length,
      failedAt: failedAt ? nodeName(failedAt) : null,
    });
  };

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      disarm();
    }
  };

  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("keydown", onKey, true);
  try {
    el.style.cursor = "crosshair";
  } catch (err) {
    /* ignore */
  }

  armed = { nodes: list, el, onDown, onMove, onKey };
  showArmedBar(list);
}


let newMenuApiUsed = false;


const MENU_I18N = {
  zh: { insert: "插入到连线", sep: "从连线中分离", cut: "断开连线" },
  en: { insert: "Insert into link", sep: "Detach from link", cut: "Disconnect link" },
};

function menuLang() {
  let v = "";
  try {
    v = app?.ui?.settings?.getSettingValue?.("Comfy.Locale") || "";
  } catch (err) {
    v = "";
  }
  if (!v) {
    try {
      v = document?.documentElement?.lang || "";
    } catch (err) {
      v = "";
    }
  }
  if (!v) {
    try {
      v = navigator?.language || "";
    } catch (err) {
      v = "";
    }
  }
  return String(v).toLowerCase().startsWith("zh") ? "zh" : "en";
}

function menuText() {
  return MENU_I18N[menuLang()].insert;
}

function sepText() {
  return MENU_I18N[menuLang()].sep;
}

function cutText() {
  return MENU_I18N[menuLang()].cut;
}


const EN_TEXT = {

  "左键点一下要插入的那条线": "Left-click the link to insert into",
  "左键点另一个节点，立即替换": "Left-click another node to replace it",
  "插入：": "Insert: ",
  "串联插入：": "Chained insert: ",
  "已选：": "Selected: ",
  "取消：": "Cancel: ",
  "右键 / 点空白": "right-click / click empty canvas",
  "　·　兄弟线会整组一起串": "　·　sibling links are chained as a group",
  "　·　多个节点将按从左到右串成一条链": "　·　multiple nodes are chained left to right",


  "选中后再右键它。": "Select it, then right-click.",
  "连线报告已复制到剪贴板": "Wiring report copied to clipboard",
  "连线报告已写入控制台（F12）": "Wiring report printed to the console (F12)",
  "找不到画布": "Canvas not found",
  "图没有改动。": "Graph unchanged.",


  "这条线已经不在了": "This link no longer exists",
  "断开连线失败": "Disconnect failed",
  "详情见控制台（F12）。": "See the console (F12) for details.",
  "断开连线": "Disconnect link",


  "先选中要插入的节点": "Select the node to insert first",
  "无法进入插入模式。": "Cannot enter insert mode.",
  "这条线接不到两端节点": "This link does not reach both of its nodes",
  "可能指向子图的输入 / 输出，或连线已经失效，暂不支持插入。":
    "It may point at a subgraph port, or the link is stale. Inserting is not supported here.",
  "不能插在自己所在的那条线上": "Cannot insert into a link that touches this node",
  "换一个节点或者换一条线。": "Pick another node, or another link.",
  "上游没接上，已还原原来的连线": "Upstream failed — the original link was restored",
  "这条线的类型可能不被这个节点接受。": "This node may not accept this link type.",
  "下游没接上": "Downstream not connected",
  "为了不破坏别的连线，这次没有插入。": "Nothing was inserted, to keep other links intact.",
  "插入失败": "Insert failed",
  "这里不是线": "This is not a link",
  "点在线上，或点下游节点的输入口。": "Click a link, or a downstream node's input.",
  "已退出插入": "Insert cancelled",
  "已经串进这条线。": "Chained into this link.",
  "剩下那几条先按原样留着，需要的话手动补一下。":
    "The rest were left as they were — patch them by hand if needed.",


  "先选中要分离的节点": "Select the node to detach first",
  "它身上没有任何连线。": "It has no links at all.",
  "这些节点都没有连线": "None of these nodes has links",
  "选中的节点本来就是独立的。": "The selected nodes are already standalone.",
  "一个都没分离": "Nothing was detached",
  "那几条的下游现在是断的，麻烦手动补一下。":
    "Their downstream is disconnected now — please patch them by hand.",


  "先选中要被替换的节点": "Select the node to be replaced first",
  "无法进入替换模式。": "Cannot enter replace mode.",
  "不能自己替换自己": "A node cannot replace itself",
  "请选中另外两个节点。": "Select two different nodes.",
  "不能自己换自己": "A node cannot be swapped with itself",
  "请选两个不同的节点。": "Pick two different nodes.",
  "只互换了位置": "Only the positions were swapped",
  "替换完成，但部分连线没接上": "Replaced, but some links were not connected",
  "替换失败": "Replace failed",
  "串联完成，但部分连线没接上": "Chained, but some links were not connected",
  "串联替换失败": "Chain replace failed",
  "这批节点都没连线": "None of these nodes has links",
  "没有线可以接管。要么点一个有连线的节点让它串成链，要么先框选要换掉的那批（它们得是有连线的）。":
    "There are no links to take over. Click a node that has links so the chain forms there, or select the nodes to replace first (they must have links).",
  "没有线可以接管": "No links to take over",
  "这批节点没有对外的连线": "These nodes have no links to the outside",
  "它们只和彼此连着，合并后没有线可接。图没有改动。":
    "They only connect to each other, so there is nothing to reconnect after merging. Graph unchanged.",
  "合并完成，但部分连线没接上": "Merged, but some links were not connected",
  "合并替换失败": "Merge replace failed",
  "这两个节点不是一前一后": "These two nodes are not in a single chain",
  "这两个节点都没有连线": "Neither node has links",
  "没有上下游可以对调，只换了位置也没什么意义。图没有改动。":
    "There is nothing upstream or downstream to swap — moving them would achieve nothing. Graph unchanged.",
  "口子对不上，没有可以对调的线": "Ports do not match — nothing to swap",
  "顺序换了，但有线没接上": "Order swapped, but some links were not connected",
  "顺序已对调": "Order swapped",
  "交换顺序失败": "Swap failed",
  "批量替换未全部成功": "Batch replace did not fully succeed",
  "其余为克隆副本，参数与原型一致": "The rest are clones with identical settings",


  "【插入前】": "【Before insert】",
  "【插入后】": "【After insert】",
  "【分离前】": "【Before detach】",
  "【分离后】": "【After detach】",
  "【替换前】": "【Before replace】",
  "【替换后】": "【After replace】",
  "【交换前】": "【Before swap】",
  "【交换后】": "【After swap】",
  "【顺路一起接上】": "【Also connected】",
  "【往上找料补的空口】": "【Empty ports filled from upstream】",
  "【改接到新节点后面的下游】": "【Downstream rerouted to the new node】",
  "【没能接出去】": "【Could not be connected】",
  "【新节点仍然空着的口】": "【Ports still empty on the new node】",
  "【跳过：新节点没有对应的空口】": "【Skipped: no matching port on the new node】",
  "【等你确认的兄弟线】": "【Sibling links awaiting confirmation】",
  "【直连回去的线】": "【Links reconnected directly】",


  "插入": "Insert",
  "串联插入": "Chained insert",
  "分离": "Detach",
  "替换": "Replace",
  "合并替换": "Merge replace",
  "交换顺序": "Swap order",
  "无": "none",
  "(节点不存在)": "(node not found)",


  "不用（Esc）": "No (Esc)",
  "一起接上（Enter）": "Connect them (Enter)",
  "第一项": "first option",
  "取消": "cancel",
  "两个节点都有连线，往哪边接？": "Both nodes have links — which way?",
  "用「{B}」替换「{A}」": "Replace 「{A}」 with 「{B}」",
  "用「{A}」替换「{B}」": "Replace 「{B}」 with 「{A}」",
  "{A}（{NA} 根线）全交给 {B}（{NB} 根线），{A} 留在画布上":
    "{A} ({NA} links) hands everything to {B} ({NB} links); {A} stays on the canvas",
  "{B}（{NB} 根线）全交给 {A}（{NA} 根线），{B} 留在画布上":
    "{B} ({NB} links) hands everything to {A} ({NA} links); {B} stays on the canvas",
  "选中的 {N} 个节点，怎么换？": "Selected {N} nodes — how to replace them?",
  "合并成一个 · 用「{X}」顶掉这 {N} 个": "Merge into one · 「{X}」 replaces all {N}",
  "分别替换 · 每个都换成同款": "Replace separately · each becomes its own copy",
};

const EN_RULES = [

  [/^已插入 (.+)$/, "Inserted $1"],
  [/^已断开 (.+)$/, "Disconnected $1"],
  [/^已一起接上 1 条线$/, "Connected 1 link"],
  [/^已一起接上 (\d+) 条线$/, "Connected $1 links"],
  [/^接上了 (\d+) \/ (\d+) 条$/, "Connected $1 / $2 links"],
  [/^已串联插入 (\d+) 个节点$/, "Inserted $1 nodes as a chain"],
  [/^串联插入到 (\d+) \/ (\d+) 个$/, "Chained $1 / $2 nodes"],
  [/^(.+) 接不上这条线的上游$/, "$1 has no port for the upstream side"],
  [/^(.+) 接不上这条线的下游$/, "$1 has no port for the downstream side"],
  [/^(.+) 的类型对不上这条线$/, "$1 has no matching port type for this link"],
  [/^(.+) 的 (.+) 位已经被占用$/, "Port $2 of $1 is already in use"],
  [/^它没有能接收 (.+) 类型的输入位。$/, "It has no input port that accepts $1."],
  [/^它没有能输出 (.+) 类型的输出位。$/, "It has no output port that provides $1."],
  [/^已把 (.+) 接到 (.+)，剩下的请手动补一根线。$/, "Connected $1 to $2 — wire the rest by hand."],


  [/^已把 (.+) 从连线中分离$/, "Detached $1"],
  [/^已把 (.+) 摘下来$/, "Detached $1"],
  [/^已分离 (\d+) 个节点$/, "Detached $1 nodes"],
  [/^(\d+) 个节点已摘下$/, "$1 nodes detached"],
  [/^(\d+) 条线直连回去$/, "$1 links reconnected"],
  [/^(\d+) 条没接回$/, "$1 not reconnected"],
  [/^(\d+) 个跳过（本来就没线）$/, "$1 skipped (no links)"],
  [/^(\d+) 个跳过（接不回去）$/, "$1 skipped (cannot reconnect)"],
  [/^(.+) 本来就是独立的$/, "$1 is already standalone"],
  [/^(.+) 已分离，但有 (\d+) 条没接回去$/, "$1 detached, but $2 links were not reconnected"],
  [/^(.+) 没法干净地分离$/, "$1 cannot be detached cleanly"],
  [/^(.+) 找不到同类型的上游接回去，拆掉会断线，所以这次没动。$/,
    "No matching upstream for $1 — detaching would break the chain, so nothing was changed."],
  [/^(\d+) 条线直连回去了，节点留在画布上$/, "$1 links reconnected directly; the node stays on the canvas"],
  [/^(\d+) 条线已断开，节点还在画布上。$/, "$1 links removed; the node stays on the canvas."],
  [/^(.+) 的 (.+) 找不到同类型上游。$/, "No matching upstream for $2 of $1."],


  [/^已用 (.+) 替换$/, "Replaced with $1"],
  [/^已替换 (\d+) 个节点$/, "Replaced $1 nodes"],
  [/^已用 1 个节点合并顶替 (\d+) 个$/, "Merged $1 nodes into one"],
  [/^已把 (\d+) 个节点串成一条链，顶替 (.+)$/, "Chained $1 nodes, replacing $2"],
  [/^已串成 (\d+) 个节点的链，但有 (\d+) 类线没接$/, "Chained $1 nodes, but $2 link types were left unconnected"],
  [/^没接上 (\d+) 条$/, "$1 not connected"],
  [/^补连 (\d+) 条空口（(.+)）$/, "Filled $1 empty ports ($2)"],
  [/^断开(?:了)? (\d+) 条没下游的悬空线（(.+)）$/, "Removed $1 dangling links ($2)"],
  [/^(\d+) 处为近似匹配，请复核$/, "$1 approximate matches — please double-check"],
  [/^整类留在旧节点：(.+)$/, "Left on the old node: $1"],
  [/^跨过：(.+)$/, "Bypassed: $1"],
  [/^成功 (\d+) 个，失败 (\d+) 个$/, "$1 succeeded, $2 failed"],
  [/^(.+) 和 (.+) 之间没有上下游通路，交换顺序没有意义。图没有改动。$/,
    "$1 and $2 have no path between them; swapping would mean nothing. Graph unchanged."],
  [/^(.+) 身上没有连线。$/, "$1 has no links."],


  [/^覆盖了替换者原有 (\d+) 条输入线$/, "Overwrote $1 input links of the replacement"],
  [/^(.+) 改成了上游直连下游（旧节点不在这条线上了）$/,
    "$1 now runs straight from upstream to downstream (the old node is off this link)"],
  [/^没动的：(.+)$/, "Left untouched: $1"],
  [/^下游补连 (\d+) 条（(.+)）$/, "Filled $1 downstream ports ($2)"],
  [/^改接 (\d+) 条到新节点（(.+)，原先直接绕过它的）$/,
    "Rerouted $1 links to the new node ($2, they used to bypass it)"],
  [/^(.+) 出口还没接下游，要手动接$/, "$1 outputs have no downstream — connect them by hand"],
  [/^旧节点已保留，位置互换完成$/, "Old node kept, positions swapped"],
  [/^两边都没有连线，只互换了位置$/, "Neither had links — only the positions were swapped"],
  [/^补连 (\d+) 条（(.+)）$/, "Filled $1 ports ($2)"],
  [/^留在原节点：(.+)$/, "Left on the old node: $1"],
  [/^没能摆正：(.+)$/, "Not rearranged: $1"],
  [/^对调 (\d+) 类（(.+)）：上游 (\d+) 条$/, "Swapped $1 link types ($2): $3 upstream"],
  [/^下游 (\d+) 条$/, "$1 downstream"],
  [/^顺路接上 (\d+) 条线$/, "Also connected $1 links along the way"],
  [/^另有 (\d+) 条兄弟线等你确认$/, "$1 sibling links waiting for your confirmation"],
  [/^另有 (\d+) 条等你确认$/, "$1 more waiting for your confirmation"],
  [/^(\d+) 条接不上$/, "$1 could not be connected"],
  [/^补上 (\d+) 个空口（(.+)）$/, "Filled $1 empty ports ($2)"],
  [/^改接 (\d+) 条下游$/, "Rerouted $1 downstream links"],
  [/^(\d+) 条没槽位 \/ 类型对不上，没接$/, "$1 had no port or a wrong type — not connected"],
  [/^(.+) 和后面那些留在原位$/, "$1 and the ones after it stayed in place"],


  [/^没动的类型：无$/, "Types left untouched: none"],
  [/^断开的悬空线：无$/, "Dangling links removed: none"],
  [/^摆正的跳过类型：无$/, "Skipped types that were rearranged: none"],
  [/^分离：(.+)　断开 (\d+) 条$/, "Detach: $1 — $2 links removed"],
  [/^直连回去 (\d+) 条$/, "$1 reconnected directly"],
  [/^失败 (\d+) 条$/, "$1 failed"],
  [/^(.+) 插进 (.+) → (.+) 之间$/, "$1 inserted between $2 → $3"],
  [/^(\d+) 个节点串进 (.+) → (.+)$/, "$1 nodes chained into $2 → $3"],
  [/^(.+)　（原来 (.+) 在前）$/, "$1　(originally $2 came first)"],
  [/^对调的类型：(.+)$/, "Swapped types: $1"],
  [/^结果：上游 (\d+) 条$/, "Result: $1 upstream"],
  [/^没动的类型：(.+)$/, "Types left untouched: $1"],
  [/^摆正的跳过类型：(.+)$/, "Skipped types that were rearranged: $1"],
  [/^摆正了跳过类型：(.+)$/, "Rearranged skipped types: $1"],
  [/^断开的悬空线：(.+)$/, "Dangling links removed: $1"],
  [/^(  out .+) 已失效$/, "$1 (stale)"],


  [/^还有 1 条线可以顺路穿过去$/, "1 more link could be routed through"],
  [/^还有 (\d+) 条线可以顺路穿过去$/, "There are $1 more links that could be routed through"],
  [
    /^接上之后这几条线会多绕一道 (.+)，原来的图不会断。$/,
    "If connected, these links would detour through $1 — nothing else in the graph breaks.",
  ],
  [/^接上了 (\d+) \/ (\d+) 条$/, "Connected $1 of $2"],
];


function trBlock(text) {
  if (menuLang() === "zh") return text;
  return String(text ?? "")
    .split("\n")
    .map((line) => tr(line))
    .join("\n");
}

function tr(text) {
  if (menuLang() === "zh") return text;

  const s = String(text ?? "");
  if (!s) return s;

  if (Object.prototype.hasOwnProperty.call(EN_TEXT, s)) return EN_TEXT[s];


  if (s.includes("·")) {
    const segs = s.split(/\s*·\s*/);
    if (segs.length > 1) return segs.map((x) => tr(x)).join(" · ");
  }

  for (const [re, to] of EN_RULES) {

    if (re.test(s)) return s.replace(re, to).replace(/、/g, ", ");
  }
  return s;
}

const ANCHOR_RE = /刷新节点|重新加载节点|Reload\s*Node|Refresh\s*Node/i;

function entryText(el) {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}


function currentMenuRoot(text) {
  const roots = [...document.querySelectorAll(".litecontextmenu")];
  let hit = null;
  for (const root of roots) {
    const entries = [...root.querySelectorAll(".litemenu-entry")];
    if (entries.some((el) => entryText(el).includes(text))) hit = root;
  }
  return hit;
}


function moveNearAnchor() {
  const label = menuText();
  const sepLabel = sepText();
  const root = currentMenuRoot(label);
  if (!root) return false;

  const entries = [...root.querySelectorAll(".litemenu-entry")];
  const ours = entries.find((el) => entryText(el).includes(label));
  if (!ours) return true;

  const parent = ours.parentElement;
  if (!parent) return true;

  const sep = entries.find(
    (el) => el !== ours && entryText(el).includes(sepLabel) && el.parentElement === parent
  );

  const anchor = [...parent.children].find(
    (el) =>
      el !== ours &&
      el !== sep &&
      !el.classList.contains("separator") &&
      ANCHOR_RE.test(entryText(el))
  );

  try {
    if (anchor) {
      parent.insertBefore(ours, anchor.nextElementSibling);
      if (sep) parent.insertBefore(sep, ours.nextElementSibling);
    } else {
      parent.insertBefore(ours, parent.firstElementChild);
      if (sep) parent.insertBefore(sep, ours.nextElementSibling);
    }
  } catch (err) {
    console.warn(LOG, "调整菜单项位置失败", err);
  }
  return true;
}

function scheduleMenuReposition() {
  let tries = 0;
  const tick = () => {
    if (moveNearAnchor() || ++tries > 120) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}


function contextNodesOf(contextNode) {
  const sel = selectedNodes();
  const selIds = new Set(sel.map((n) => n.id));

  if (contextNode && !selIds.has(contextNode.id)) return [contextNode];

  const list = sel.length ? sel : contextNode ? [contextNode] : [];
  return list
    .slice()
    .sort((a, b) => (a?.pos?.[0] ?? 0) - (b?.pos?.[0] ?? 0));
}

function buildMenuItem(contextNode) {
  const nodes = contextNodesOf(contextNode);
  const many = nodes.length > 1;

  let content = `➕ ${menuText()}…`;
  if (many) {
    content +=
      menuLang() === "zh" ? `（${nodes.length} 个串联）` : ` (${nodes.length} in a chain)`;
  }

  return {
    content,
    callback: () => {
      if (!nodes.length) {
        toast("info", "先选中要插入的节点", "选中后再右键它。", 5000);
        return;
      }
      arm(nodes);
    },
  };
}

function buildSeparateItem(contextNode) {
  const nodes = contextNodesOf(contextNode);
  const many = nodes.length > 1;

  let content = `✂ ${sepText()}`;
  if (many) {
    content += menuLang() === "zh" ? `（${nodes.length} 个）` : ` (${nodes.length} nodes)`;
  }

  return {
    content,
    callback: () => {
      if (!nodes.length) {
        toast("info", "先选中要分离的节点", "选中后再右键它。", 5000);
        return;
      }
      separateNodes(nodes);
    },
  };
}


function copyWiringDump() {
  const g = app.graph;
  const nodes = (g?._nodes ?? []).slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  if (!nodes.length) {
    toast("info", "画布上还没有节点", null, 3200);
    return "";
  }

  const header = [
    `ComfyUI-NodeInserter v${VERSION} — 连线情况`,
    `${nodes.length} 个节点`,
  ];


  const muted = nodes.filter((n) => (n.mode ?? 0) !== 0);
  if (muted.length) {
    header.push(
      `含 ${muted.length} 个非正常节点：`
        + muted.map((n) => `${nodeTag(n)}${nodeModeTag(n)}`).join(" · "),
    );
  }
  header.push("");

  const text = [...header, dumpText(nodes, g)].join("\n");
  lastReport = text;

  console.log(`${LOG} 连线情况\n${text}`);
  let copied = false;
  try {
    const nav = globalThis.navigator;
    if (nav?.clipboard?.writeText) {
      nav.clipboard.writeText(text).then(() => {}, () => {});
      copied = true;
    }
  } catch (err) {

  }

  toast(
    "success",
    copied ? "连线情况已复制到剪贴板" : "连线情况已写入控制台（F12）",
    `${nodes.length} 个节点`,
    3600,
  );
  return text;
}


function patchLegacyMenu() {
  let proto = null;
  try {
    proto = app.canvas?.constructor?.prototype ?? LG()?.LGraphCanvas?.prototype ?? null;
  } catch (err) {
    proto = null;
  }
  if (!proto || typeof proto.getNodeMenuOptions !== "function") return false;
  if (proto.__nriPatched) return true;

  const original = proto.getNodeMenuOptions;
  proto.getNodeMenuOptions = function (node) {
    const options = original.apply(this, arguments) || [];
    if (!newMenuApiUsed && node) {
      options.push(null);
      options.push(buildMenuItem(node));
      options.push(buildSeparateItem(node));
      scheduleMenuReposition();
    }
    return options;
  };
  proto.__nriPatched = true;
  return true;
}



function liveLG() {
  try {
    return globalThis.__COMFY_LITEGRAPH_INSTANCE__ || LG();
  } catch (err) {
    return LG();
  }
}

function presentationStore() {
  try {
    return piniaOf()?._s?.get?.("linkPresentation") ?? null;
  } catch (err) {
    return null;
  }
}

function linkIsHidden(graph, link) {
  const store = presentationStore();
  if (!store?.getPresentation || !graph || !link) return false;
  try {
    const scope = {
      rootGraphId: graph.rootGraph?.id ?? graph.id,
      owningGraphId: graph.id,
    };
    return store.getPresentation(scope, link.id)?.hidden === true;
  } catch (err) {
    return false;
  }
}

function rerouteNear(graph, x, y, r) {
  const store = graph?.reroutes;
  if (!store) return false;
  const list = typeof store.values === "function" ? [...store.values()] : Object.values(store);
  return list.some((rr) => rr?.pos && Math.hypot(x - rr.pos[0], y - rr.pos[1]) <= r);
}

function linkUnderPointer(canvas, e) {
  const graph = canvas?.graph;
  if (!graph || !e) return null;
  const x = e.canvasX;
  const y = e.canvasY;
  if (!isFinite(x) || !isFinite(y)) return null;

  const L = liveLG();
  if (canvas.links_render_mode === (L?.HIDDEN_LINK ?? -1)) return null;

  const scale = canvas.ds?.scale || 1;
  if (rerouteNear(graph, x, y, 12 / scale)) return null;

  const link = findLinkAt(x, y, Math.max(5, 13 / scale), graph);
  if (!link || linkIsHidden(graph, link)) return null;
  return link;
}

function menuLinkOf(graph, segment, presentationLink) {
  if (!graph) return null;
  if (segment && segment.id != null && getLink(graph, segment.id) === segment) return segment;
  if (presentationLink && presentationLink.id != null) return getLink(graph, presentationLink.id);
  const ids = segment?.linkIds;
  if (ids && typeof ids.values === "function" && ids.size === 1) {
    return getLink(graph, ids.values().next().value);
  }
  return null;
}

function disconnectLink(graph, linkId) {
  const g = graph ?? app.canvas?.graph ?? app.graph;
  const link = getLink(g, linkId);
  if (!g || !link) {
    toast("warn", "这条线已经不在了", null, 3000);
    return false;
  }

  const a = g.getNodeById?.(link.origin_id);
  const b = g.getNodeById?.(link.target_id);
  const from = `${nodeTag(a)}.out[${link.origin_slot}]`;
  const to = `${nodeTag(b)}.in[${link.target_slot}]`;
  const type = String(link.type ?? "*");

  let ok = false;
  beginChange();
  try {
    if (typeof g.removeLink === "function") g.removeLink(link.id);
    else b?.disconnectInput?.(link.target_slot);
    ok = !getLink(g, link.id);
  } catch (err) {
    console.error(LOG, "断开连线出错", err);
  } finally {
    endChange();
  }

  g.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);

  if (!ok) {
    toast("error", "断开连线失败", "详情见控制台（F12）。", 6000);
    return false;
  }

  lastReport = `ComfyUI-NodeInserter v${VERSION} — ${tr("断开连线")}\n${from} → ${to}  (${type})`;
  console.log(LOG, "断开连线", { link: link.id, from, to, type });
  toast("success", `已断开 ${nodeName(a)} → ${nodeName(b)}`, null, 2600);
  return true;
}

function buildCutItem(graph, link) {
  const id = link.id;
  return {
    content: `✂ ${cutText()}`,
    callback: () => {
      disconnectLink(graph, id);
    },
  };
}

let warnedLinkMenu = false;

function patchLinkMenu() {
  let proto = null;
  try {
    proto = app.canvas?.constructor?.prototype ?? LG()?.LGraphCanvas?.prototype ?? null;
  } catch (err) {
    proto = null;
  }
  if (!proto) return false;
  if (typeof proto.showLinkMenu !== "function" || typeof proto.processContextMenu !== "function") {
    console.warn(LOG, "这个前端版本没有 showLinkMenu / processContextMenu，右键断开连线不可用");
    return false;
  }
  if (proto.__nriLinkMenuPatched) return true;

  const origShow = proto.showLinkMenu;
  proto.showLinkMenu = function (segment, e, presentationLink) {
    const graph = this.graph ?? app.graph;
    let link = null;
    try {
      link = menuLinkOf(graph, segment, presentationLink);
    } catch (err) {
      link = null;
    }

    const L = liveLG();
    const Base = L?.ContextMenu;
    if (!link || this.read_only || typeof Base !== "function") {
      return origShow.apply(this, arguments);
    }

    const item = buildCutItem(graph, link);
    let injected = false;
    class WithCut extends Base {
      constructor(values, options) {
        if (!injected && Array.isArray(values)) {
          injected = true;
          values = [item, null, ...values];
        }
        super(values, options);
      }
    }

    L.ContextMenu = WithCut;
    try {
      return origShow.apply(this, arguments);
    } finally {
      L.ContextMenu = Base;
      if (!injected && !warnedLinkMenu) {
        warnedLinkMenu = true;
        console.warn(LOG, "连线菜单没走 LiteGraph.ContextMenu，「断开连线」没加上（前端可能改了实现）");
      }
    }
  };

  const origCtx = proto.processContextMenu;
  proto.processContextMenu = function (node, event) {
    if (!node && event && !this.read_only) {
      let link = null;
      try {
        link = linkUnderPointer(this, event);
      } catch (err) {
        link = null;
      }
      if (link) {
        this.showLinkMenu(link, event, link);
        return;
      }
    }
    return origCtx.apply(this, arguments);
  };

  proto.__nriLinkMenuPatched = true;
  return true;
}

app.registerExtension({
  name: EXT_NAME,

  async setup() {
    patchLegacyMenu();
    patchLinkMenu();


    window.nri = {
      version: VERSION,
      findLinkAt: (x, y) => findLinkAt(x, y, 13 / (app.canvas?.ds?.scale || 1)),
      disconnectLink: (id) => disconnectLink(app.canvas?.graph ?? app.graph, id),
      arm: (node) => arm(node ? [node] : selectedNodes()),
      disarm,
      separate: (node) => separateNodes(node ? [node] : selectedNodes()),
      undoProbe: () => {
        const t = changeTracker();
        return {
          trackerFound: !!t,
          via: t ? (piniaOf() ? "pinia" : "app") : "none",
          changeCount: t?.changeCount ?? null,
          undoQueue: t?.undoQueue?.length ?? null,
          redoQueue: t?.redoQueue?.length ?? null,
        };
      },

      dump() {
        const g = app.graph;
        const picked = selectedNodes();
        const list = picked.length ? picked : (g?._nodes ?? []);
        const text = dumpText(list, g);
        lastReport = text;
        console.log(`${LOG} 连线报告\n${text}`);
        try {
          globalThis.navigator?.clipboard?.writeText(text);
        } catch (err) {
          /* ignore */
        }
        return `已导出 ${list.length} 个节点，并复制到剪贴板`;
      },

      wiring() {
        return copyWiringDump();
      },

      last() {
        return lastReport ?? "还没有执行过插入或分离。";
      },

      copy() {
        if (!lastReport) return "还没有执行过插入或分离。";
        try {
          globalThis.navigator?.clipboard?.writeText(lastReport);
          return "已复制";
        } catch (err) {
          return String(err);
        }
      },
    };

    console.log(
      `${LOG} v${VERSION} 已加载 — 右键节点 → 插入到连线… / 从连线中分离；右键连线 → 断开连线`
    );
  },


  getNodeMenuItems(node) {
    newMenuApiUsed = true;
    if (!node) return [];
    scheduleMenuReposition();
    return [buildMenuItem(node), buildSeparateItem(node)];
  },


  getCanvasMenuItems() {
    const items = [];
    if (selectedNodes().length) items.push(buildMenuItem(null));
    items.push({
      content: menuLang() === "zh" ? "📋 复制连线情况（NodeTools排查用）" : "📋 Copy wiring (NodeTools debug)",
      callback: () => copyWiringDump(),
    });
    return items;
  },
});
