/**
 * Pure H5 SWF Scene & Timeline Renderer (SVG + WebAudio)
 * - Zero Flash dependency
 * - Properly flattens clipDepth masks into <clipPath> without nested <g>
 * - Preserves matrix/cxform/name across character replacements at the same depth (SWF PlaceObject2 Move+HasCharacter)
 * - Supports DefineMorphShape ratio interpolation for both visible morphs and clipDepth masks
 * - Properly cleans up child MovieClip instances on remove/frame rebuild
 */
(function (global) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const XLINK_NS = "http://www.w3.org/1999/xlink";

  function el(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    return node;
  }

  function matrixToCss(m) {
    if (!m) return null;
    return `matrix(${m[0]} ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]})`;
  }

  function morphTransformCss(morphMeta, ratio) {
    if (!morphMeta || ratio === undefined || ratio === null) return "";
    const r = Math.max(0, Math.min(1, ratio / 65535));
    if (r >= 0.999) return "";
    const [sx0, sy0, sx1, sy1] = morphMeta.startBounds;
    const [ex0, ey0, ex1, ey1] = morphMeta.endBounds;
    const ew = ex1 - ex0;
    const eh = ey1 - ey0;
    if (ew <= 0.01 && eh <= 0.01) return "";
    const curX0 = sx0 + (ex0 - sx0) * r;
    const curY0 = sy0 + (ey0 - sy0) * r;
    const curW = (sx1 - sx0) + (ew - (sx1 - sx0)) * r;
    const curH = (sy1 - sy0) + (eh - (sy1 - sy0)) * r;
    const scaleX = ew > 0.05 ? curW / ew : 1;
    const scaleY = eh > 0.05 ? curH / eh : 1;
    const tx = curX0 - ex0 * scaleX;
    const ty = curY0 - ey0 * scaleY;
    return `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)})`;
  }

  function isIdentityCxform(cx) {
    if (!cx) return true;
    const { mult, add } = cx;
    return (
      mult[0] === 1 && mult[1] === 1 && mult[2] === 1 && mult[3] === 1 &&
      add[0] === 0 && add[1] === 0 && add[2] === 0 && add[3] === 0
    );
  }

  function isAlphaOnlyCxform(cx) {
    if (!cx) return true;
    const { mult, add } = cx;
    return (
      mult[0] === 1 && mult[1] === 1 && mult[2] === 1 &&
      add[0] === 0 && add[1] === 0 && add[2] === 0 && add[3] === 0
    );
  }

  class AudioManager {
    constructor(basePath) {
      this.basePath = basePath;
      this.ctx = null;
      this.buffers = new Map();
      this.activeStreams = new Map();
    }

    ensureContext() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    async loadSound(file) {
      if (!file) return null;
      if (this.buffers.has(file)) return this.buffers.get(file);
      const url = `${this.basePath}/assets/audio/${file}`;
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const arr = await res.arrayBuffer();
        const ctx = this.ensureContext();
        if (!ctx) return null;
        const buf = await ctx.decodeAudioData(arr);
        this.buffers.set(file, buf);
        return buf;
      } catch (e) {
        return null;
      }
    }

    async playEffect(file) {
      if (!file) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const buf = await this.loadSound(file);
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    }

    createStreamAudio(file) {
      if (!file) return null;
      const audio = new Audio(`${this.basePath}/assets/audio/${file}`);
      audio.preload = "auto";
      this.activeStreams.set(file, audio);
      return audio;
    }

    stopAll() {
      for (const a of this.activeStreams.values()) {
        try {
          a.pause();
          a.currentTime = 0;
        } catch (_) {}
      }
      this.activeStreams.clear();
    }
  }

  let rendererSeq = 0;

  class SwfSceneRenderer {
    constructor(svgEl, basePath, scene, frameScriptsByCid = {}) {
      this.idPrefix = `r${++rendererSeq}_`;
      this.svg = svgEl;
      this.basePath = basePath;
      this.scene = scene;
      this.frameScriptsByCid = frameScriptsByCid || {};
      this.audio = new AudioManager(basePath);
      this.shapeCache = new Map(); // cid -> { defsNodes, bodyNodes }
      this.clipCache = new Map(); // `${cid}|${mStr}|${rStr}` -> clipId
      this.filterCount = 0;
      this.clipCount = 0;
      this.clips = [];
      this.rootMc = null;
      this.rafId = null;
      this.lastTick = 0;

      this.svg.setAttribute("viewBox", `0 0 ${scene.width} ${scene.height}`);
      this.svg.innerHTML = "";
      this.defs = el("defs");
      this.svg.appendChild(this.defs);

      // Background rect
      this.bgRect = el("rect", {
        x: 0,
        y: 0,
        width: scene.width,
        height: scene.height,
        fill: scene.bgColor || "#ffffff",
      });
      this.svg.appendChild(this.bgRect);

      this.stageGroup = el("g", { id: "stage-root" });
      this.svg.appendChild(this.stageGroup);
    }

    async preloadAssets() {
      const parser = new DOMParser();
      const items = [];

      const collectSvgMap = (metaMap) => {
        for (const [cid, info] of Object.entries(metaMap || {})) {
          items.push({ cid: Number(cid), url: `${this.basePath}/assets/shapes/${info.file}` });
        }
      };

      collectSvgMap(this.scene.shapes);
      collectSvgMap(this.scene.texts);

      const loadOne = async ({ cid, url }) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await fetch(url, { cache: "no-store" });
            if (!r.ok) continue;
            const txt = await r.text();
            if (!txt) return;
            const prefixedTxt = txt
              .replace(/\bid="(grad_[^"]+|pat_[^"]+)"/g, (_, id) => `id="${this.idPrefix}${id}"`)
              .replace(/url\(#(grad_[^)]+|pat_[^)]+)\)/g, (_, id) => `url(#${this.idPrefix}${id})`);
            const doc = parser.parseFromString(prefixedTxt, "image/svg+xml");
            const svgRoot = doc.documentElement;
            const defsNodes = [];
            const bodyNodes = [];
            for (const child of Array.from(svgRoot.childNodes)) {
              if (child.nodeType !== 1) continue;
              if (child.tagName.toLowerCase() === "defs") {
                for (const dc of Array.from(child.children)) {
                  const imgs = dc.querySelectorAll("image");
                  imgs.forEach((im) => {
                    const href = im.getAttribute("href") || im.getAttributeNS(XLINK_NS, "href");
                    if (href && !href.startsWith("http") && !href.startsWith("data:")) {
                      const fname = href.split("/").pop();
                      im.setAttribute("href", `${this.basePath}/assets/images/${fname}`);
                    }
                  });
                  defsNodes.push(document.importNode(dc, true));
                }
              } else {
                bodyNodes.push(document.importNode(child, true));
              }
            }
            this.shapeCache.set(cid, { defsNodes, bodyNodes });
            return;
          } catch (_) {
            await new Promise((res) => setTimeout(res, 50 * (attempt + 1)));
          }
        }
      };

      const concurrency = Math.min(12, items.length || 1);
      let cursor = 0;
      const workers = Array.from({ length: concurrency }, async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          await loadOne(item);
        }
      });
      await Promise.all(workers);

      const seenIds = new Set();
      for (const entry of this.shapeCache.values()) {
        for (const dn of entry.defsNodes) {
          const id = dn.getAttribute("id");
          if (id && seenIds.has(id)) continue;
          if (id) seenIds.add(id);
          this.defs.appendChild(dn);
        }
      }
    }

    mountRoot() {
      this.rootMc = new SwfMovieClip(this, this.scene.root, "root", this.stageGroup, 0, null);
      this.rootMc.gotoAndStop(1);
      this.startLoop();
      return this.rootMc;
    }

    startLoop() {
      if (this.rafId) return;
      const fps = this.scene.fps || 24;
      const frameMs = 1000 / fps;
      this.lastTick = performance.now();
      const tick = (now) => {
        this.rafId = requestAnimationFrame(tick);
        if (now - this.lastTick >= frameMs) {
          this.lastTick = now - ((now - this.lastTick) % frameMs);
          // Snapshot clips array so mid-tick removals/additions are safe
          const snapshot = this.clips.slice();
          for (const mc of snapshot) {
            if (!mc._destroyed) mc._tick();
          }
        }
      };
      this.rafId = requestAnimationFrame(tick);
    }

    unregisterClipTree(mc) {
      if (!mc || mc._destroyed) return;
      mc._destroyed = true;
      mc.stop();
      const idx = this.clips.indexOf(mc);
      if (idx >= 0) this.clips.splice(idx, 1);
      for (const rec of mc.depthMap.values()) {
        if (rec.mc) this.unregisterClipTree(rec.mc);
      }
    }

    destroy() {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.audio.stopAll();
      this.clips = [];
      this.svg.innerHTML = "";
    }

    applyCxform(node, cx) {
      if (!cx || isIdentityCxform(cx)) {
        node.removeAttribute("opacity");
        node.removeAttribute("filter");
        return;
      }
      if (isAlphaOnlyCxform(cx)) {
        const a = Math.max(0, Math.min(1, cx.mult[3]));
        node.setAttribute("opacity", String(a));
        node.removeAttribute("filter");
        return;
      }
      const { mult, add } = cx;
      const fid = `${this.idPrefix}cxf_${++this.filterCount}`;
      const flt = el("filter", { id: fid, "color-interpolation-filters": "sRGB" });
      const mat = [
        mult[0], 0, 0, 0, add[0] / 255,
        0, mult[1], 0, 0, add[1] / 255,
        0, 0, mult[2], 0, add[2] / 255,
        0, 0, 0, mult[3], add[3] / 255,
      ].join(" ");
      flt.appendChild(el("feColorMatrix", { type: "matrix", values: mat }));
      this.defs.appendChild(flt);
      node.setAttribute("filter", `url(#${fid})`);
    }

    /**
     * Flatten geometric elements from a shape/morph/sprite into a <clipPath>
     * (NO nested <g> inside <clipPath>!)
     */
    buildClipPath(cid, matrix, ratio = null) {
      const mStr = matrixToCss(matrix) || "";
      const morphMeta = this.scene.morphs && this.scene.morphs[cid];
      const morphT = morphMeta ? morphTransformCss(morphMeta, ratio ?? 65535) : "";
      const baseTransform = [mStr, morphT].filter(Boolean).join(" ");
      const cacheKey = `${cid}|${baseTransform}`;
      if (this.clipCache.has(cacheKey)) {
        return this.clipCache.get(cacheKey);
      }
      const clipId = `${this.idPrefix}clip_${++this.clipCount}`;
      const cp = el("clipPath", {
        id: clipId,
        clipPathUnits: "userSpaceOnUse",
      });

      const flattenShape = (shapeCid, extraTransform) => {
        const cached = this.shapeCache.get(Number(shapeCid));
        if (!cached) return;
        for (const bn of cached.bodyNodes) {
          const tag = bn.tagName.toLowerCase();
          if (["path", "rect", "circle", "ellipse", "polygon", "polyline"].includes(tag)) {
            const clone = bn.cloneNode(true);
            const ownT = clone.getAttribute("transform") || "";
            const combined = [extraTransform, ownT].filter(Boolean).join(" ");
            if (combined) clone.setAttribute("transform", combined);
            cp.appendChild(clone);
          } else if (tag === "g") {
            const gT = bn.getAttribute("transform") || "";
            const subT = [extraTransform, gT].filter(Boolean).join(" ");
            for (const sub of Array.from(bn.children)) {
              const stag = sub.tagName.toLowerCase();
              if (["path", "rect", "circle", "ellipse", "polygon", "polyline"].includes(stag)) {
                const clone = sub.cloneNode(true);
                const ownT = clone.getAttribute("transform") || "";
                const combined = [subT, ownT].filter(Boolean).join(" ");
                if (combined) clone.setAttribute("transform", combined);
                cp.appendChild(clone);
              }
            }
          }
        }
      };

      if (this.shapeCache.has(Number(cid))) {
        flattenShape(cid, baseTransform);
      } else if (this.scene.sprites[cid]) {
        const sp = this.scene.sprites[cid];
        if (sp.frames && sp.frames[0]) {
          for (const act of sp.frames[0].actions) {
            if (act.op === "place" && act.cid) {
              const sm = matrixToCss(act.matrix);
              const combined = [baseTransform, sm].filter(Boolean).join(" ");
              flattenShape(act.cid, combined);
            }
          }
        }
      }

      this.defs.appendChild(cp);
      this.clipCache.set(cacheKey, clipId);
      return clipId;
    }

    createDisplayObject(cid, name, matrix, cxform, parentMc = null, ratio = null) {
      const g = el("g");
      if (name) g.setAttribute("data-name", name);
      const morphMeta = this.scene.morphs && this.scene.morphs[cid];
      const mStr = matrixToCss(matrix) || "";
      const morphT = morphMeta ? morphTransformCss(morphMeta, ratio) : "";
      const fullTransform = [mStr, morphT].filter(Boolean).join(" ");
      if (fullTransform) g.setAttribute("transform", fullTransform);
      if (cxform) this.applyCxform(g, cxform);

      let mcInstance = null;
      if (this.shapeCache.has(Number(cid))) {
        const cached = this.shapeCache.get(Number(cid));
        for (const bn of cached.bodyNodes) {
          g.appendChild(bn.cloneNode(true));
        }
      } else if (this.scene.images[cid]) {
        const info = this.scene.images[cid];
        g.appendChild(
          el("image", {
            href: `${this.basePath}/assets/images/${info.file}`,
            width: info.w || undefined,
            height: info.h || undefined,
          })
        );
      } else if (this.scene.buttons[cid]) {
        this._populateButton(g, this.scene.buttons[cid]);
      } else if (this.scene.sprites[cid]) {
        mcInstance = new SwfMovieClip(this, this.scene.sprites[cid], name || `sp_${cid}`, g, Number(cid), parentMc);
        mcInstance.gotoAndPlay(1);
      }

      return { node: g, mc: mcInstance };
    }

    _populateButton(g, btnStates) {
      g.classList.add("swf-btn");
      const upG = el("g", { class: "btn-up" });
      const overG = el("g", { class: "btn-over", style: "display:none" });
      const downG = el("g", { class: "btn-down", style: "display:none" });
      const hitG = el("g", { class: "btn-hit", opacity: "0", style: "pointer-events:all" });

      const fillState = (container, list) => {
        for (const rec of list || []) {
          const obj = this.createDisplayObject(rec.cid, null, rec.matrix, rec.cxform);
          container.appendChild(obj.node);
        }
      };

      fillState(upG, btnStates.up);
      fillState(overG, btnStates.over.length ? btnStates.over : btnStates.up);
      fillState(downG, btnStates.down.length ? btnStates.down : (btnStates.over.length ? btnStates.over : btnStates.up));
      fillState(hitG, btnStates.hit.length ? btnStates.hit : btnStates.up);

      g.appendChild(upG);
      g.appendChild(overG);
      g.appendChild(downG);
      g.appendChild(hitG);

      g.addEventListener("mouseenter", () => {
        upG.style.display = "none";
        overG.style.display = "";
        downG.style.display = "none";
      });
      g.addEventListener("mouseleave", () => {
        upG.style.display = "";
        overG.style.display = "none";
        downG.style.display = "none";
      });
      g.addEventListener("mousedown", () => {
        upG.style.display = "none";
        overG.style.display = "none";
        downG.style.display = "";
      });
      g.addEventListener("mouseup", () => {
        upG.style.display = "none";
        overG.style.display = "";
        downG.style.display = "none";
      });
    }
  }

  class SwfMovieClip {
    constructor(renderer, tlData, name, groupEl, cid = 0, parentMc = null) {
      this.renderer = renderer;
      this.tl = tlData;
      this.name = name;
      this.el = groupEl;
      this.cid = cid;
      this.parentMc = parentMc;
      this._destroyed = false;
      this.frameScripts = renderer.frameScriptsByCid[cid] || null;
      this.totalFrames = tlData.frameCount || 1;
      this.currentFrame = 1; // 1-based
      this.playing = false;
      this.depthMap = new Map(); // depth -> { cid, name, matrix, cxform, clipDepth, ratio, node, mc }
      this.namedChildren = new Map(); // name -> rec
      this.streamAudio = tlData.streamAudio ? renderer.audio.createStreamAudio(tlData.streamAudio) : null;
      this.onFrameChange = null;
      this.onEnd = null;
      renderer.clips.push(this);
    }

    getChild(name) {
      return this.namedChildren.get(name) || null;
    }

    play() {
      this.playing = true;
      if (this.streamAudio) {
        const targetTime = (this.currentFrame - 1) / (this.renderer.scene.fps || 24);
        if (Math.abs(this.streamAudio.currentTime - targetTime) > 0.25) {
          this.streamAudio.currentTime = targetTime;
        }
        this.streamAudio.play().catch(() => {});
      }
    }

    stop() {
      this.playing = false;
      if (this.streamAudio) {
        this.streamAudio.pause();
      }
    }

    gotoAndStop(frame1Based) {
      this.stop();
      this._renderFrame(frame1Based);
    }

    gotoAndPlay(frame1Based) {
      this._renderFrame(frame1Based);
      this.play();
    }

    nextFrame() {
      this.gotoAndStop(Math.min(this.totalFrames, this.currentFrame + 1));
    }

    prevFrame() {
      this.gotoAndStop(Math.max(1, this.currentFrame - 1));
    }

    _tick() {
      if (!this.playing || this._destroyed) return;
      if (this.totalFrames <= 1) return;
      let next = this.currentFrame + 1;
      if (next > this.totalFrames) {
        if (this.onEnd) {
          this.onEnd();
        }
        next = 1;
        if (this.streamAudio) {
          this.streamAudio.currentTime = 0;
        }
      }
      this._renderFrame(next, true);
      if (this.onFrameChange) this.onFrameChange(this.currentFrame, this.totalFrames);
    }

    _renderFrame(frame1Based, isStepping = false) {
      const target = Math.max(1, Math.min(this.totalFrames, Math.floor(frame1Based)));
      if (!this.tl.frames || this.tl.frames.length === 0) return;

      if (isStepping && target === this.currentFrame + 1) {
        this._applyFrameActions(this.tl.frames[target - 1], true);
        this.currentFrame = target;
        this._rebuildDomOrder();
        this._runFrameScript(target);
        return;
      }

      // Compute cumulative logical depth state for frames 0..target-1 without creating intermediate DOM nodes
      const desiredDepths = new Map();
      for (let i = 0; i < target; i++) {
        const frame = this.tl.frames[i];
        if (!frame) continue;
        for (const act of frame.actions || []) {
          if (act.op === "remove") {
            desiredDepths.delete(act.depth);
          } else if (act.op === "place") {
            const prev = desiredDepths.get(act.depth);
            if (act.cid !== undefined) {
              // SWF PlaceObject2 Move+HasCharacter: inherit matrix, cxform, name, clipDepth from prev if omitted
              desiredDepths.set(act.depth, {
                cid: act.cid,
                name: act.name !== undefined ? act.name : (prev ? prev.name : null),
                matrix: act.matrix !== undefined ? act.matrix : (prev ? prev.matrix : null),
                cxform: act.cxform !== undefined ? act.cxform : (prev ? prev.cxform : null),
                clipDepth: act.clipDepth !== undefined ? act.clipDepth : (prev ? prev.clipDepth : 0),
                ratio: act.ratio !== undefined ? act.ratio : (prev ? prev.ratio : null),
              });
            } else if (prev) {
              if (act.matrix !== undefined) prev.matrix = act.matrix;
              if (act.cxform !== undefined) prev.cxform = act.cxform;
              if (act.name !== undefined) prev.name = act.name;
              if (act.clipDepth !== undefined) prev.clipDepth = act.clipDepth;
              if (act.ratio !== undefined) prev.ratio = act.ratio;
            }
          }
        }
      }

      // Unregister and remove any existing depths that are no longer present or changed cid
      for (const [depth, oldRec] of Array.from(this.depthMap.entries())) {
        const nextSpec = desiredDepths.get(depth);
        if (!nextSpec || nextSpec.cid !== oldRec.cid || Boolean(nextSpec.clipDepth) !== Boolean(oldRec.clipDepth)) {
          if (oldRec.mc) this.renderer.unregisterClipTree(oldRec.mc);
          this.depthMap.delete(depth);
        }
      }

      this.namedChildren.clear();

      // Materialize or update surviving depths
      for (const [depth, spec] of desiredDepths.entries()) {
        const existing = this.depthMap.get(depth);
        if (existing) {
          existing.matrix = spec.matrix;
          existing.cxform = spec.cxform;
          existing.name = spec.name;
          existing.ratio = spec.ratio;
          existing.clipDepth = spec.clipDepth;
          if (existing.clipDepth) {
            existing.clipId = this.renderer.buildClipPath(existing.cid, existing.matrix, existing.ratio);
          } else if (existing.node) {
            const morphMeta = this.renderer.scene.morphs && this.renderer.scene.morphs[existing.cid];
            const mStr = matrixToCss(existing.matrix) || "";
            const morphT = morphMeta ? morphTransformCss(morphMeta, existing.ratio) : "";
            const fullT = [mStr, morphT].filter(Boolean).join(" ");
            if (fullT) existing.node.setAttribute("transform", fullT);
            else existing.node.removeAttribute("transform");
            this.renderer.applyCxform(existing.node, existing.cxform);
            if (existing.name) existing.node.setAttribute("data-name", existing.name);
          }
          if (existing.name) this.namedChildren.set(existing.name, existing);
        } else {
          if (spec.clipDepth) {
            const clipId = this.renderer.buildClipPath(spec.cid, spec.matrix, spec.ratio);
            const rec = {
              cid: spec.cid,
              name: spec.name || null,
              matrix: spec.matrix || null,
              cxform: spec.cxform || null,
              clipDepth: spec.clipDepth,
              ratio: spec.ratio ?? null,
              clipId,
              node: null,
              mc: null,
            };
            this.depthMap.set(depth, rec);
          } else {
            const obj = this.renderer.createDisplayObject(spec.cid, spec.name, spec.matrix, spec.cxform, this, spec.ratio);
            const rec = {
              cid: spec.cid,
              name: spec.name || null,
              matrix: spec.matrix || null,
              cxform: spec.cxform || null,
              clipDepth: 0,
              ratio: spec.ratio ?? null,
              node: obj.node,
              mc: obj.mc,
            };
            this.depthMap.set(depth, rec);
            if (rec.name) this.namedChildren.set(rec.name, rec);
          }
        }
      }

      // Play target frame sounds
      const targetFrameObj = this.tl.frames[target - 1];
      if (targetFrameObj && targetFrameObj.sounds && targetFrameObj.sounds.length) {
        for (const s of targetFrameObj.sounds) {
          if (!s.stop && this.renderer.scene.sounds[s.sid]) {
            this.renderer.audio.playEffect(this.renderer.scene.sounds[s.sid].file);
          }
        }
      }

      this.currentFrame = target;
      this._rebuildDomOrder();
      this._runFrameScript(target);
    }

    _runFrameScript(frame1Based) {
      if (!this.frameScripts) return;
      const fs = this.frameScripts[frame1Based - 1];
      if (!fs) return;
      if (fs.stop) {
        this.stop();
      }
      if (fs.resetParentTips && this.parentMc) {
        const tb = this.parentMc.getChild("tips_btn");
        if (tb && tb.mc) tb.mc.gotoAndStop(1);
        this.parentMc._tipsId = 0;
      }
    }

    _applyFrameActions(frame, playSounds = true) {
      if (!frame) return;
      for (const act of frame.actions || []) {
        if (act.op === "remove") {
          const prev = this.depthMap.get(act.depth);
          if (prev) {
            if (prev.name) this.namedChildren.delete(prev.name);
            if (prev.mc) this.renderer.unregisterClipTree(prev.mc);
          }
          this.depthMap.delete(act.depth);
        } else if (act.op === "place") {
          const existing = this.depthMap.get(act.depth);
          if (act.cid !== undefined) {
            // SWF PlaceObject2 Move+HasCharacter: inherit matrix, cxform, name, clipDepth from existing if omitted!
            const matrix = act.matrix !== undefined ? act.matrix : (existing ? existing.matrix : null);
            const cxform = act.cxform !== undefined ? act.cxform : (existing ? existing.cxform : null);
            const name = act.name !== undefined ? act.name : (existing ? existing.name : null);
            const clipDepth = act.clipDepth !== undefined ? act.clipDepth : (existing ? existing.clipDepth : 0);
            const ratio = act.ratio !== undefined ? act.ratio : (existing ? existing.ratio : null);

            if (existing) {
              if (existing.name) this.namedChildren.delete(existing.name);
              if (existing.mc) this.renderer.unregisterClipTree(existing.mc);
            }

            if (clipDepth) {
              const clipId = this.renderer.buildClipPath(act.cid, matrix, ratio);
              this.depthMap.set(act.depth, {
                cid: act.cid,
                name,
                matrix,
                cxform,
                clipDepth,
                ratio,
                clipId,
                node: null,
                mc: null,
              });
            } else {
              const obj = this.renderer.createDisplayObject(act.cid, name, matrix, cxform, this, ratio);
              const rec = {
                cid: act.cid,
                name,
                matrix,
                cxform,
                clipDepth: 0,
                ratio,
                node: obj.node,
                mc: obj.mc,
              };
              this.depthMap.set(act.depth, rec);
              if (rec.name) this.namedChildren.set(rec.name, rec);
            }
          } else if (existing) {
            if (act.matrix !== undefined) existing.matrix = act.matrix;
            if (act.ratio !== undefined) existing.ratio = act.ratio;
            if (act.matrix !== undefined || act.ratio !== undefined) {
              if (existing.clipDepth) {
                existing.clipId = this.renderer.buildClipPath(existing.cid, existing.matrix, existing.ratio);
              } else if (existing.node) {
                const morphMeta = this.renderer.scene.morphs && this.renderer.scene.morphs[existing.cid];
                const mStr = matrixToCss(existing.matrix) || "";
                const morphT = morphMeta ? morphTransformCss(morphMeta, existing.ratio) : "";
                const fullT = [mStr, morphT].filter(Boolean).join(" ");
                if (fullT) existing.node.setAttribute("transform", fullT);
              }
            }
            if (act.cxform !== undefined) {
              existing.cxform = act.cxform;
              if (existing.node) this.renderer.applyCxform(existing.node, act.cxform);
            }
            if (act.name !== undefined) {
              existing.name = act.name;
              if (existing.node) existing.node.setAttribute("data-name", act.name);
              this.namedChildren.set(act.name, existing);
            }
          }
        }
      }

      if (playSounds && frame.sounds && frame.sounds.length) {
        for (const s of frame.sounds) {
          if (!s.stop && this.renderer.scene.sounds[s.sid]) {
            this.renderer.audio.playEffect(this.renderer.scene.sounds[s.sid].file);
          }
        }
      }
    }

    _rebuildDomOrder() {
      const sorted = Array.from(this.depthMap.entries()).sort((a, b) => a[0] - b[0]);
      this.el.innerHTML = "";

      let activeClipEnd = -1;
      let clipGroup = null;

      for (const [depth, rec] of sorted) {
        if (clipGroup && depth > activeClipEnd) {
          clipGroup = null;
          activeClipEnd = -1;
        }
        if (rec.clipDepth) {
          activeClipEnd = rec.clipDepth;
          clipGroup = el("g", { "clip-path": `url(#${rec.clipId})` });
          this.el.appendChild(clipGroup);
          continue;
        }
        if (rec.node) {
          if (clipGroup) {
            clipGroup.appendChild(rec.node);
          } else {
            this.el.appendChild(rec.node);
          }
        }
      }
    }
  }

  global.SwfSceneRenderer = SwfSceneRenderer;
  global.SwfMovieClip = SwfMovieClip;
})(window);
