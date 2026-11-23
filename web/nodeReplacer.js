

import { app } from "../../scripts/app.js";

const EXT_NAME = "ComfyUI.NodeReplacer";
const VERSION = "1.0.0";
const LOG = "[NodeReplacer]";


const MARK_COLOR = "#ff7a45";



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


function normName(n) {
  return String(n ?? "")
    .toLowerCase()
    .replace(/[\s_\-.]/g, "")
    .replace(/\d+$/, "");
}


function getLink(graph, id) {
  if (!graph || id === null || id === undefined) return null;
  const links = graph.links ?? graph._links;
  if (!links) return null;
  if (typeof links.get === "function") return links.get(id) ?? null;
  return links[id] ?? null;
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

function beginChange() {
  try {
    app.canvas?.emitBeforeChange?.();
  } catch (err) {
    /* ignore */
  }
}

function endChange() {
  try {
    app.canvas?.emitAfterChange?.();
  } catch (err) {
    /* ignore */
  }
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
  if (sel) {
    for (const n of Object.values(sel)) add(n);
  }


  if (!out.length && Array.isArray(app.graph?._nodes)) {
    for (const n of app.graph._nodes) {
      if (n?.selected) add(n);
    }
  }

  return out;
}


function linkCountOf(node) {
  if (!node) return 0;
  let n = 0;
  for (const slot of node.inputs ?? []) {
    if (slot?.link !== null && slot?.link !== undefined) n++;
  }
  for (const slot of node.outputs ?? []) {
    n += Array.isArray(slot?.links) ? slot.links.length : 0;
  }
  return n;
}


function displayName(node) {
  return node?.title || node?.type || "节点";
}



let lastReport = null;

function dumpNodeLines(node, graph) {
  if (!node) return ["(节点不存在)"];
  const label = (n) => (n ? `${displayName(n)}#${n.id}` : "?");
  const rows = [];

  rows.push(
    `── ${label(node)}  [type=${node.type}]  `
      + `pos ${Math.round(node.pos?.[0] ?? 0)},${Math.round(node.pos?.[1] ?? 0)}`,
  );

  (node.inputs ?? []).forEach((s, i) => {
    const l = getLink(graph, s?.link);
    rows.push(
      l
        ? `  in  [${i}] ${s.name} (${s.type})  ←  ${label(graph.getNodeById(l.origin_id))}.out[${l.origin_slot}]  link.type=${l.type}`
        : `  in  [${i}] ${s.name} (${s.type})  ←  —`,
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
      rows.push(
        l
          ? `  out [${i}] ${s.name} (${s.type})  →  ${label(graph.getNodeById(l.target_id))}.in[${l.target_slot}]  link.type=${l.type}`
          : `  out [${i}] ${s.name} (${s.type})  →  link#${id} 已失效`,
      );
    }
  });

  return rows;
}

function dumpText(nodes, graph) {
  const g = graph ?? app.graph;
  return nodes.filter(Boolean).flatMap((n) => [...dumpNodeLines(n, g), ""]).join("\n");
}


function publishReport(kind, headline, sections) {
  const text = trBlock(
    [`ComfyUI-NodeReplacer v${VERSION} — ${tr(kind)}`, headline, "", ...sections].join("\n"),
  );
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




function matchSlots(source, target, isInput, graph) {
  const srcSlots = (isInput ? source.inputs : source.outputs) ?? [];
  const dstSlots = (isInput ? target.inputs : target.outputs) ?? [];

  const usedDst = new Set();
  const doneSrc = new Set();
  const pairs = [];
  const fuzzy = [];
  const unmatched = [];

  const hasLink = (slot) =>
    isInput
      ? slot?.link !== null && slot?.link !== undefined
      : (slot?.links?.length ?? 0) > 0;

  const pending = [];
  srcSlots.forEach((s, i) => {
    if (hasLink(s)) pending.push(i);
  });
  if (!pending.length) return { pairs, fuzzy, unmatched };

  const isEmptySlot = (j) =>
    isInput
      ? dstSlots[j]?.link === null || dstSlots[j]?.link === undefined
      : (dstSlots[j]?.links?.length ?? 0) === 0;

  const srcTypeOf = (i) => {
    const s = srcSlots[i];
    if (s?.type) return s.type;
    if (isInput) {
      const l = getLink(graph, s?.link);
      return l?.type ?? "*";
    }
    const first = s?.links?.[0];
    const l = first !== undefined ? getLink(graph, first) : null;
    return l?.type ?? "*";
  };

  const run = (pred, isFuzzy) => {
    for (const i of pending) {
      if (doneSrc.has(i)) continue;
      const want = srcTypeOf(i);

      let hit = -1;
      for (let j = 0; j < dstSlots.length; j++) {
        if (usedDst.has(j)) continue;
        if (!compatible(dstSlots[j]?.type, want)) continue;
        if (!pred(dstSlots[j], j, i)) continue;
        hit = j;
        break;
      }

      if (hit >= 0) {
        usedDst.add(hit);
        doneSrc.add(i);
        pairs.push({ from: i, to: hit });
        if (isFuzzy) {
          fuzzy.push({
            from: i,
            to: hit,
            srcName: srcSlots[i]?.name,
            dstName: dstSlots[hit]?.name,
          });
        }
      }
    }
  };

  run((n, _j, i) => n?.name === srcSlots[i]?.name, false);
  run((n, _j, i) => normName(n?.name) === normName(srcSlots[i]?.name), false);
  run((_n, j, i) => j === i, true);
  run((_n, j) => isEmptySlot(j), true);
  run(() => true, false);

  for (const i of pending) {
    if (!doneSrc.has(i)) unmatched.push(i);
  }

  return { pairs, fuzzy, unmatched };
}




function slotTypeOf(node, idx, isInput, graph) {
  const slot = (isInput ? node.inputs : node.outputs)?.[idx];
  if (slot?.type) return slot.type;
  if (isInput) {
    const l = getLink(graph, slot?.link);
    return l?.type ?? "*";
  }
  const first = slot?.links?.[0];
  const l = first !== undefined ? getLink(graph, first) : null;
  return l?.type ?? "*";
}

function typeKeyOf(t) {
  return typeTokens(t).sort().join(",");
}


function danglingInputs(node, graph, onlyKeys) {
  const g = graph ?? app.graph;
  const outs = node?.outputs ?? [];
  if (!outs.length) return [];

  const outLive = new Map();
  outs.forEach((s, i) => {
    const key = typeKeyOf(slotTypeOf(node, i, false, g));
    outLive.set(key, (outLive.get(key) ?? 0) + (Array.isArray(s?.links) ? s.links.length : 0));
  });

  const out = [];
  (node.inputs ?? []).forEach((s, i) => {
    if (s?.link === null || s?.link === undefined) return;
    const type = slotTypeOf(node, i, true, g);
    const key = typeKeyOf(type);
    if (!outLive.has(key)) return;
    if (outLive.get(key) > 0) return;
    if (onlyKeys && !onlyKeys.has(key)) return;
    out.push({ slot: i, key, type: String(type) });
  });
  return out;
}


function cutDanglingInputs(node, graph, onlyKeys) {
  const list = danglingInputs(node, graph, onlyKeys);
  const cut = [];
  for (const c of list) {
    try {
      node.disconnectInput(c.slot);
      cut.push(c);
    } catch (err) {
      console.warn(LOG, "断开悬空输入失败", c.slot, err);
    }
  }
  return cut;
}


function cutLabel(cut) {
  const uniq = [];
  for (const c of cut) if (!uniq.includes(c.type)) uniq.push(c.type);
  return uniq.join("、");
}


function slotHasLine(node, idx, isInput, graph) {
  const slot = (isInput ? node?.inputs : node?.outputs)?.[idx];
  if (!slot) return false;
  if (isInput) return getLink(graph, slot.link) !== null;
  const ids = Array.isArray(slot.links) ? slot.links : [];
  return ids.some((id) => getLink(graph, id));
}


function planTransfer(oldNode, newNode, graph) {
  const inMatch = matchSlots(oldNode, newNode, true, graph);
  const outMatch = matchSlots(oldNode, newNode, false, graph);

  const stuck = new Map();
  const markStuck = (idx, isInput) => {

    if (!slotHasLine(oldNode, idx, isInput, graph)) return;
    const type = slotTypeOf(oldNode, idx, isInput, graph);
    const key = typeKeyOf(type);
    const e = stuck.get(key)
      ?? { key, type: String(type), sides: new Set(), inSlots: [], outSlots: [] };
    e.sides.add(isInput ? "in" : "out");
    (isInput ? e.inSlots : e.outSlots).push(idx);
    stuck.set(key, e);
  };
  for (const i of inMatch.unmatched) markStuck(i, true);
  for (const i of outMatch.unmatched) markStuck(i, false);

  const keyOf = (idx, isInput) => typeKeyOf(slotTypeOf(oldNode, idx, isInput, graph));
  const inPairs = inMatch.pairs.filter((p) => !stuck.has(keyOf(p.from, true)));
  const outPairs = outMatch.pairs.filter((p) => !stuck.has(keyOf(p.from, false)));


  const dead = [];
  for (const [key, e] of [...stuck]) {
    const onlyIn = e.sides.size === 1 && e.sides.has("in");
    if (!onlyIn) continue;
    const dangling = danglingInputs(oldNode, graph, new Set([key]));
    if (!dangling.length) continue;
    dead.push({ ...e, slots: dangling });
    stuck.delete(key);
  }

  return { inMatch, outMatch, inPairs, outPairs, stuck: [...stuck.values()], dead };
}


function snapshotLinks(oldNode, graph) {
  const ins = [];
  (oldNode.inputs ?? []).forEach((slot, i) => {
    const l = getLink(graph, slot?.link);
    if (!l) return;
    ins.push({ index: i, originId: l.origin_id, originSlot: l.origin_slot });
  });

  const outs = [];
  (oldNode.outputs ?? []).forEach((slot, i) => {
    for (const id of Array.isArray(slot?.links) ? [...slot.links] : []) {
      const l = getLink(graph, id);
      if (!l) continue;
      outs.push({ index: i, targetId: l.target_id, targetSlot: l.target_slot });
    }
  });

  return { ins, outs };
}


function spliceStuck(oldNode, newNode, snap, plan, graph) {
  const res = { spliced: 0, pairs: [], left: [] };
  const keyAt = (idx, isInput) => typeKeyOf(slotTypeOf(oldNode, idx, isInput, graph));

  for (const e of plan.stuck ?? []) {
    const srcRecs = (snap.ins ?? []).filter((r) => keyAt(r.index, true) === e.key);
    const outRecs = snap.outs ?? [];
    const dstRecs = outRecs.filter((r) => keyAt(r.index, false) === e.key);

    if (srcRecs.length > 1) {
      res.left.push({ type: e.type, why: `这类输入有 ${srcRecs.length} 条，不知道用哪条` });
      continue;
    }
    if (!srcRecs.length) {
      res.left.push({ type: e.type, why: "上游没有这类线，数据是它自己产出的" });
      continue;
    }
    if (!dstRecs.length) {
      res.left.push({ type: e.type, why: "下游没有这类线" });
      continue;
    }

    const src = srcRecs[0];
    if (src.originId === newNode.id) {
      res.left.push({ type: e.type, why: "上游就是替换者自己" });
      continue;
    }
    const srcNode = graph.getNodeById(src.originId);
    if (!srcNode) {
      res.left.push({ type: e.type, why: "上游节点找不到了" });
      continue;
    }

    let ok = 0;
    let bad = 0;
    for (const rec of dstRecs) {
      if (rec.targetId === newNode.id) continue;
      const tgt = graph.getNodeById(rec.targetId);
      if (!tgt) {
        bad++;
        continue;
      }
      try {
        srcNode.connect(src.originSlot, tgt, rec.targetSlot);
        ok++;
        res.pairs.push({
          type: String(e.type),
          from: `${displayName(srcNode)}#${srcNode.id}.out[${src.originSlot}]`,
          to: `${displayName(tgt)}#${tgt.id}.${tgt.inputs?.[rec.targetSlot]?.name ?? "in"}`,
        });
      } catch (err) {
        console.warn(LOG, "旁路直连失败", e.type, src.originSlot, "→", rec.targetId, rec.targetSlot, err);
        bad++;
      }
    }

    if (!ok) {
      res.left.push({ type: e.type, why: "上游接不到下游" });
      continue;
    }
    res.spliced += ok;


    for (const rec of srcRecs) {
      try {
        oldNode.disconnectInput(rec.index);
      } catch (err) {
        /* ignore */
      }
    }
    if (!bad) {
      for (const rec of dstRecs) {
        try {
          oldNode.disconnectOutput(rec.index);
        } catch (err) {
          /* ignore */
        }
      }
    }
  }

  return res;
}


function replaceWithNode(oldNode, newNode, note) {
  const graph = app.graph;
  if (!graph || !oldNode || !newNode) return false;

  if (oldNode === newNode || oldNode.id === newNode.id) {
    toast("warn", "不能自己替换自己", "请选中另外两个节点。", 3500);
    return false;
  }

  closeChoice();

  const snap = snapshotLinks(oldNode, graph);
  const plan = planTransfer(oldNode, newNode, graph);


  return executeReplace(oldNode, newNode, snap, plan, note);
}


function executeReplace(oldNode, newNode, snap, plan, note) {
  const graph = app.graph;
  if (!graph) return false;

  const { ins: inputSnap, outs: outputSnap } = snap;
  const oldPos = [oldNode.pos[0], oldNode.pos[1]];
  const newPos = [newNode.pos[0], newNode.pos[1]];


  const beforeText = dumpText([oldNode, newNode], graph);

  beginChange();

  try {

    newNode.pos = [oldPos[0], oldPos[1]];
    oldNode.pos = [newPos[0], newPos[1]];


    let inDone = 0;
    let inFail = 0;
    let overwritten = 0;

    for (const { from, to } of plan.inPairs) {
      const rec = inputSnap.find((x) => x.index === from);
      if (!rec) continue;
      if (rec.originId === newNode.id) continue;

      const srcNode = graph.getNodeById(rec.originId);
      if (!srcNode) {
        inFail++;
        continue;
      }


      try {
        const existing = newNode.inputs?.[to]?.link;
        if (existing !== null && existing !== undefined) {
          newNode.disconnectInput(to);
          overwritten++;
        }
      } catch (err) {
        /* ignore */
      }


      try {
        oldNode.disconnectInput(from);
      } catch (err) {
        /* ignore */
      }

      try {
        srcNode.connect(rec.originSlot, newNode, to);
        inDone++;
      } catch (err) {
        console.warn(LOG, "输入连接失败", from, "→", to, err);
        inFail++;
      }
    }




    let outDone = 0;
    let outFail = 0;

    for (const { from, to } of plan.outPairs) {
      const recs = outputSnap.filter((x) => x.index === from);


      try {
        oldNode.disconnectOutput(from);
      } catch (err) {
        /* ignore */
      }

      for (const rec of recs) {
        if (rec.targetId === newNode.id) continue;
        const tgtNode = graph.getNodeById(rec.targetId);
        if (!tgtNode) {
          outFail++;
          continue;
        }
        try {
          newNode.connect(to, tgtNode, rec.targetSlot);
          outDone++;
        } catch (err) {
          console.warn(LOG, "输出连接失败", from, "→", to, err);
          outFail++;
        }
      }
    }






    const splice = spliceStuck(oldNode, newNode, snap, plan, graph);


    const cutDead = cutDanglingInputs(oldNode, graph, new Set(plan.dead.map((d) => d.key)));




    const topOut = topUpOutputs(newNode, snap, graph);


    const top = topUpInputs(newNode, graph);

    newNode.setDirtyCanvas?.(true, true);
    oldNode.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    try {
      app.canvas?.selectNode?.(newNode, false);
    } catch (err) {
      try {
        if (app.canvas) app.canvas.selected_nodes = { [newNode.id]: newNode };
      } catch (err2) {
        /* ignore */
      }
    }


    const transferTotal = inputSnap.length + outputSnap.length;
    const parts = [`连线 输入 ${inDone}/${inputSnap.length} · 输出 ${outDone}/${outputSnap.length}`];
    if (overwritten) parts.push(`覆盖了替换者原有 ${overwritten} 条输入线`);
    if (splice.spliced) {
      const types = [...new Set(splice.pairs.map((p) => p.type))].join("、");
      parts.push(`${types} 改成了上游直连下游（旧节点不在这条线上了）`);
    }
    if (splice.left.length) {
      parts.push(`没动的：${splice.left.map((l) => `${l.type}（${l.why}）`).join("、")}`);
    }
    if (cutDead.length) parts.push(`断开了 ${cutDead.length} 条没下游的悬空线（${cutLabel(cutDead)}）`);
    if (topOut.added) {
      parts.push(`下游补连 ${topOut.added} 条（${topOut.pairs.filter((p) => p.how === "补空").map((p) => p.type).join("、")}）`);
    }
    if (topOut.bridged) {
      parts.push(`改接 ${topOut.bridged} 条到新节点（${topOut.pairs.filter((p) => p.how === "改接").map((p) => p.type).join("、")}，原先直接绕过它的）`);
    }
    if (top.added) parts.push(`补连 ${top.added} 条空口（${top.pairs.map((p) => p.type).join("、")}）`);


    const deadEndTypes = [...new Set(top.pairs.map((p) => p.type))].filter((t) => {
      const outs = (newNode.outputs ?? []).filter((s) => compatible(s?.type, t));
      return outs.length > 0 && outs.every((s) => !(Array.isArray(s.links) && s.links.length));
    });
    if (deadEndTypes.length) parts.push(`${deadEndTypes.join("、")} 出口还没接下游，要手动接`);
    parts.push(transferTotal ? "旧节点已保留，位置互换完成" : "两边都没有连线，只互换了位置");


    const reportCopied = publishReport(
      "替换",
      `${displayName(oldNode)}#${oldNode.id} → ${displayName(newNode)}#${newNode.id}`,
      [
        `结果：搬过去 输入 ${inDone}/${inputSnap.length} · 输出 ${outDone}/${outputSnap.length}`
          + ` · 旁路直连 ${splice.pairs.length} · 原样留下 ${splice.left.length}`,
        `可搬槽位：in=${JSON.stringify(plan.inPairs)} out=${JSON.stringify(plan.outPairs)}`,
        `旁路直连（上游 → 下游）：${splice.pairs.length
          ? splice.pairs.map((p) => `${p.type} ${p.from} → ${p.to}`).join("、")
          : "无"}`,
        `原样留在旧节点上：${splice.left.length
          ? splice.left.map((l) => `${l.type}（${l.why}）`).join("、")
          : "无"}`,
        `断开的悬空线：${cutDead.length ? `${cutLabel(cutDead)}（${cutDead.length} 条）` : "无"}`,
        `覆盖替换者原有输入线：${overwritten} 条`,
        `下游补连：${topOut.pairs.length ? topOut.pairs.map((p) => `${p.how} ${p.type} → ${p.to}`).join("、") : "无"}`,
        `补连空口（上游 → 新节点）：${top.added ? top.pairs.map((p) => `${p.from} → ${p.to}`).join("、") : "无"}`,
        "",
        "【替换前】",
        beforeText,
        "【替换后】",
        dumpText([oldNode, newNode], graph),
      ],
    );
    if (reportCopied) parts.push("连线报告已复制到剪贴板");

    const softWarn = plan.inMatch.fuzzy.length + plan.outMatch.fuzzy.length;

    if (inFail <= 0 && outFail <= 0) {
      if (!transferTotal) {
        toast(
          "info",
          "只互换了位置",
          `${displayName(oldNode)} ↔ ${displayName(newNode)}　·　两个节点都没有连线，没有线要搬`,
          4000,
        );
      } else if (splice.left.length) {
        const summary = note ? `${note} · ${parts.join(" · ")}` : parts.join(" · ");
        toast("warn", `已用 ${displayName(newNode)} 替换`, summary, 9000);
      } else {
        const summary = note ? `${note} · ${parts.join(" · ")}` : parts.join(" · ");
        toast("success", `已用 ${displayName(newNode)} 替换`, summary, 4500);
      }
    } else {
      parts.push(`没接上 ${inFail + outFail} 条`);
      if (softWarn) parts.push(`${softWarn} 处为近似匹配，请复核`);
      const summary = note ? `${note} · ${parts.join(" · ")}` : parts.join(" · ");
      toast("warn", "替换完成，但部分连线没接上", summary, 9000);
    }

    console.log(LOG, `替换 ${oldNode.type} → ${newNode.type}`, {
      input: plan.inMatch,
      output: plan.outMatch,
      moved: { in: plan.inPairs, out: plan.outPairs },
      spliced: splice.pairs,
      leftOnOld: splice.left,
      overwritten,
    });

    return true;
  } catch (err) {
    console.error(LOG, "替换过程中出错", err);
    toast("error", "替换失败", String(err?.message ?? err));
    return false;
  } finally {
    endChange();
  }
}



const BAR_ID = "cnr-armed-bar";
const STYLE_ID = "cnr-armed-style";

const ARMED_CSS = `
#cnr-armed-bar {
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
  border: 1px solid #ff7a45;
  background: var(--comfy-menu-bg, #1f1f23);
  color: var(--input-text, #eaeaea);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
  box-shadow: 0 8px 26px rgba(0,0,0,0.45), 0 0 0 3px rgba(255,122,69,0.14);
  pointer-events: none;
  user-select: none;
  animation: cnr-in 0.14s ease-out;
}
@keyframes cnr-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
#cnr-armed-bar .cnr-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #ff7a45;
  box-shadow: 0 0 0 0 rgba(255,122,69,0.7);
  animation: cnr-pulse 1.1s infinite;
  flex: none;
}
@keyframes cnr-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(255,122,69,0.65); }
  70%  { box-shadow: 0 0 0 7px rgba(255,122,69,0); }
  100% { box-shadow: 0 0 0 0 rgba(255,122,69,0); }
}
#cnr-armed-bar .cnr-msg { font-size: 13px; font-weight: 600; }
#cnr-armed-bar .cnr-body { display: flex; flex-direction: column; gap: 3px; }
#cnr-armed-bar .cnr-sub {
  font-size: 11px;
  opacity: 0.62;
  max-width: 56vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#cnr-armed-bar .cnr-key {
  display: inline-block;
  padding: 0 4px;
  margin: 0 1px;
  border: 1px solid rgba(140,140,140,0.45);
  border-radius: 3px;
  font-size: 10px;
  line-height: 14px;
}
/* version badge */
#cnr-armed-bar .cnr-ver {
  align-self: flex-start;
  font-size: 10px;
  opacity: 0.34;
  letter-spacing: 0.02em;
}

/* ---- direction choice bar (both nodes wired) ---- */
#cnr-choice {
  position: fixed;
  z-index: 100000;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px 12px 9px;
  border-radius: 10px;
  border: 1px solid #ff7a45;
  background: var(--comfy-menu-bg, #1f1f23);
  color: var(--input-text, #eaeaea);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5), 0 0 0 3px rgba(255,122,69,0.14);
  user-select: none;
  animation: cnr-in-choice 0.12s ease-out;
}
@keyframes cnr-in-choice {
  from { opacity: 0; transform: translateY(-5px); }
  to   { opacity: 1; transform: translateY(0); }
}
#cnr-choice .cnr-choice-title {
  font-size: 12px;
  font-weight: 700;
  opacity: 0.92;
  margin-bottom: 1px;
}
#cnr-choice .cnr-choice-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid rgba(255,122,69,0.45);
  background: rgba(255,122,69,0.09);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
#cnr-choice .cnr-choice-btn:hover {
  background: rgba(255,122,69,0.2);
  border-color: #ff7a45;
}
#cnr-choice .cnr-choice-btn .cnr-choice-main { font-weight: 600; }
#cnr-choice .cnr-choice-btn .cnr-choice-sub {
  font-size: 11px;
  opacity: 0.6;
  line-height: 1.35;
}
#cnr-choice .cnr-choice-hint {
  font-size: 11px;
  opacity: 0.5;
  margin-top: 1px;
}
#cnr-choice .cnr-choice-hint b { font-weight: 600; opacity: 0.85; }

`;

let armed = null; // { oldNodes, handler, keyHandler, el }

function ensureArmedStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = ARMED_CSS;
  document.head.appendChild(s);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function canvasElement() {
  try {
    return app.canvasEl ?? app.canvas?.canvas ?? null;
  } catch (err) {
    return null;
  }
}


function pickNodeAt(e, el) {
  const cnv = app.canvas;
  const graph = app.graph;
  if (!cnv || !graph) return null;

  try {
    const rect = el.getBoundingClientRect();
    const ds = cnv.ds ?? { scale: 1, offset: [0, 0] };
    const scale = ds.scale || 1;
    const ox = ds.offset?.[0] ?? 0;
    const oy = ds.offset?.[1] ?? 0;

    const gx = (e.clientX - rect.left) / scale - ox;
    const gy = (e.clientY - rect.top) / scale - oy;


    const nodes = graph._nodes ?? cnv.visible_nodes;
    return graph.getNodeOnPos?.(gx, gy, nodes, 0) ?? null;
  } catch (err) {
    console.warn(LOG, "点击定位失败", err);
    return null;
  }
}

function showArmedBar(oldNodes) {
  document.getElementById(BAR_ID)?.remove();
  ensureArmedStyle();

  const names = oldNodes.map((n) => n.title || n.type);
  const preview =
    names.length <= 2
      ? names.join("、")
      : `${names.slice(0, 2).join("、")} 等 ${names.length} 个`;

  const chainHint = oldNodes.length > 1 ? tr("　·　多个节点将按从左到右串成一条链") : "";

  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.innerHTML = `
    <span class="cnr-dot"></span>
    <div class="cnr-body">
      <div class="cnr-msg">${tr("左键点另一个节点，立即替换")}</div>
      <div class="cnr-sub">
        ${tr("已选：")}${escapeHtml(preview)}${chainHint}　·　${tr("取消：")}<span class="cnr-key">Esc</span> / ${tr("右键 / 点空白")}
      </div>
    </div>
    <span class="cnr-ver">v${VERSION}</span>
  `;
  document.body.appendChild(bar);
}



const CHOICE_ID = "cnr-choice";
const CHOICE_TIMEOUT = 25000;
let choice = null; // { root, onDown, onKey, timer }

function closeChoice() {
  if (!choice) return;
  const { root, onDown, onKey, timer } = choice;
  choice = null;
  try {
    clearTimeout(timer);
  } catch (err) {
    /* ignore */
  }
  document.removeEventListener("pointerdown", onDown, true);
  window.removeEventListener("keydown", onKey, true);
  try {
    root?.remove();
  } catch (err) {
    /* ignore */
  }
}




function placeNearMouse(root, at) {
  try {
    const rect = root.getBoundingClientRect();
    const px = at?.x ?? window.innerWidth / 2;
    const py = at?.y ?? window.innerHeight / 2;
    let left = px + 14;
    let top = py + 14;
    if (left + rect.width > window.innerWidth - 8) left = px - rect.width - 14;
    if (top + rect.height > window.innerHeight - 8) top = py - rect.height - 14;
    root.style.left = `${Math.max(8, Math.round(left))}px`;
    root.style.top = `${Math.max(8, Math.round(top))}px`;
  } catch (err) {
    /* ignore */
  }
}


function askDirection(armedNode, clickedNode, at) {
  closeChoice();
  ensureArmedStyle();

  const nameA = displayName(armedNode);
  const nameB = displayName(clickedNode);
  const cntA = linkCountOf(armedNode);
  const cntB = linkCountOf(clickedNode);



  const names = { A: escapeHtml(nameA), B: escapeHtml(nameB) };
  const mainFirst = fillTpl(tr("用「{B}」替换「{A}」"), names);
  const mainSecond = fillTpl(tr("用「{A}」替换「{B}」"), names);

  const root = document.createElement("div");
  root.id = CHOICE_ID;
  root.innerHTML = `
    <div class="cnr-choice-title">${tr("两个节点都有连线，往哪边接？")}</div>
    <button class="cnr-choice-btn" data-pick="first">
      <span class="cnr-choice-main">${mainFirst}</span>
      <span class="cnr-choice-sub">${fillTpl(
        tr("{A}（{NA} 根线）全交给 {B}（{NB} 根线），{A} 留在画布上"),
        { ...names, NA: cntA, NB: cntB }
      )}</span>
    </button>
    <button class="cnr-choice-btn" data-pick="second">
      <span class="cnr-choice-main">${mainSecond}</span>
      <span class="cnr-choice-sub">${fillTpl(
        tr("{B}（{NB} 根线）全交给 {A}（{NA} 根线），{B} 留在画布上"),
        { ...names, NA: cntA, NB: cntB }
      )}</span>
    </button>
    <div class="cnr-choice-hint"><b>Enter</b> ${tr("第一项")}　·　<b>Esc</b> ${tr("取消")}</div>
  `;
  document.body.appendChild(root);


  placeNearMouse(root, at);

  const run = (which) => {
    closeChoice();
    if (which === "second") replaceWithNode(clickedNode, armedNode, "方向：按你选的来（反接）");
    else replaceWithNode(armedNode, clickedNode, "");
  };

  const onDown = (e) => {
    if (root.contains(e.target)) return;
    closeChoice();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeChoice();
      return;
    }
    if (e.key === "Enter" || e.key === "NumpadEnter") {
      e.preventDefault();
      e.stopPropagation();
      run("first");
    }
  };

  root.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".cnr-choice-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    run(btn.dataset.pick);
  });

  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);

  choice = {
    root,
    onDown,
    onKey,
    timer: setTimeout(() => closeChoice(), CHOICE_TIMEOUT),
  };
}


function askMode(nodes, newNode, at) {
  closeChoice();
  ensureArmedStyle();

  const count = nodes.length;
  const nameNew = displayName(newNode);

  const root = document.createElement("div");
  root.id = CHOICE_ID;
  root.innerHTML = `
    <div class="cnr-choice-title">${fillTpl(tr("选中的 {N} 个节点，怎么换？"), { N: count })}</div>
    <button class="cnr-choice-btn" data-pick="merge">
      <span class="cnr-choice-main">${fillTpl(tr("合并成一个 · 用「{X}」顶掉这 {N} 个"), {
        X: escapeHtml(nameNew),
        N: count,
      })}</span>
    </button>
    <button class="cnr-choice-btn" data-pick="split">
      <span class="cnr-choice-main">${tr("分别替换 · 每个都换成同款")}</span>
    </button>
    <div class="cnr-choice-hint"><b>Enter</b> ${tr("第一项")}　·　<b>Esc</b> ${tr("取消")}</div>
  `;
  document.body.appendChild(root);


  placeNearMouse(root, at);
  
  const run = (which) => {
    closeChoice();
    if (which === "merge") mergeReplace(nodes, newNode);
    else batchReplace(nodes, newNode);
  };

  const onDown = (e) => {
    if (root.contains(e.target)) return;
    closeChoice();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeChoice();
      return;
    }
    if (e.key === "Enter" || e.key === "NumpadEnter") {
      e.preventDefault();
      e.stopPropagation();
      run("merge");
    }
  };

  root.addEventListener("click", (e) => {
    const btn = e.target?.closest?.(".cnr-choice-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    run(btn.dataset.pick);
  });

  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);

  choice = {
    root,
    onDown,
    onKey,
    timer: setTimeout(() => closeChoice(), CHOICE_TIMEOUT),
  };
}



const MARK_STATE = Symbol("cnr-mark");

function markNode(n) {
  if (!n || n[MARK_STATE]) return;
  const had = Object.prototype.hasOwnProperty.call(n, "onDrawTitleBox");
  const prev = n.onDrawTitleBox;
  n[MARK_STATE] = { had, prev };

  n.onDrawTitleBox = function (ctx, opts) {
    if (typeof prev === "function") {
      try {
        prev.call(this, ctx, opts);
      } catch (err) {
        /* ignore */
      }
    }
    const o = opts || {};
    const LGg = LG();
    const h =
      typeof o.title_height === "number"
        ? o.title_height
        : (LGg && LGg.NODE_TITLE_HEIGHT) || 30;
    const size = typeof o.box_size === "number" ? o.box_size : 10;
    try {
      ctx.beginPath();
      ctx.fillStyle = MARK_COLOR;
      ctx.arc(h * 0.5, h * -0.5, size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    } catch (err) {
      /* ignore */
    }
  };

  n.setDirtyCanvas?.(true, true);
  return true;
}

function unmarkNode(n) {
  const st = n?.[MARK_STATE];
  if (!st) return false;
  try {
    if (st.had) n.onDrawTitleBox = st.prev;
    else delete n.onDrawTitleBox;
  } catch (err) {
    /* ignore */
  }
  delete n[MARK_STATE];
  n.setDirtyCanvas?.(true, true);
  return true;
}


function cleanBakedMarks(graph) {
  let count = 0;
  for (const n of graph?._nodes ?? []) {
    if (!n) continue;
    if (String(n.boxcolor ?? "").toLowerCase() === MARK_COLOR) {
      n.boxcolor = null;
      n.setDirtyCanvas?.(true, true);
      count++;
    }
  }
  return count;
}

function disarm() {
  if (!armed) return;
  const { oldNodes, handler, keyHandler, el } = armed;
  armed = null;
  closeChoice();

  if (el) {
    try {
      el.removeEventListener("pointerdown", handler, true);
      el.style.cursor = "";
    } catch (err) {
      /* ignore */
    }
  }
  if (keyHandler) window.removeEventListener("keydown", keyHandler, true);

  for (const n of oldNodes) {
    unmarkNode(n);
  }

  document.getElementById(BAR_ID)?.remove();
  app.canvas?.setDirty?.(true, true);
}


function arm(contextNode) {
  disarm();
  closeChoice();

  const sel = selectedNodes();
  const selIds = new Set(sel.map((n) => n.id));

  let olds;
  if (contextNode && selIds.has(contextNode.id)) {

    olds = sel;
  } else if (contextNode) {
    olds = [contextNode];
  } else {
    olds = sel;
  }

  olds = olds.filter(Boolean);
  if (!olds.length) {
    toast("info", "先选中要被替换的节点", "选中后再右键它。", 5000);
    return;
  }

  const el = canvasElement();
  if (!el) {
    toast("error", "找不到画布", "无法进入替换模式。");
    return;
  }


  cleanBakedMarks(app.graph);
  for (const n of olds) markNode(n);


  const handler = (e) => {
    if (e.button === 2) {
      disarm();
      return;
    }
    if (e.button !== 0) return;

    const node = pickNodeAt(e, el);

    if (!node) {
      disarm();
      return;
    }


    if (olds.some((o) => o.id === node.id)) {


      if (olds.length === 2 && orderPair(olds[0], olds[1], app.graph)) {
        const [x, y] = olds;
        disarm();
        swapOrder(x, y);
      }
      return;
    }

    const targets = [...olds];
    const at = { x: e.clientX, y: e.clientY };
    disarm();

    routeReplace(targets, node, at);
  };


  const keyHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      disarm();
    }
  };

  el.addEventListener("pointerdown", handler, true);
  window.addEventListener("keydown", keyHandler, true);
  try {
    el.style.cursor = "crosshair";
  } catch (err) {
    /* ignore */
  }

  armed = { oldNodes: olds, handler, keyHandler, el };
  showArmedBar(olds);
  app.canvas?.setDirty?.(true, true);
}




function routeReplace(olds, clicked, at) {
  if (!olds.length || !clicked) return false;


  if (olds.length > 1) {
    const oldLinks = olds.reduce((sum, n) => sum + linkCountOf(n), 0);


    if (oldLinks === 0 && linkCountOf(clicked) > 0) {
      return chainReplace(olds, clicked);
    }


    if (oldLinks === 0) {
      toast(
        "warn",
        "这批节点都没连线",
        "没有线可以接管。要么点一个有连线的节点让它串成链，"
          + "要么先框选要换掉的那批（它们得是有连线的）。",
        9000,
      );
      return false;
    }


    askMode(olds, clicked, at);
    return true;
  }

  const a = olds[0];
  const b = clicked;
  if (a.id === b.id) return false;

  const linkA = linkCountOf(a);
  const linkB = linkCountOf(b);


  if (linkA === 0 && linkB === 0) {
    return replaceWithNode(a, b);
  }


  if (linkA === 0 && linkB > 0) {
    return replaceWithNode(b, a, "方向已自动反过来（有连线的一方才被接管）");
  }


  if (linkA > 0 && linkB > 0) {


    if (orderPair(a, b, app.graph)) {
      swapOrder(a, b);
      return true;
    }

    askDirection(a, b, at);
    return true;
  }


  return replaceWithNode(a, b);
}



const CHAIN_GAP = 60;


function widthOf(node) {
  const w = node?.size?.[0];
  return Number.isFinite(w) && w > 0 ? w : 240;
}


function findFreeSlot(node, isInput, type, used) {
  const slots = (isInput ? node.inputs : node.outputs) ?? [];
  for (let i = 0; i < slots.length; i++) {
    if (used?.has(i)) continue;
    const s = slots[i];
    if (!s) continue;
    const free = isInput ? s.link === null || s.link === undefined : (s.links?.length ?? 0) === 0;
    if (!free) continue;
    if (!compatible(s.type, type)) continue;
    return i;
  }
  return -1;
}




const PARAM_TYPES = new Set(["FLOAT", "INT", "STRING", "BOOLEAN", "COMBO"]);

function isDataPort(slot) {
  if (!slot) return false;
  if (slot.widget) return false;
  return typeTokens(slot.type).every((x) => !PARAM_TYPES.has(String(x).toUpperCase()));
}


function upstreamPool(newNode, graph, maxDepth = 6) {
  const out = [];
  if (!newNode || !graph) return out;

  const seen = new Set([newNode.id]);
  let frontier = [newNode];

  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const s of n.inputs ?? []) {
        if (!s || !isDataPort(s)) continue;
        const l = getLink(graph, s.link);
        if (!l) continue;
        const up = graph.getNodeById(l.origin_id);
        if (!up || seen.has(up.id)) continue;
        seen.add(up.id);
        out.push(up);
        next.push(up);
      }
    }
    frontier = next;
  }

  return out;
}


function topUpInputs(newNode, graph) {
  const res = { added: 0, pairs: [] };
  if (!newNode || !graph) return res;

  const slots = newNode.inputs ?? [];
  if (!slots.length) return res;


  const sources = upstreamPool(newNode, graph, 6);
  if (!sources.length) return res;

  const taken = new Set();
  slots.forEach((s, i) => {
    if (s?.link !== null && s?.link !== undefined && s?.link !== -1) taken.add(i);
  });

  for (const src of sources) {
    (src.outputs ?? []).forEach((out, oi) => {
      if (!out?.type || !isDataPort(out)) return;




      const canOut = (newNode.outputs ?? []).some((s) => compatible(s?.type, out.type));
      if (!canOut) return;


      const ids = Array.isArray(out.links) ? out.links : [];
      const already = ids.some((id) => {
        const l = getLink(graph, id);
        return l && l.target_id === newNode.id;
      });
      if (already) return;

      const idx = slots.findIndex(
        (s, i) =>
          !taken.has(i)
          && (s?.link === null || s?.link === undefined || s?.link === -1)
          && isDataPort(s)
          && compatible(s?.type, out?.type),
      );
      if (idx < 0) return;

      taken.add(idx);
      try {
        src.connect(oi, newNode, idx);
        res.added++;
        res.pairs.push({
          from: `${displayName(src)}#${src.id}.out[${oi}]`,
          to: `${slots[idx].name}(in[${idx}])`,
          type: String(out.type),
        });
      } catch (err) {
        console.warn(LOG, "补连失败", srcId, oi, "→", newNode.id, idx, err);
      }
    });
  }

  return res;
}



function downstreamPool(startIds, newNode, graph, maxDepth = 4) {
  const out = [];
  const seen = new Set([newNode?.id]);
  let frontier = [];

  for (const id of startIds ?? []) {
    if (seen.has(id)) continue;
    const n = graph.getNodeById(id);
    if (!n) continue;
    seen.add(id);
    out.push(n);
    frontier.push(n);
  }

  for (let d = 1; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const o of n.outputs ?? []) {
        if (!isDataPort(o)) continue;
        for (const id of o?.links ?? []) {
          const l = getLink(graph, id);
          if (!l || seen.has(l.target_id)) continue;
          const t = graph.getNodeById(l.target_id);
          if (!t) continue;
          seen.add(t.id);
          out.push(t);
          next.push(t);
        }
      }
    }
    frontier = next;
  }

  return out;
}

function topUpOutputs(newNode, snap, graph) {
  const res = { added: 0, bridged: 0, pairs: [] };
  if (!newNode || !graph || !snap) return res;


  const directDown = [...new Set((snap.outs ?? []).map((o) => o.targetId))]
    .filter((id) => id !== newNode.id);
  if (!directDown.length) return res;


  const downs = downstreamPool(directDown, newNode, graph, 4);



  //



  const ups = new Set(upstreamPool(newNode, graph, 6).map((n) => n.id));



  const freeOuts = [];
  (newNode.outputs ?? []).forEach((s, i) => {
    if (!s?.type || !isDataPort(s)) return;
    freeOuts.push({ i, type: s.type, used: Array.isArray(s.links) ? s.links.length : 0 });
  });
  freeOuts.sort((a, b) => a.used - b.used);
  if (!freeOuts.length) return res;

  for (const d of downs) {

    (d.inputs ?? []).forEach((slot, si) => {
      if (!isDataPort(slot)) return;
      const t = slot?.type;
      if (!t) return;

      const pick = freeOuts.find((o) => compatible(t, o.type));
      if (!pick) return;

      const cur = getLink(graph, slot?.link);


      if (cur) {
        if (cur.origin_id === newNode.id || !ups.has(cur.origin_id)) return;

        const srcNode = graph.getNodeById(cur.origin_id);
        const srcSlot = cur.origin_slot;

        try {
          d.disconnectInput(si);
        } catch (err) {
          return;
        }
        try {
          newNode.connect(pick.i, d, si);
          res.bridged++;
          res.pairs.push({
            to: `${displayName(d)}#${d.id}.${slot.name}`,
            type: String(t),
            how: "改接",
          });
        } catch (err) {

          try {
            srcNode?.connect(srcSlot, d, si);
          } catch (err2) {
            /* ignore */
          }
          console.warn(LOG, "下游改接失败，已还原", d.id, si, err);
        }
        return;
      }


      try {
        newNode.connect(pick.i, d, si);
        res.added++;
        res.pairs.push({
          to: `${displayName(d)}#${d.id}.${slot.name}`,
          type: String(t),
          how: "补空",
        });
      } catch (err) {
        console.warn(LOG, "下游补连失败", d.id, si, err);
      }
    });
  }

  return res;
}


function chainReplace(chainNodes, oldNode) {
  const graph = app.graph;
  if (!graph || !oldNode) return false;

  const chain = [...chainNodes]
    .filter((n) => n && n.id !== oldNode.id)
    .sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1]);

  if (!chain.length) return false;
  if (chain.length === 1) return replaceWithNode(oldNode, chain[0]);


  const inRecs = [];
  (oldNode.inputs ?? []).forEach((slot, i) => {
    const l = getLink(graph, slot?.link);
    if (!l) return;
    const type = l.type ?? slot?.type ?? "*";
    inRecs.push({
      slot: i,
      originId: l.origin_id,
      originSlot: l.origin_slot,
      type,
      key: typeTokens(type).sort().join(","),
    });
  });

  const outRecs = [];
  (oldNode.outputs ?? []).forEach((slot, i) => {
    for (const id of Array.isArray(slot?.links) ? slot.links : []) {
      const l = getLink(graph, id);
      if (!l) continue;
      const type = l.type ?? slot?.type ?? "*";
      outRecs.push({
        slot: i,
        targetId: l.target_id,
        targetSlot: l.target_slot,
        type,
        key: typeTokens(type).sort().join(","),
      });
    }
  });

  const keys = [...new Set([...inRecs, ...outRecs].map((r) => r.key))];
  if (!keys.length) {
    toast("info", "没有线可以接管", `${displayName(oldNode)} 身上没有连线。`, 4500);
    return false;
  }

  const last = chain.length - 1;
  const oldPos = [oldNode.pos[0], oldNode.pos[1]];
  const firstOldPos = [chain[0].pos[0], chain[0].pos[1]];

  const usedIn = new Map(chain.map((n) => [n.id, new Set()]));
  const usedOut = new Map(chain.map((n) => [n.id, new Set()]));


  const beforeText = dumpText([...chain, oldNode], graph);

  let madeIn = 0;
  let madeOut = 0;
  let failIn = 0;
  let failOut = 0;
  const skipped = [];
  const detoured = [];

  beginChange();

  try {

    let x = oldPos[0];
    for (let i = last; i >= 0; i--) {
      chain[i].pos = [x, oldPos[1]];
      x -= widthOf(chain[i]) + CHAIN_GAP;
    }
    oldNode.pos = firstOldPos;


    for (const key of keys) {
      const ins = inRecs.filter((r) => r.key === key);
      const outs = outRecs.filter((r) => r.key === key);
      const type = ins[0]?.type ?? outs[0]?.type ?? "*";


      const planIn = new Array(chain.length).fill(-1);
      const planOut = new Array(chain.length).fill(-1);
      const carriers = [];

      for (let i = 0; i < chain.length; i++) {
        const n = chain[i];
        const needIn = i > 0 || ins.length > 0;
        const needOut = i < last || outs.length > 0;

        const ii = needIn ? findFreeSlot(n, true, type, usedIn.get(n.id)) : -1;
        const oi = findFreeSlot(n, false, type, usedOut.get(n.id));


        if (needIn && ii < 0) continue;
        if (needOut && oi < 0) continue;

        planIn[i] = ii;
        planOut[i] = oi < 0 ? -1 : oi;
        carriers.push(i);
      }

      if (!carriers.length) {

        skipped.push({ key, type: String(type), node: "链上没有这种口子" });
        continue;
      }

      if (carriers.length < chain.length) {
        detoured.push({
          type: String(type),
          nodes: chain.filter((_n, i) => !carriers.includes(i)).map(displayName),
        });
      }

      const head = carriers[0];
      const tail = carriers[carriers.length - 1];


      for (const i of carriers) {
        if (planIn[i] >= 0) usedIn.get(chain[i].id).add(planIn[i]);
        if (planOut[i] >= 0) usedOut.get(chain[i].id).add(planOut[i]);
      }


      for (const r of ins) {
        if (r.originId === chain[head].id) continue;
        try {
          oldNode.disconnectInput(r.slot);
        } catch (err) {
          /* ignore */
        }
      }
      for (const r of outs) {
        if (r.targetId === chain[tail].id) continue;
        try {
          oldNode.disconnectOutput(r.slot);
        } catch (err) {
          /* ignore */
        }
      }


      for (const r of ins) {
        const src = graph.getNodeById(r.originId);
        if (!src) {
          failIn++;
          continue;
        }
        try {
          src.connect(r.originSlot, chain[head], planIn[head]);
          madeIn++;
        } catch (err) {
          console.warn(LOG, "串联：上游连接失败", r.type, err);
          failIn++;
        }
      }


      for (let k = 1; k < carriers.length; k++) {
        const prev = carriers[k - 1];
        const cur = carriers[k];
        try {
          chain[prev].connect(planOut[prev], chain[cur], planIn[cur]);
        } catch (err) {
          console.warn(LOG, "串联：链内连接失败", prev, "→", cur, String(type), err);
        }
      }


      for (const r of outs) {
        const tgt = graph.getNodeById(r.targetId);
        if (!tgt) {
          failOut++;
          continue;
        }
        try {
          chain[tail].connect(planOut[tail], tgt, r.targetSlot);
          madeOut++;
        } catch (err) {
          console.warn(LOG, "串联：下游连接失败", r.type, err);
          failOut++;
        }
      }
    }



    const cutDead = cutDanglingInputs(oldNode, graph, new Set(skipped.map((s) => s.key)));
    const skippedLive = skipped.filter((s) => !cutDead.some((c) => c.key === s.key));


    let topAdded = 0;
    const topPairs = [];
    for (const n of chain) {
      const t = topUpInputs(n, graph);
      topAdded += t.added;
      topPairs.push(...t.pairs);
    }

    for (const n of chain) n.setDirtyCanvas?.(true, true);
    oldNode.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    try {
      app.canvas?.selectNode?.(chain[last], false);
    } catch (err) {
      try {
        if (app.canvas) app.canvas.selected_nodes = { [chain[last].id]: chain[last] };
      } catch (err2) {
        /* ignore */
      }
    }


    const names = chain.map(displayName);
    const flow = names.length <= 3 ? names.join(" → ") : `${names.slice(0, 2).join(" → ")} → … → ${names[last]}`;
    const parts = [`${flow}`, `接管 ${displayName(oldNode)} 的线：输入 ${madeIn}/${inRecs.length} · 输出 ${madeOut}/${outRecs.length}`];

    const reportCopied = publishReport(
      "串联替换",
      `链：${flow}　← 顶替 ${displayName(oldNode)}#${oldNode.id}`,
      [
        `结果：输入 ${madeIn}/${inRecs.length} · 输出 ${madeOut}/${outRecs.length}`,
        `跳过的类型：${skippedLive.length ? skippedLive.map((s) => `${s.type}(${s.node})`).join("、") : "无"}`,
        `跨过的节点：${detoured.length ? detoured.map((d) => `${d.type} 跳过 ${d.nodes.join("/")}`).join("、") : "无"}`,
        `断开的悬空线：${cutDead.length ? `${cutLabel(cutDead)}（${cutDead.length} 条）` : "无"}`,
        `失败条数：in ${failIn} · out ${failOut}`,
        "",
        "【替换前】",
        beforeText,
        "【替换后】",
        dumpText([...chain, oldNode], graph),
      ],
    );
    if (reportCopied) parts.push("连线报告已复制到剪贴板");
    if (topAdded) parts.push(`补连 ${topAdded} 条空口（${topPairs.map((p) => p.type).join("、")}）`);
    if (cutDead.length) parts.push(`断开了 ${cutDead.length} 条没下游的悬空线（${cutLabel(cutDead)}）`);

    if (skippedLive.length) {
      const uniq = [...new Set(skippedLive.map((s) => `${s.type}（${s.node}）`))];
      toast(
        "warn",
        `已串成 ${chain.length} 个节点的链，但有 ${skippedLive.length} 类线没接`,
        [...parts, `整类留在旧节点：${uniq.join("、")}`].join(" · "),
        11000,
      );
    } else if (failIn || failOut) {
      toast("warn", "串联完成，但部分连线没接上", [...parts, `没接上 ${failIn + failOut} 条`].join(" · "), 9000);
    } else {
      const byPass = detoured.length
        ? [`跨过：${detoured.map((d) => `${d.type} 跳过 ${d.nodes.join("/")}`).join("、")}`]
        : [];
      toast(
        "success",
        `已把 ${chain.length} 个节点串成一条链，顶替 ${displayName(oldNode)}`,
        [...parts, ...byPass].join(" · "),
        5500,
      );
    }

    console.log(LOG, "串联替换", { chain: names, old: displayName(oldNode), inRecs, outRecs, skipped });

    return true;
  } catch (err) {
    console.error(LOG, "串联替换出错", err);
    toast("error", "串联替换失败", String(err?.message ?? err));
    return false;
  } finally {
    endChange();
  }
}




function mergeReplace(nodes, newNode) {
  const graph = app.graph;
  if (!graph || !newNode || !nodes?.length) return false;

  const list = nodes.filter((n) => n && n.id !== newNode.id);
  if (!list.length) return false;
  if (list.length === 1) return replaceWithNode(list[0], newNode);

  const set = new Set(list.map((n) => n.id));


  const extIns = [];
  const extOuts = [];
  for (const n of list) {
    (n.inputs ?? []).forEach((s, i) => {
      const l = getLink(graph, s?.link);
      if (!l || set.has(l.origin_id)) return;
      extIns.push({ originId: l.origin_id, originSlot: l.origin_slot, type: l.type ?? s?.type, name: s?.name });
    });
    (n.outputs ?? []).forEach((s, i) => {
      for (const id of Array.isArray(s?.links) ? s.links : []) {
        const l = getLink(graph, id);
        if (!l || set.has(l.target_id)) return;
        extOuts.push({ targetId: l.target_id, targetSlot: l.target_slot, type: l.type ?? s?.type, name: s?.name });
      }
    });
  }

  if (!extIns.length && !extOuts.length) {
    toast("warn", "这批节点没有对外的连线", "它们只和彼此连着，合并后没有线可接。图没有改动。", 9000);
    return false;
  }

  const beforeText = dumpText([...list, newNode], graph);


  const right = [...list].sort((a, b) => (b.pos[0] + widthOf(b)) - (a.pos[0] + widthOf(a)))[0];
  const newPos = [right.pos[0], right.pos[1]];
  const rightOldPos = [newNode.pos[0], newNode.pos[1]];

  beginChange();
  try {
    newNode.pos = newPos;
    right.pos = rightOldPos;


    for (const n of list) {
      (n.inputs ?? []).forEach((s, i) => {
        if (s?.link === null || s?.link === undefined) return;
        try {
          n.disconnectInput(i);
        } catch (err) {
          /* ignore */
        }
      });
      (n.outputs ?? []).forEach((s, i) => {
        if (!Array.isArray(s?.links) || !s.links.length) return;
        try {
          n.disconnectOutput(i);
        } catch (err) {
          /* ignore */
        }
      });
    }


    let inDone = 0;
    let outDone = 0;
    let fail = 0;
    const usedIn = new Set();
    const seenIn = new Set();

    for (const r of extIns) {
      if (!r.type) {
        fail++;
        continue;
      }
      const key = `${r.originId}:${r.originSlot}:${typeKeyOf(r.type)}`;
      if (seenIn.has(key)) continue;
      seenIn.add(key);

      const src = graph.getNodeById(r.originId);
      if (!src) {
        fail++;
        continue;
      }

      const idx = (newNode.inputs ?? []).findIndex((s, i) => !usedIn.has(i) && compatible(s?.type, r.type));
      if (idx < 0) {
        fail++;
        continue;
      }
      usedIn.add(idx);

      try {
        const existing = newNode.inputs?.[idx]?.link;
        if (existing !== null && existing !== undefined) newNode.disconnectInput(idx);
      } catch (err) {
        /* ignore */
      }

      try {
        src.connect(r.originSlot, newNode, idx);
        inDone++;
      } catch (err) {
        console.warn(LOG, "合并：上游连接失败", r, err);
        fail++;
      }
    }


    const outSlotByKey = new Map();

    for (const r of extOuts) {
      if (!r.type) {
        fail++;
        continue;
      }
      const key = typeKeyOf(r.type);
      let idx = outSlotByKey.get(key);
      if (idx === undefined) {
        idx = (newNode.outputs ?? []).findIndex((s) => compatible(s?.type, r.type));
        outSlotByKey.set(key, idx);
      }
      if (idx < 0) {
        fail++;
        continue;
      }

      const tgt = graph.getNodeById(r.targetId);
      if (!tgt) {
        fail++;
        continue;
      }

      try {
        newNode.connect(idx, tgt, r.targetSlot);
        outDone++;
      } catch (err) {
        console.warn(LOG, "合并：下游连接失败", r, err);
        fail++;
      }
    }


    const top = topUpInputs(newNode, graph);

    for (const n of [newNode, ...list]) n.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);

    try {
      app.canvas?.selectNode?.(newNode, false);
    } catch (err) {
      /* ignore */
    }


    const names = list.map(displayName);
    const flow = names.length <= 3 ? names.join(" + ") : `${names.slice(0, 2).join(" + ")} 等 ${names.length} 个`;
    const parts = [
      `${flow} → ${displayName(newNode)}`,
      `外部连线 输入 ${inDone}/${extIns.length} · 输出 ${outDone}/${extOuts.length}`,
    ];
    if (top.added) parts.push(`补连 ${top.added} 条（${top.pairs.map((p) => p.type).join("、")}）`);

    const reportCopied = publishReport(
      "合并替换",
      `${flow} → ${displayName(newNode)}#${newNode.id}`,
      [
        `结果：外部输入 ${inDone}/${extIns.length} · 外部输出 ${outDone}/${extOuts.length}`,
        `没接上的条数：${fail}`,
        `补连：${top.added ? top.pairs.map((p) => `${p.from} → ${p.to}`).join("、") : "无"}`,
        "",
        "【替换前】",
        beforeText,
        "【替换后】",
        dumpText([newNode, ...list], graph),
      ],
    );
    if (reportCopied) parts.push("连线报告已复制到剪贴板");

    if (fail) {
      toast("warn", "合并完成，但部分连线没接上", [...parts, `没接上 ${fail} 条`].join(" · "), 10000);
    } else {
      toast("success", `已用 1 个节点合并顶替 ${list.length} 个`, parts.join(" · "), 7000);
    }

    console.log(LOG, "合并替换", { merged: names, into: displayName(newNode), extIns, extOuts, topUp: top });
    return true;
  } catch (err) {
    console.error(LOG, "合并替换出错", err);
    toast("error", "合并替换失败", String(err?.message ?? err));
    return false;
  } finally {
    endChange();
  }
}




function isUpstreamOf(upper, lower, graph) {
  if (!upper || !lower || !graph || upper.id === lower.id) return false;

  const seen = new Set([lower.id]);
  const stack = [lower];
  let guard = 0;

  while (stack.length && guard++ < 4000) {
    const n = stack.pop();
    for (const s of n?.inputs ?? []) {
      const l = getLink(graph, s?.link);
      if (!l) continue;
      if (l.origin_id === upper.id) return true;
      if (seen.has(l.origin_id)) continue;
      seen.add(l.origin_id);
      const prev = graph.getNodeById(l.origin_id);
      if (prev) stack.push(prev);
    }
  }
  return false;
}


function orderPair(a, b, graph) {
  const g = graph ?? app.graph;
  if (isUpstreamOf(a, b, g)) return [a, b];
  if (isUpstreamOf(b, a, g)) return [b, a];
  return null;
}


function swapSideRecords(node, graph, pairIds) {
  const ins = [];
  const outs = [];

  (node.inputs ?? []).forEach((s, i) => {
    const l = getLink(graph, s?.link);
    if (!l || pairIds.has(l.origin_id)) return;
    ins.push({
      slot: i,
      name: s?.name,
      type: s?.type ?? l.type,
      originId: l.origin_id,
      originSlot: l.origin_slot,
    });
  });

  (node.outputs ?? []).forEach((s, i) => {
    for (const id of Array.isArray(s?.links) ? s.links : []) {
      const l = getLink(graph, id);
      if (!l || pairIds.has(l.target_id)) continue;
      outs.push({
        slot: i,
        name: s?.name,
        type: s?.type ?? l.type,
        targetId: l.target_id,
        targetSlot: l.target_slot,
      });
    }
  });

  return { ins, outs };
}


function internalLinks(early, late, graph) {
  const out = [];
  (early.outputs ?? []).forEach((s, i) => {
    for (const id of Array.isArray(s?.links) ? s.links : []) {
      const l = getLink(graph, id);
      if (!l || l.target_id !== late.id) continue;
      out.push({
        slot: i,
        name: s?.name,



        targetName: late.inputs?.[l.target_slot]?.name,
        type: s?.type ?? l.type,
        targetSlot: l.target_slot,
      });
    }
  });
  return out;
}


function nameRank(slotName, preferName) {
  if (!preferName) return 2;
  const list = Array.isArray(preferName) ? preferName : [preferName];
  const n = normName(slotName);
  for (let k = 0; k < list.length; k++) {
    if (list[k] && normName(list[k]) === n) return k;
  }
  return 2;
}


function pickSlot(node, isInput, type, used, preferName) {
  const graph = app.graph;
  const slots = (isInput ? node.inputs : node.outputs) ?? [];
  const cands = [];

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s) continue;
    if (used?.has(`${isInput ? "i" : "o"}${i}`)) continue;
    if (!compatible(s.type, type)) continue;



    let stolen = 0;
    if (isInput && s.link !== null && s.link !== undefined) {
      const l = getLink(graph, s.link);
      if (l && !compatible(l.type, type)) stolen = 1000;
    }

    const wildcard = typeTokens(s.type).includes("*");
    cands.push({ i, score: stolen + (wildcard ? 10 : 0) + nameRank(s.name, preferName) });
  }

  if (!cands.length) return -1;
  cands.sort((x, y) => x.score - y.score || x.i - y.i);
  return cands[0].i;
}


function allocSlots(node, isInput, type, recs, used, label, nameOf) {
  const slots = [];
  for (const r of recs) {
    const s = pickSlot(node, isInput, type, used, nameOf ? nameOf(r) : r.name);
    if (s < 0) return { slots: [], bad: `${displayName(node)} 没有 ${type} ${label}` };
    used.add(`${isInput ? "i" : "o"}${s}`);
    slots.push(s);
  }
  return { slots, bad: "" };
}


function bridgeSkipped(late, early, skippedKeys, graph, earlyDownIds) {
  const res = { fixed: [], left: [] };
  if (!skippedKeys?.length) return res;

  const skipSet = new Set(skippedKeys);


  const groups = new Map();
  (late.inputs ?? []).forEach((s, i) => {
    const l = getLink(graph, s?.link);
    if (!l) return;
    const key = typeKeyOf(s?.type ?? l.type);
    const g = groups.get(key) ?? { key, type: s?.type ?? l.type, recs: [] };
    g.recs.push({ slot: i, link: l });
    groups.set(key, g);
  });

  for (const g of groups.values()) {
    if (!skipSet.has(g.key)) continue;

    if (g.recs.length !== 1) {
      res.left.push({ type: String(g.type), why: `这类输入有 ${g.recs.length} 条，不知道该拿哪条` });
      continue;
    }

    const rec = g.recs[0];
    const S = graph.getNodeById(rec.link.origin_id);
    if (!S || S.id === early.id || S.id === late.id) {
      res.left.push({ type: String(g.type), why: "上游不是被跨过的那个节点" });
      continue;
    }


    if (!earlyDownIds?.has(S.id)) {
      res.left.push({ type: String(g.type), why: `${displayName(S)} 不是 ${displayName(early)} 的直接下游` });
      continue;
    }


    const sOut = S.outputs?.[rec.link.origin_slot];
    const sOutLinks = (Array.isArray(sOut?.links) ? sOut.links : []).filter((id) => getLink(graph, id));
    if (sOutLinks.length !== 1) {
      res.left.push({ type: String(g.type), why: `${displayName(S)} 的 ${String(g.type)} 还喂着别的节点` });
      continue;
    }


    const outSlots = [];
    (late.outputs ?? []).forEach((s, i) => {
      if (typeKeyOf(s?.type) !== g.key) return;
      const ids = (Array.isArray(s?.links) ? s.links : []).filter((id) => getLink(graph, id));
      if (ids.length) outSlots.push({ i, ids });
    });
    if (outSlots.length !== 1) {
      res.left.push({
        type: String(g.type),
        why: outSlots.length ? "这类输出分散在好几个口子上" : "这一侧没有这类输出，插不上去",
      });
      continue;
    }
    const outRec = outSlots[0];


    const sInLink = getLink(graph, S.inputs?.[rec.link.target_slot]?.link);
    if (!sInLink) {
      res.left.push({ type: String(g.type), why: `${displayName(S)} 的这类输入是空的（数据由它自己产出）` });
      continue;
    }


    const targets = outRec.ids.map((id) => getLink(graph, id)).filter(Boolean);
    try {
      late.disconnectInput(rec.slot);
      late.disconnectOutput(outRec.i);
      S.disconnectInput(rec.link.target_slot);

      const x = graph.getNodeById(sInLink.origin_id);
      if (x) x.connect(sInLink.origin_slot, late, rec.slot);
      late.connect(outRec.i, S, rec.link.target_slot);
      for (const t of targets) {
        const tgt = graph.getNodeById(t.target_id);
        if (tgt) S.connect(rec.link.origin_slot, tgt, t.target_slot);
      }
      res.fixed.push({ type: String(g.type), viaId: S.id });
    } catch (err) {
      console.warn(LOG, "换顺序：跳过类型摆正失败", g.type, err);
      res.left.push({ type: String(g.type), why: "重接时出错，保持原样" });
    }
  }

  return res;
}


function swapOrder(a, b) {
  const graph = app.graph;
  if (!graph || !a || !b) return false;

  if (a === b || a.id === b.id) {
    toast("warn", "不能自己换自己", "请选两个不同的节点。", 3500);
    return false;
  }

  closeChoice();

  const pair = orderPair(a, b, graph);
  if (!pair) {
    toast(
      "warn",
      "这两个节点不是一前一后",
      `${displayName(a)} 和 ${displayName(b)} 之间没有上下游通路，交换顺序没有意义。图没有改动。`,
      9000,
    );
    return false;
  }

  const [early, late] = pair;
  const pairIds = new Set([early.id, late.id]);
  const eRec = swapSideRecords(early, graph, pairIds);
  const lRec = swapSideRecords(late, graph, pairIds);
  const inner = internalLinks(early, late, graph);

  const all = [...eRec.ins, ...eRec.outs, ...lRec.ins, ...lRec.outs, ...inner];
  if (!all.length) {
    toast(
      "info",
      "这两个节点都没有连线",
      "没有上下游可以对调，只换了位置也没什么意义。图没有改动。",
      7000,
    );
    return false;
  }


  const keys = [];
  const seenKey = new Set();
  for (const r of all) {
    const k = typeKeyOf(r.type);
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    keys.push(k);
  }

  const plan = [];
  const skipped = [];
  const used = { eIn: new Set(), eOut: new Set(), lIn: new Set(), lOut: new Set() };

  for (const key of keys) {
    const eIn = eRec.ins.filter((r) => typeKeyOf(r.type) === key);
    const eOut = eRec.outs.filter((r) => typeKeyOf(r.type) === key);
    const lIn = lRec.ins.filter((r) => typeKeyOf(r.type) === key);
    const lOut = lRec.outs.filter((r) => typeKeyOf(r.type) === key);
    const inn = inner.filter((r) => typeKeyOf(r.type) === key);
    const type = (eIn[0] ?? eOut[0] ?? lIn[0] ?? lOut[0] ?? inn[0])?.type ?? "*";


    const t = {
      eIn: new Set(used.eIn),
      eOut: new Set(used.eOut),
      lIn: new Set(used.lIn),
      lOut: new Set(used.lOut),
    };

    const lateIn = allocSlots(late, true, type, eIn, t.lIn, "输入口");
    const earlyIn = allocSlots(early, true, type, lIn, t.eIn, "输入口");
    const lateOut = eOut.length || inn.length
      ? allocSlots(late, false, type, [eOut[0] ?? inn[0]], t.lOut, "输出口")
      : { slots: [], bad: "" };
    const earlyOut = lOut.length
      ? allocSlots(early, false, type, [lOut[0]], t.eOut, "输出口")
      : { slots: [], bad: "" };
    const innerIn = inn.length





      ? allocSlots(early, true, type, [inn[0]], t.eIn, "输入口", (r) => [r.targetName, r.name])
      : { slots: [], bad: "" };

    const bad = lateIn.bad || earlyIn.bad || lateOut.bad || earlyOut.bad || innerIn.bad;
    if (bad) {
      skipped.push({ key, type: String(type), reason: bad });
      continue;
    }

    used.eIn = t.eIn;
    used.eOut = t.eOut;
    used.lIn = t.lIn;
    used.lOut = t.lOut;

    plan.push({
      type,
      eIn,
      eOut,
      lIn,
      lOut,
      inn,
      lateInSlots: lateIn.slots,
      earlyInSlots: earlyIn.slots,
      lateOutSlot: lateOut.slots[0] ?? -1,
      earlyOutSlot: earlyOut.slots[0] ?? -1,
      innerEarlyIn: innerIn.slots[0] ?? -1,
    });
  }

  if (!plan.length) {
    toast(
      "warn",
      "口子对不上，没有可以对调的线",
      `${skipped.map((s) => `${s.type}：${s.reason}`).join("；")}。图没有改动。`,
      11000,
    );
    return false;
  }


  const earlyPos = [early.pos[0], early.pos[1]];
  const latePos = [late.pos[0], late.pos[1]];
  const beforeText = dumpText([early, late], graph);

  const cutEIn = new Set();
  const cutEOut = new Set();
  const cutLIn = new Set();
  const cutLOut = new Set();
  for (const p of plan) {
    for (const r of p.eIn) cutEIn.add(r.slot);
    for (const r of p.eOut) cutEOut.add(r.slot);
    for (const r of p.lIn) cutLIn.add(r.slot);
    for (const r of p.lOut) cutLOut.add(r.slot);
    for (const r of p.inn) {
      cutEOut.add(r.slot);
      cutLIn.add(r.targetSlot);
    }
  }

  beginChange();

  try {

    for (const i of cutEIn) {
      try {
        early.disconnectInput(i);
      } catch (err) {
        /* ignore */
      }
    }
    for (const i of cutEOut) {
      try {
        early.disconnectOutput(i);
      } catch (err) {
        /* ignore */
      }
    }
    for (const i of cutLIn) {
      try {
        late.disconnectInput(i);
      } catch (err) {
        /* ignore */
      }
    }
    for (const i of cutLOut) {
      try {
        late.disconnectOutput(i);
      } catch (err) {
        /* ignore */
      }
    }


    early.pos = latePos;
    late.pos = earlyPos;


    let madeIn = 0;
    let madeOut = 0;
    let failIn = 0;
    let failOut = 0;

    for (const p of plan) {
      for (let i = 0; i < p.eIn.length; i++) {
        const r = p.eIn[i];
        const src = graph.getNodeById(r.originId);
        const to = p.lateInSlots[i];
        if (!src || to === undefined || to < 0) {
          failIn++;
          continue;
        }
        try {
          src.connect(r.originSlot, late, to);
          madeIn++;
        } catch (err) {
          console.warn(LOG, "换顺序：上游→后者 失败", r, err);
          failIn++;
        }
      }

      for (let i = 0; i < p.lIn.length; i++) {
        const r = p.lIn[i];
        const src = graph.getNodeById(r.originId);
        const to = p.earlyInSlots[i];
        if (!src || to === undefined || to < 0) {
          failIn++;
          continue;
        }
        try {
          src.connect(r.originSlot, early, to);
          madeIn++;
        } catch (err) {
          console.warn(LOG, "换顺序：上游→前者 失败", r, err);
          failIn++;
        }
      }

      for (const r of p.eOut) {
        const tgt = graph.getNodeById(r.targetId);
        if (!tgt || p.lateOutSlot < 0) {
          failOut++;
          continue;
        }
        try {
          late.connect(p.lateOutSlot, tgt, r.targetSlot);
          madeOut++;
        } catch (err) {
          console.warn(LOG, "换顺序：后者→下游 失败", r, err);
          failOut++;
        }
      }

      for (const r of p.lOut) {
        const tgt = graph.getNodeById(r.targetId);
        if (!tgt || p.earlyOutSlot < 0) {
          failOut++;
          continue;
        }
        try {
          early.connect(p.earlyOutSlot, tgt, r.targetSlot);
          madeOut++;
        } catch (err) {
          console.warn(LOG, "换顺序：前者→下游 失败", r, err);
          failOut++;
        }
      }


      if (p.inn.length) {
        if (p.lateOutSlot < 0 || p.innerEarlyIn < 0) {
          failIn++;
        } else {
          try {
            late.connect(p.lateOutSlot, early, p.innerEarlyIn);
            madeIn++;
          } catch (err) {
            console.warn(LOG, "换顺序：反向重连失败", p.type, err);
            failIn++;
          }
        }
      }
    }

    for (const n of [early, late]) n.setDirtyCanvas?.(true, true);
    graph.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);



    const bridged = bridgeSkipped(
      late,
      early,
      skipped.map((s) => s.key),
      graph,
      new Set(eRec.outs.map((r) => r.targetId)),
    );


    const skipKeys = new Set(skipped.map((s) => s.key));
    const cutDead = [...cutDanglingInputs(early, graph, skipKeys), ...cutDanglingInputs(late, graph, skipKeys)];

    try {
      app.canvas?.selectNode?.(early, false);
    } catch (err) {
      /* ignore */
    }

    const typeNames = plan.map((p) => String(p.type)).join("、");
    const parts = [
      `${displayName(early)} ⇄ ${displayName(late)}`,
      `对调 ${plan.length} 类（${typeNames}）：上游 ${madeIn} 条 · 下游 ${madeOut} 条`,
    ];

    const bridgedKeys = new Set(bridged.fixed.map((f) => typeKeyOf(f.type)));
    const skippedLive = skipped.filter(
      (s) => !cutDead.some((c) => c.key === s.key) && !bridgedKeys.has(s.key),
    );
    if (bridged.fixed.length) {
      parts.push(
        `摆正了跳过类型：${bridged.fixed
          .map((f) => `${f.type} 也换到了 ${displayName(graph.getNodeById(f.viaId))} 之前`)
          .join("、")}`,
      );
    }
    if (skippedLive.length) {
      parts.push(`留在原节点：${skippedLive.map((s) => `${s.type}（${s.reason}）`).join("、")}`);
    }
    if (bridged.left.length) {
      parts.push(`没能摆正：${bridged.left.map((l) => `${l.type}（${l.why}）`).join("、")}`);
    }
    if (cutDead.length) parts.push(`断开了 ${cutDead.length} 条没下游的悬空线（${cutLabel(cutDead)}）`);

    const reportCopied = publishReport(
      "交换顺序",
      `${displayName(early)}#${early.id} ⇄ ${displayName(late)}#${late.id}　（原来 ${displayName(early)} 在前）`,
      [
        `对调的类型：${typeNames}`,
        `结果：上游 ${madeIn} 条 · 下游 ${madeOut} 条 · 没接上 ${failIn + failOut} 条`,
        `没动的类型：${skippedLive.length ? skippedLive.map((s) => `${s.type}（${s.reason}）`).join("、") : "无"}`,
        `摆正的跳过类型：${bridged.fixed.length
          ? bridged.fixed.map((f) => `${f.type}（也换到了 ${displayName(graph.getNodeById(f.viaId))}#${f.viaId} 之前）`).join("、")
          : "无"}`,
        `没能摆正：${bridged.left.length ? bridged.left.map((l) => `${l.type}（${l.why}）`).join("、") : "无"}`,
        `断开的悬空线：${cutDead.length ? `${cutLabel(cutDead)}（${cutDead.length} 条）` : "无"}`,
        "",
        "【交换前】",
        beforeText,
        "【交换后】",
        dumpText([early, late], graph),
      ],
    );
    if (reportCopied) parts.push("连线报告已复制到剪贴板");

    if (failIn || failOut) {
      toast("warn", "顺序换了，但有线没接上", parts.join(" · "), 11000);
    } else {
      toast("success", "顺序已对调", parts.join(" · "), 7000);
    }

    console.log(LOG, "交换顺序", { early: displayName(early), late: displayName(late), plan, skipped });
    return true;
  } catch (err) {
    console.error(LOG, "交换顺序出错", err);
    toast("error", "交换顺序失败", String(err?.message ?? err));
    return false;
  } finally {
    endChange();
  }
}



function cloneNode(src) {
  try {
    if (typeof src.clone !== "function") return null;
    const c = src.clone();
    if (!c) return null;
    app.graph.add(c);
    return c;
  } catch (err) {
    console.warn(LOG, "克隆节点失败", err);
    return null;
  }
}

function batchReplace(oldNodes, protoNode) {
  let ok = 0;
  let bad = 0;

  oldNodes.forEach((old, idx) => {
    if (idx === 0) {
      if (replaceWithNode(old, protoNode)) ok++;
      else bad++;
      return;
    }
    const c = cloneNode(protoNode);
    if (!c) {
      bad++;
      return;
    }
    if (replaceWithNode(old, c)) ok++;
    else bad++;
  });

  if (bad > 0) {
    toast("warn", "批量替换未全部成功", `成功 ${ok} 个，失败 ${bad} 个`, 8000);
  } else if (oldNodes.length > 1) {
    toast("success", `已替换 ${ok} 个节点`, "其余为克隆副本，参数与原型一致", 5000);
  }
}



let newMenuApiUsed = false;





const MENU_I18N = {
  zh: { replace: "替换节点" },
  en: { replace: "Replace node" },
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
  return MENU_I18N[menuLang()].replace;
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


function fillTpl(tpl, map) {
  return String(tpl).replace(/\{([A-Za-z]+)\}/g, (m, k) => (map[k] ?? m));
}

function entryText(el) {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}


function currentMenuRoot() {
  const label = menuText();
  const roots = [...document.querySelectorAll(".litecontextmenu")];
  let hit = null;
  for (const root of roots) {
    const entries = [...root.querySelectorAll(".litemenu-entry")];
    if (entries.some((el) => entryText(el).includes(label))) hit = root;
  }
  return hit;
}


function moveNearAnchor() {
  const root = currentMenuRoot();
  if (!root) return false;

  const label = menuText();
  const entries = [...root.querySelectorAll(".litemenu-entry")];
  const ours = entries.find((el) => entryText(el).includes(label));
  if (!ours) return true;

  const parent = ours.parentElement;
  if (!parent) return true;


  const anchor = [...parent.children].find(
    (el) =>
      el !== ours &&
      !el.classList.contains("separator") &&
      ANCHOR_RE.test(entryText(el))
  );

  const target = anchor ? anchor.nextElementSibling : parent.firstElementChild;
  if (target === ours) return true;

  try {
    if (anchor) {
      parent.insertBefore(ours, anchor.nextElementSibling);
    } else {

      parent.insertBefore(ours, parent.firstElementChild);
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


function dumpMenu() {
  const root = currentMenuRoot() || document.querySelector(".litecontextmenu");
  if (!root) return console.log(LOG, "当前没有打开的右键菜单");
  const list = [...root.querySelectorAll(".litemenu-entry")].map((el, i) => `${i}. ${entryText(el)}`);
  console.log(`${LOG} 菜单条目：\n` + list.join("\n"));
  return list;
}

function buildMenuItem(contextNode) {
  const sel = selectedNodes();
  const selIds = new Set(sel.map((n) => n.id));
  const count = contextNode && !selIds.has(contextNode.id) ? 1 : sel.length;

  let content = `🔄 ${menuText()}…`;
  if (count > 1) {
    content += menuLang() === "zh" ? `（将替换 ${count} 个）` : ` (replacing ${count} nodes)`;
  }

  return {
    content,
    callback: () => arm(contextNode),
  };
}


function patchLegacyMenu() {
  let proto = null;
  try {
    proto = app.canvas?.constructor?.prototype ?? LG()?.LGraphCanvas?.prototype ?? null;
  } catch (err) {
    proto = null;
  }
  if (!proto || typeof proto.getNodeMenuOptions !== "function") return false;
  if (proto.__cnrPatched) return true;

  const original = proto.getNodeMenuOptions;
  proto.getNodeMenuOptions = function (node) {
    const options = original.apply(this, arguments) || [];
    if (!newMenuApiUsed && node) {
      options.push(null);
      options.push(buildMenuItem(node));
      scheduleMenuReposition();
    }
    return options;
  };
  proto.__cnrPatched = true;
  return true;
}

app.registerExtension({
  name: EXT_NAME,

  async setup() {
    patchLegacyMenu();

    window.cnr = {
      dumpMenu,
      moveNearAnchor,
      linkCountOf,

      links() {
        return selectedNodes().map((n) => ({ id: n.id, name: displayName(n), links: linkCountOf(n) }));
      },


      dump() {
        const g = app.graph;
        const nodes = selectedNodes();
        const list = nodes.length ? nodes : (g?._nodes ?? []);
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

      last() {
        return lastReport ?? "还没有执行过替换。";
      },

      copy() {
        if (!lastReport) return "还没有执行过替换。";
        try {
          globalThis.navigator?.clipboard?.writeText(lastReport);
          return "已复制";
        } catch (err) {
          return String(err);
        }
      },

      swap(a, b) {
        return swapOrder(a, b);
      },
      pair(a, b) {
        const p = orderPair(a, b, app.graph);
        return p ? `一前一后：${displayName(p[0])} → ${displayName(p[1])}` : "没有上下游通路";
      },
      get version() {
        return VERSION;
      },
    };

    const cleanedMarks = cleanBakedMarks(app.graph);
    if (cleanedMarks) {
      console.log(`${LOG} 清掉 ${cleanedMarks} 个残留的橙色标记（v3.13.0 及更早写进工作流的）`);
    }

    console.log(
      `${LOG} v${VERSION} 已加载 — 右键节点 → 替换节点…，然后左键点另一个节点`
        + `（多选后再点：弹面板选「合并成一个」或「分别替换」；两个一前一后：可「交换顺序」）`,
    );
  },


  loadedGraphNode(node) {
    if (node && String(node.boxcolor ?? "").toLowerCase() === MARK_COLOR) {
      node.boxcolor = null;
      node.setDirtyCanvas?.(true, true);
    }
  },


  getNodeMenuItems(node) {
    newMenuApiUsed = true;
    if (!node) return [];
    scheduleMenuReposition();
    return [buildMenuItem(node)];
  },


  getCanvasMenuItems() {
    if (!selectedNodes().length) return [];
    return [buildMenuItem(null)];
  },
});
