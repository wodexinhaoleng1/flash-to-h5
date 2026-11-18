/**
 * Pure H5 Interactive Lesson Game Engine
 * Directly driven by AS3Runtime descriptors parsed from each lesson's script.as.
 * Restores all original Flash AS3 interaction templates and per-lesson rules:
 *  - animation (controller + m + rect click + stragBtn scrub)
 *  - demo_page (tips_btn + _mc, aa nextFrame/play, help_btn/help_mc, Left/Right)
 *  - drag_match (all 5 AS3 init/down/up variations: hideHInInit, hideDragOnMatch, hGotoOnMatch, matchRule, mcc)
 *  - dual_sub_drag (2-2 p4: mc1 + mc2 dual drag_match boards)
 *  - drag_two_stage (7-2 p2: d -> h -> d1)
 *  - lx_connect (7-3 p1: Lx_all mc_cla <-> mc_box line connecting)
 *  - pair_line_reveal (t1..tN, b1..bN, l1..lN, tests)
 *  - pair_line_draw (10-2 p2: t1..tN, b1..bN, t.gotoAndStop(2), dynamic SVG lines)
 *  - multi_select (b1..bN with exact len-1 check and playEndMc flag)
 *  - click_toggle (12-2 p2: a1..aN frame 1 <-> 2 toggle)
 *  - ordered_click (8-2 p2/p3/p4: single & dual group a->b/c + mcc and b->d + mcc1)
 *  - free_drag_puzzle (10-2 p1: free drag elements onto aim_area + reset)
 *  - pen_draw (10-3 p1 & 16-3 p1: _huabi 2-frame palette, 5 colors, rubber eraser, cx thickness slider, _clean)
 */
(function (global) {
  const SVG_NS = "http://www.w3.org/2000/svg";

  class LessonGameEngine {
    constructor(renderer, lesson, logic = null) {
      this.renderer = renderer;
      this.lesson = lesson;
      this.logic = logic || {
        mode: lesson.mode === "animation" ? "animation" : "interactive",
        yxPages: [],
        pages: [],
        classByCid: {},
        superClassByCid: {},
      };
      this.svg = renderer.svg;
      this.root = renderer.rootMc;
      this.pages = [];
      this.pageIndex = 0;
      this.cleanupFns = [];
      this.audioFiles = {
        zq: lesson.audio?.zq || this._findAudio("zq"),
        cw: lesson.audio?.cw || this._findAudio("cw"),
      };
    }

    _findAudio(keyword) {
      for (const [k, v] of Object.entries(this.lesson.audio || {})) {
        if (k.toLowerCase().includes(keyword)) return v;
      }
      const sounds = this.renderer.scene.sounds || {};
      for (const info of Object.values(sounds)) {
        if (info.file && info.file.toLowerCase().includes(keyword)) return info.file;
      }
      return null;
    }

    playSound(key) {
      const f = this.audioFiles[key];
      if (f) this.renderer.audio.playEffect(f);
    }

    start() {
      if (this.logic.mode === "animation" || this.lesson.mode === "animation") {
        this._initAnimationMode();
      } else {
        this._initInteractiveMode();
      }
    }

    destroy() {
      for (const fn of this.cleanupFns) {
        try { fn(); } catch (_) {}
      }
      this.cleanupFns = [];
    }

    // ---------------- Animation Mode (*-1) ----------------
    _initAnimationMode() {
      let mainMc = this._findMcByName("m");
      let ctrlRec = this._findRecByName("controller");

      if (!mainMc && this.lesson.mainSpriteId) {
        for (const c of this.renderer.clips) {
          if (c !== this.root && c.totalFrames > 10) {
            mainMc = c;
            break;
          }
        }
      }

      if (mainMc) mainMc.gotoAndPlay(1);

      if (ctrlRec && ctrlRec.mc) {
        const ctrl = ctrlRec.mc;
        ctrl.gotoAndStop(1);
        const playBtn = ctrl.getChild("playBtn");
        const stopBtn = ctrl.getChild("stopBtn");
        const stragBtn = ctrl.getChild("stragBtn");
        const rectRec = ctrl.getChild("rect");

        if (playBtn && mainMc) {
          playBtn.node.style.cursor = "pointer";
          playBtn.node.addEventListener("click", () => mainMc.play());
        }
        if (stopBtn && mainMc) {
          stopBtn.node.style.cursor = "pointer";
          stopBtn.node.addEventListener("click", () => mainMc.stop());
        }

        if (stragBtn && rectRec && mainMc) {
          const rectBox = rectRec.node.getBBox();
          const btnBox = stragBtn.node.getBBox();
          const minX = rectBox.x;
          const maxX = Math.max(minX, rectBox.x + rectBox.width - btnBox.width);
          const baseTransform = stragBtn.node.getAttribute("transform") || "";
          let dragging = false;
          let startClientX = 0;
          let startRatio = 0;

          const setSliderRatio = (ratio) => {
            const r = Math.max(0, Math.min(1, ratio));
            const dx = r * (maxX - minX);
            stragBtn.node.setAttribute("transform", `${baseTransform} translate(${dx} 0)`);
          };

          mainMc.onFrameChange = (cur, total) => {
            if (!dragging) setSliderRatio((cur - 1) / Math.max(1, total - 1));
          };

          // Click on progress bar rect to jump to frame (AS3 gotoFrame)
          rectRec.node.style.cursor = "pointer";
          rectRec.node.addEventListener("click", (e) => {
            const rectClient = rectRec.node.getBoundingClientRect();
            if (rectClient.width <= 0) return;
            const r = Math.max(0, Math.min(1, (e.clientX - rectClient.left) / rectClient.width));
            setSliderRatio(r);
            const targetFrame = Math.max(1, Math.round(1 + r * (mainMc.totalFrames - 1)));
            mainMc.gotoAndPlay(targetFrame);
          });

          stragBtn.node.style.cursor = "pointer";
          const onDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragging = true;
            startClientX = e.clientX;
            startRatio = (mainMc.currentFrame - 1) / Math.max(1, mainMc.totalFrames - 1);
            mainMc.stop();
          };
          const onMove = (e) => {
            if (!dragging) return;
            const ctm = this.svg.getScreenCTM();
            const scaleX = ctm ? ctm.a : 1;
            const dxSvg = (e.clientX - startClientX) / scaleX;
            const span = Math.max(1, maxX - minX);
            const r = Math.max(0, Math.min(1, startRatio + dxSvg / span));
            setSliderRatio(r);
            mainMc.gotoAndStop(Math.max(1, Math.round(1 + r * (mainMc.totalFrames - 1))));
          };
          const onUp = () => {
            if (!dragging) return;
            dragging = false;
            mainMc.play();
          };

          stragBtn.node.addEventListener("mousedown", onDown);
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          this.cleanupFns.push(() => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          });
        }
      }
    }

    // ---------------- Interactive Mode (*-2 / *-3) ----------------
    _initInteractiveMode() {
      const yxPages = [];
      for (let i = 1; i <= 20; i++) {
        const rec = this._findRecByName(`yx${i}`);
        if (rec) yxPages.push(rec);
      }

      if (yxPages.length > 0) {
        this.pages = yxPages;
        const pageSpecs = this.logic.pages || [];
        const classByCid = this.logic.classByCid || {};
        const yxMap = {};
        yxPages.forEach((p) => { if (p.name) yxMap[p.name] = p; });

        const showYxByName = (yxName, autoPlayMcName = null) => {
          const idx = yxPages.findIndex((p) => p.name === yxName);
          if (idx >= 0) showPage(idx);
          if (autoPlayMcName && yxMap[autoPlayMcName]?.mc) {
            const targetPageMc = yxMap[autoPlayMcName].mc;
            const demo = targetPageMc.getChild("_mc");
            if (demo?.mc) {
              demo.mc.gotoAndPlay(1);
              targetPageMc._tipsId = 1;
              const tb = targetPageMc.getChild("tips_btn");
              if (tb?.mc) tb.mc.gotoAndStop(2);
            }
          }
        };

        const showPage = (idx) => {
          this.pageIndex = Math.max(0, Math.min(yxPages.length - 1, idx));
          yxPages.forEach((p, i) => {
            p.node.style.display = i === this.pageIndex ? "" : "none";
            if (i !== this.pageIndex && p.mc) {
              // Reset help_mc and pause demo _mc when leaving page
              const hmc = p.mc.getChild("help_mc");
              if (hmc?.mc) hmc.mc.gotoAndStop(1);
              const dmc = p.mc.getChild("_mc");
              if (dmc?.mc) dmc.mc.gotoAndStop(1);
            }
          });
          // Reset newly shown page if it has a reset handler
          const curPage = yxPages[this.pageIndex];
          if (curPage?.mc?._pageReset) {
            curPage.mc._pageReset();
          }
        };

        yxPages.forEach((p, idx) => {
          const spec = (p.cid && classByCid[p.cid]) || pageSpecs[idx] || this._inferSpecFromMc(p.mc);
          this._setupPage(p.mc, spec, {
            onLeft: () => {
              if (spec?.leftNav?.targetYx) {
                showYxByName(spec.leftNav.targetYx, spec.leftNav.autoPlayYxMc);
              } else {
                showPage(this.pageIndex - 1);
              }
            },
            onRight: () => {
              if (spec?.rightNav?.targetYx) {
                showYxByName(spec.rightNav.targetYx, spec.rightNav.autoPlayYxMc);
              } else {
                showPage(this.pageIndex + 1);
              }
            },
          });
        });
        showPage(0);
        this._setupHelpAndTips(this.root, null);
        return;
      }

      // Multi-frame or single-frame root timeline
      const bindRootFrame = () => {
        const fIdx = (this.root.currentFrame || 1) - 1;
        const pageSpecs = this.logic.pages || [];
        const spec = pageSpecs[fIdx] || this._inferSpecFromMc(this.root);
        this._setupPage(this.root, spec, {
          onLeft: () => {
            if (this.root.currentFrame > 1) {
              this.root.prevFrame();
              bindRootFrame();
            }
          },
          onRight: () => {
            if (this.root.currentFrame < this.root.totalFrames) {
              this.root.nextFrame();
              bindRootFrame();
            }
          },
        });
      };
      bindRootFrame();
    }

    _inferSpecFromMc(mc) {
      if (!mc) return { type: "demo_page" };
      if (mc.getChild("_huabi")) return { type: "pen_draw" };
      if (mc.getChild("mc1") && mc.getChild("mc2")) return { type: "dual_sub_drag" };
      if (mc.getChild("d") && mc.getChild("h") && mc.getChild("d1")) return { type: "drag_two_stage" };
      if (mc.getChild("d") && mc.getChild("h")) return { type: "drag_match", hideHInInit: true, hShowOnMatch: true, matchRule: "id_eq_index" };
      if (mc.getChild("t1") && mc.getChild("b1") && mc.getChild("l1")) return { type: "pair_line_reveal" };
      if (mc.getChild("t1") && mc.getChild("b1")) return { type: "pair_line_draw" };
      if (mc.getChild("b1")) return { type: "multi_select", prefix: "b" };
      if (mc.getChild("a1")) return { type: "ordered_click" };
      return { type: "demo_page" };
    }

    _setupHelpAndTips(mc, spec) {
      if (!mc) return;
      const helpMc = mc.getChild("help_mc");
      const helpBtn = mc.getChild("help_btn");
      if (helpMc && helpMc.mc) {
        helpMc.mc.gotoAndStop(1);
        helpMc.node.style.cursor = "pointer";
        if (!helpMc._bound) {
          helpMc._bound = true;
          helpMc.node.addEventListener("click", (e) => {
            e.stopPropagation();
            if (helpMc.mc.currentFrame === 1) {
              helpMc.mc.gotoAndPlay(2);
            } else {
              helpMc.mc.gotoAndStop(1);
            }
          });
        }
      }
      if (helpBtn && helpMc && helpMc.mc && !helpBtn._bound) {
        helpBtn._bound = true;
        helpBtn.node.style.cursor = "pointer";
        helpBtn.node.addEventListener("click", (e) => {
          e.stopPropagation();
          if (helpMc.mc.currentFrame === 1) {
            helpMc.mc.gotoAndPlay(2);
          } else {
            helpMc.mc.gotoAndStop(1);
          }
        });
      }

      const tipsBtn = mc.getChild("tips_btn");
      const demoMc = mc.getChild("_mc") || mc.getChild("tips_mc");
      if (demoMc && demoMc.mc) {
        // In 14-2 yx1, _mc plays on frame1; otherwise starts stopped at frame 1 until tips_btn or autoPlayYxMc
        demoMc.mc.gotoAndStop(1);
        mc._tipsId = 0;
        if (tipsBtn) {
          if (tipsBtn.mc) tipsBtn.mc.gotoAndStop(1);
          if (!tipsBtn._bound) {
            tipsBtn._bound = true;
            tipsBtn.node.style.cursor = "pointer";
            tipsBtn.node.addEventListener("click", (e) => {
              e.stopPropagation();
              if (demoMc.mc.playing) {
                demoMc.mc.stop();
                mc._tipsId = 0;
                if (tipsBtn.mc) tipsBtn.mc.gotoAndStop(1);
              } else {
                if (demoMc.mc.currentFrame >= demoMc.mc.totalFrames) {
                  demoMc.mc.gotoAndPlay(1);
                } else {
                  demoMc.mc.play();
                }
                mc._tipsId = 1;
                if (tipsBtn.mc) tipsBtn.mc.gotoAndStop(2);
              }
            });
          }
        }
      }

      const aaRec = mc.getChild("aa");
      if (aaRec && aaRec.mc && !aaRec._bound) {
        aaRec._bound = true;
        aaRec.mc.gotoAndStop(1);
        aaRec.node.style.cursor = "pointer";
        aaRec.node.addEventListener("click", (e) => {
          e.stopPropagation();
          if (spec?.aaAction === "play") {
            aaRec.mc.gotoAndPlay(2);
          } else {
            const next = aaRec.mc.currentFrame < aaRec.mc.totalFrames ? aaRec.mc.currentFrame + 1 : 1;
            aaRec.mc.gotoAndStop(next);
          }
        });
      }
    }

    _setupPage(mc, spec, nav) {
      if (!mc) return;
      if (mc !== this.root) mc.gotoAndStop(1);
      this._setupHelpAndTips(mc, spec);

      const leftBtn = mc.getChild("Left");
      const rightBtn = mc.getChild("Right");
      if (leftBtn && nav?.onLeft && !leftBtn._navBound) {
        leftBtn._navBound = true;
        leftBtn.node.style.cursor = "pointer";
        leftBtn.node.addEventListener("click", (e) => { e.stopPropagation(); nav.onLeft(); });
      }
      if (rightBtn && nav?.onRight && !rightBtn._navBound) {
        rightBtn._navBound = true;
        rightBtn.node.style.cursor = "pointer";
        rightBtn.node.addEventListener("click", (e) => { e.stopPropagation(); nav.onRight(); });
      }

      const endRec = mc.getChild("end_mc");
      if (endRec && endRec.mc) {
        endRec.mc.gotoAndStop(1);
      }

      const t = spec?.type || "demo_page";
      if (t === "drag_match") this._bindDragMatch(mc, spec, endRec);
      else if (t === "dual_sub_drag") this._bindDualSubDrag(mc, spec, endRec);
      else if (t === "drag_two_stage") this._bindDragTwoStage(mc, spec, endRec);
      else if (t === "lx_connect") this._bindLxConnect(mc, spec);
      else if (t === "pair_line_reveal") this._bindPairLine(mc, spec, endRec, false);
      else if (t === "pair_line_draw") this._bindPairLine(mc, spec, endRec, true);
      else if (t === "multi_select") this._bindMultiSelect(mc, spec, endRec);
      else if (t === "click_toggle") this._bindClickToggle(mc, spec);
      else if (t === "ordered_click") this._bindOrderedClick(mc, spec);
      else if (t === "free_drag_puzzle") this._bindFreeDragPuzzle(mc, spec);
      else if (t === "pen_draw") this._bindPenDraw(mc, spec);
    }

    // ---------------- Template 1: Drag Match (d -> h, all 5 AS3 variants) ----------------
    _bindDragMatch(mc, spec, endRec) {
      const dRec = mc.getChild("d");
      const hRec = mc.getChild("h");
      const mccRec = mc.getChild("mcc");
      const removeBtn = mc.getChild("remove");
      if (!dRec?.mc || !hRec?.mc) return null;

      dRec.mc.gotoAndStop(1);
      hRec.mc.gotoAndStop(1);

      const dragItems = Array.from(dRec.mc.depthMap.values()).filter((r) => r.node);
      const targetSlots = Array.from(hRec.mc.depthMap.values()).filter((r) => r.node);

      const hideHInInit = spec?.hideHInInit ?? false;
      const hideMccInInit = spec?.hideMccInInit ?? false;
      const dragDownFrame2 = spec?.dragDownFrame2 ?? false;
      const hideDragOnMatch = spec?.hideDragOnMatch ?? !hideHInInit;
      const hShowOnMatch = spec?.hShowOnMatch ?? hideHInInit;
      const hGotoOnMatch = spec?.hGotoOnMatch ?? null;
      const matchRule = spec?.matchRule || "id_eq_index";
      const targetCount = spec?.targetCount || targetSlots.length;

      let matched = 0;
      let locked = false;

      const init = () => {
        matched = 0;
        locked = false;
        if (endRec?.mc) endRec.mc.gotoAndStop(1);
        const helpMc = mc.getChild("help_mc");
        if (helpMc?.mc) helpMc.mc.gotoAndStop(1);
        if (hideMccInInit && mccRec?.node) {
          mccRec.node.style.display = "none";
        }
        for (const rec of dragItems) {
          rec.node.style.visibility = "visible";
          if (rec.mc) rec.mc.gotoAndStop(1);
          if (rec._origTransform !== undefined) rec.node.setAttribute("transform", rec._origTransform);
        }
        for (const rec of targetSlots) {
          if (rec.mc) rec.mc.gotoAndStop(1);
          rec.node.style.visibility = hideHInInit ? "hidden" : "visible";
        }
      };

      for (const rec of dragItems) {
        const itemName = rec.name || "";
        const itemPrefix = itemName.slice(0, 1);
        const itemId = itemName.slice(1);
        rec._origTransform = rec.node.getAttribute("transform") || "";
        rec.node.style.cursor = "grab";

        this._makeDraggable(
          rec.node,
          rec._origTransform,
          () => !locked,
          () => {
            const dragBox = rec.node.getBoundingClientRect();
            let hit = null;

            for (const sRec of targetSlots) {
              const slotName = sRec.name || "";
              const slotPrefix = slotName.slice(0, 1);
              const slotIdx = slotName.slice(1);

              if (!this._rectsOverlap(dragBox, sRec.node.getBoundingClientRect())) continue;

              if (matchRule === "le_index") {
                // 9-3 Page 2: hChild.currentFrame <= int(index)
                const curF = sRec.mc ? sRec.mc.currentFrame : 1;
                const maxF = parseInt(slotIdx, 10) || 1;
                if (curF <= maxF) {
                  hit = sRec;
                  break;
                }
              } else if (matchRule === "prefix") {
                // 13-2 Pages 2 & 4: hChild.currentFrame == 1 && id == index (first letter)
                const curF = sRec.mc ? sRec.mc.currentFrame : 1;
                if (curF === 1 && itemPrefix === slotPrefix) {
                  hit = sRec;
                  break;
                }
              } else if (matchRule === "orderHs" || matchRule === "any_empty") {
                // 2-2 mc1/mc2, 7-3 p2, 10-2 p3, 10-3 p2
                if (hideHInInit) {
                  if (sRec.node.style.visibility === "hidden") {
                    hit = sRec;
                    break;
                  }
                } else {
                  const curF = sRec.mc ? sRec.mc.currentFrame : 1;
                  if (curF === 1) {
                    hit = sRec;
                    break;
                  }
                }
              } else {
                // Standard id_eq_index
                if (hideHInInit && sRec.node.style.visibility !== "hidden") continue;
                if (!hideHInInit && hGotoOnMatch && hGotoOnMatch !== "nextFrame" && sRec.mc && sRec.mc.currentFrame !== 1) continue;
                if (slotIdx === itemId || slotName.split("_")[0] === itemName.split("_")[0]) {
                  hit = sRec;
                  break;
                }
              }
            }

            rec.node.setAttribute("transform", rec._origTransform);

            if (hit) {
              if (hideDragOnMatch) {
                rec.node.style.visibility = "hidden";
              } else if (dragDownFrame2 && rec.mc) {
                rec.mc.gotoAndStop(1);
              }
              if (hShowOnMatch) {
                hit.node.style.visibility = "visible";
              }
              if (hit.mc) {
                if (hGotoOnMatch === "id_plus_1") {
                  const numId = parseInt(itemId, 10) || 1;
                  hit.mc.gotoAndStop(numId + 1);
                } else if (hGotoOnMatch === "frame2") {
                  hit.mc.gotoAndStop(2);
                } else if (hGotoOnMatch === "nextFrame") {
                  hit.mc.nextFrame();
                }
              }
              this.playSound("zq");
              matched++;
              if (matched >= targetCount) {
                locked = true;
                if (hideMccInInit && mccRec?.node) {
                  mccRec.node.style.display = "";
                }
                this._showEnd(endRec);
              }
            } else {
              if (dragDownFrame2 && rec.mc) {
                rec.mc.gotoAndStop(1);
              }
              this.playSound("cw");
            }
          },
          false,
          () => {
            if (dragDownFrame2 && rec.mc) {
              rec.mc.gotoAndStop(2);
            }
          }
        );
      }

      if (removeBtn) {
        removeBtn.node.style.cursor = "pointer";
        removeBtn.node.addEventListener("click", (e) => {
          e.stopPropagation();
          init();
        });
      }
      mc._pageReset = init;
      init();
      return init;
    }

    // ---------------- Template 1b: Dual Sub-MovieClip Drag (2-2 Page 4: mc1 + mc2) ----------------
    _bindDualSubDrag(mc, spec, endRec) {
      const mc1Rec = mc.getChild("mc1");
      const mc2Rec = mc.getChild("mc2");
      const removeBtn = mc.getChild("remove");
      const classByCid = this.logic.classByCid || {};
      const resets = [];

      for (const subRec of [mc1Rec, mc2Rec]) {
        if (subRec?.mc) {
          const subSpec = (subRec.cid && classByCid[subRec.cid]) || {
            type: "drag_match",
            hideHInInit: false,
            dragDownFrame2: true,
            hideDragOnMatch: true,
            hShowOnMatch: false,
            hGotoOnMatch: "id_plus_1",
            matchRule: "orderHs",
            targetCount: 2,
          };
          const rFn = this._bindDragMatch(subRec.mc, subSpec, null);
          if (rFn) resets.push(rFn);
        }
      }

      const resetAll = () => {
        if (endRec?.mc) endRec.mc.gotoAndStop(1);
        const helpMc = mc.getChild("help_mc");
        if (helpMc?.mc) helpMc.mc.gotoAndStop(1);
        resets.forEach((fn) => fn());
      };

      if (removeBtn) {
        removeBtn.node.style.cursor = "pointer";
        removeBtn.node.addEventListener("click", (e) => {
          e.stopPropagation();
          resetAll();
        });
      }
      mc._pageReset = resetAll;
    }

    // ---------------- Template 2: Two-Stage Drag (7-2: d -> h -> d1) ----------------
    _bindDragTwoStage(mc, spec, endRec) {
      const dRec = mc.getChild("d");
      const hRec = mc.getChild("h");
      const d1Rec = mc.getChild("d1");
      const removeBtn = mc.getChild("remove");
      if (!dRec?.mc || !hRec?.mc) return;

      dRec.mc.gotoAndStop(1);
      hRec.mc.gotoAndStop(1);
      if (d1Rec?.mc) d1Rec.mc.gotoAndStop(1);

      const dItems = Array.from(dRec.mc.depthMap.values()).filter((r) => r.node);
      const hSlots = Array.from(hRec.mc.depthMap.values()).filter((r) => r.node);
      const d1Targets = d1Rec?.mc ? Array.from(d1Rec.mc.depthMap.values()).filter((r) => r.node) : [];
      const stage1Need = spec.stage1Count || hSlots.length;

      let stage = 1;
      let num1 = 0;
      let num2 = 0;

      const init = () => {
        stage = 1;
        num1 = 0;
        num2 = 0;
        if (endRec?.mc) endRec.mc.gotoAndStop(1);
        const helpMc = mc.getChild("help_mc");
        if (helpMc?.mc) helpMc.mc.gotoAndStop(1);
        for (const r of dItems) {
          r.node.style.visibility = "visible";
          if (r._origTransform !== undefined) r.node.setAttribute("transform", r._origTransform);
        }
        for (const r of hSlots) {
          if (r.mc) r.mc.gotoAndStop(1);
          r.node.style.visibility = "visible";
          if (r._origTransform !== undefined) r.node.setAttribute("transform", r._origTransform);
        }
        for (const r of d1Targets) r.node.style.visibility = "hidden";
      };

      for (const rec of dItems) {
        const itemName = rec.name || "";
        rec._origTransform = rec.node.getAttribute("transform") || "";
        rec.node.style.cursor = "grab";
        const idNum = parseInt(itemName.slice(1), 10) || 1;
        this._makeDraggable(rec.node, rec._origTransform, () => stage === 1, () => {
          const box = rec.node.getBoundingClientRect();
          let hit = null;
          for (const sRec of hSlots) {
            if (sRec.mc && sRec.mc.currentFrame !== 1) continue;
            if (this._rectsOverlap(box, sRec.node.getBoundingClientRect())) {
              hit = sRec;
              break;
            }
          }
          rec.node.setAttribute("transform", rec._origTransform);
          if (hit) {
            rec.node.style.visibility = "hidden";
            if (hit.mc) hit.mc.gotoAndStop(idNum + 1);
            this.playSound("zq");
            num1++;
            if (num1 >= stage1Need) stage = 2;
          } else {
            this.playSound("cw");
          }
        });
      }

      for (const sRec of hSlots) {
        sRec._origTransform = sRec.node.getAttribute("transform") || "";
        sRec.node.style.cursor = "grab";
        this._makeDraggable(sRec.node, sRec.node.getAttribute("transform") || "", () => stage === 2 && sRec.mc && sRec.mc.currentFrame > 1, () => {
          const box = sRec.node.getBoundingClientRect();
          const curId = sRec.mc ? sRec.mc.currentFrame - 1 : 0;
          let hit = null;
          for (const tRec of d1Targets) {
            if (tRec.node.style.visibility !== "hidden") continue;
            const tName = tRec.name || "";
            const tId = parseInt(tName.slice(1), 10) || 0;
            if (tId === curId && this._rectsOverlap(box, tRec.node.getBoundingClientRect())) {
              hit = tRec;
              break;
            }
          }
          sRec.node.setAttribute("transform", sRec._origTransform);
          if (hit) {
            if (sRec.mc) sRec.mc.gotoAndStop(1);
            hit.node.style.visibility = "visible";
            this.playSound("zq");
            num2++;
            if (num2 >= d1Targets.length) {
              stage = 3;
              this._showEnd(endRec);
            }
          } else {
            this.playSound("cw");
          }
        });
      }

      if (removeBtn) {
        removeBtn.node.style.cursor = "pointer";
        removeBtn.node.addEventListener("click", (e) => {
          e.stopPropagation();
          init();
        });
      }
      mc._pageReset = init;
      init();
    }

    // ---------------- Template 2b: Lx_all Box-to-Item Line Connect (7-3 Page 1) ----------------
    _bindLxConnect(mc, spec) {
      const mccRec = mc.getChild("mcc");
      const targetMc = mccRec?.mc || mc;
      const itemsContainer = targetMc.getChild("_mc");
      const lxRec = targetMc.getChild("_lx");
      const endRec = targetMc.getChild("end_mc") || mc.getChild("end_mc");
      const removeBtn = mc.getChild("remove");
      if (!itemsContainer?.mc) return;

      const superClassByCid = this.logic.superClassByCid || {};
      const children = Array.from(itemsContainer.mc.depthMap.values()).filter((r) => r.node);

      const lineOverlay = document.createElementNS(SVG_NS, "g");
      if (lxRec?.node) lxRec.node.appendChild(lineOverlay);
      else targetMc.el.appendChild(lineOverlay);

      let selected = null;
      let connectedCount = 0;

      const getKind = (rec) => {
        const sc = superClassByCid[rec.cid];
        if (sc === "mc_cla") return "cla";
        if (sc === "mc_box") return "box";
        // Fallback by depth in 7-3 _mc (depths 1..15 are mc_box, 17..31 are mc_cla)
        return rec.cid >= 33 ? "box" : "cla";
      };

      const reset = () => {
        selected = null;
        connectedCount = 0;
        lineOverlay.innerHTML = "";
        if (endRec?.mc) endRec.mc.gotoAndStop(1);
        const helpMc = mc.getChild("help_mc");
        if (helpMc?.mc) helpMc.mc.gotoAndStop(1);
        for (const rec of children) {
          rec._used = false;
          rec.node.style.filter = "";
          rec.node.style.cursor = "pointer";
        }
      };

      for (const rec of children) {
        rec.node.addEventListener("click", (e) => {
          e.stopPropagation();
          if (rec._used) {
            this.playSound("cw");
            if (selected) selected.node.style.filter = "";
            selected = null;
            return;
          }
          if (!selected) {
            selected = rec;
            rec.node.style.filter = "drop-shadow(0 0 10px #ff0000)";
            return;
          }
          if (selected === rec) {
            rec.node.style.filter = "";
            selected = null;
            return;
          }
          const k1 = getKind(selected);
          const k2 = getKind(rec);
          selected.node.style.filter = "";
          rec.node.style.filter = "";
          if (k1 !== k2) {
            selected._used = true;
            rec._used = true;
            const p1x = selected.matrix ? selected.matrix[4] : 0;
            const p1y = selected.matrix ? selected.matrix[5] : 0;
            const p2x = rec.matrix ? rec.matrix[4] : 0;
            const p2y = rec.matrix ? rec.matrix[5] : 0;
            const line = document.createElementNS(SVG_NS, "line");
            line.setAttribute("x1", String(p1x));
            line.setAttribute("y1", String(p1y));
            line.setAttribute("x2", String(p2x));
            line.setAttribute("y2", String(p2y));
            line.setAttribute("stroke", "#ff0000");
            line.setAttribute("stroke-width", "5");
            line.setAttribute("stroke-linecap", "round");
            lineOverlay.appendChild(line);
            this.playSound("zq");
            connectedCount++;
            if (connectedCount >= 8) {
              this._showEnd(endRec);
            }
          } else {
            this.playSound("cw");
          }
          selected = null;
        });
      }

      if (removeBtn) {
        removeBtn.node.style.cursor = "pointer";
        removeBtn.node.addEventListener("click", (e) => {
          e.stopPropagation();
          reset();
        });
      }
      mc._pageReset = reset;
      reset();
    }

    // ---------------- Template 3: Pair Line Matching (2-3, 3-3, 9-3, 10-2 p2, 16-3 p2) ----------------
    _bindPairLine(mc, spec, endRec, dynamicDraw) {
      const tests = spec.tests || [];
      const tList = [];
      const bList = [];
      const lList = [];
      for (let i = 1; i <= 12; i++) {
        const tr = mc.getChild(`t${i}`);
        const br = mc.getChild(`b${i}`);
        const lr = mc.getChild(`l${i}`);
        if (tr) tList.push({ idx: i, key: tests[i - 1] ?? i, rec: tr, group: "t" });
        if (br) bList.push({ idx: i, key: i, rec: br, group: "b" });
        if (lr) lList.push(lr);
      }

      const mccRec = mc.getChild("mcc");
      const lineOverlay = dynamicDraw ? document.createElementNS(SVG_NS, "g") : null;
      if (lineOverlay) {
        if (mccRec?.node) mccRec.node.appendChild(lineOverlay);
        else mc.el.appendChild(lineOverlay);
      }

      let prev = null;
      let matched = 0;
      const totalPairs = spec.targetMatches || tList.length;
      const removeBtn = mc.getChild("remove");

      const reset = () => {
        prev = null;
        matched = 0;
        if (endRec?.mc) endRec.mc.gotoAndStop(1);
        const helpMc = mc.getChild("help_mc");
        if (helpMc?.mc) helpMc.mc.gotoAndStop(1);
        lList.forEach((l) => { l.node.style.display = "none"; });
        if (lineOverlay) lineOverlay.innerHTML = "";
        [...tList, ...bList].forEach((item) => {
          item.done = false;
          if (item.rec.mc) item.rec.mc.gotoAndStop(1);
          item.rec.node.style.filter = "";
          item.rec.node.style.pointerEvents = "auto";
          item.rec.node.style.cursor = "pointer";
        });
      };

      const onItemClick = (item) => {
        if (item.done) return;
        if (prev === item) {
          item.rec.node.style.filter = "";
          prev = null;
          return;
        }
        item.rec.node.style.filter = "drop-shadow(0 0 8px #ff0000)";
        if (!prev) {
          prev = item;
          return;
        }
        if (prev.group === item.group) {
          prev.rec.node.style.filter = "";
          prev = item;
          return;
        }
        prev.rec.node.style.filter = "";
        item.rec.node.style.filter = "";
        if (prev.key === item.key) {
          const tItem = item.group === "t" ? item : prev;
          const bItem = item.group === "b" ? item : prev;
          tItem.done = true;
          tItem.rec.node.style.pointerEvents = "none";
          if (dynamicDraw) {
            bItem.done = true;
            bItem.rec.node.style.pointerEvents = "none";
            if (spec.tGotoFrame2 && tItem.rec.mc) {
              tItem.rec.mc.gotoAndStop(2);
            }
            if (lineOverlay) {
              const p1x = bItem.rec.matrix ? bItem.rec.matrix[4] : 0;
              const p1y = bItem.rec.matrix ? bItem.rec.matrix[5] : 0;
              const p2x = tItem.rec.matrix ? tItem.rec.matrix[4] : 0;
              const p2y = tItem.rec.matrix ? tItem.rec.matrix[5] : 0;
              if (p1x || p1y || p2x || p2y) {
                const line = document.createElementNS(SVG_NS, "line");
                line.setAttribute("x1", String(p1x));
                line.setAttribute("y1", String(p1y));
                line.setAttribute("x2", String(p2x));
                line.setAttribute("y2", String(p2y));
                line.setAttribute("stroke", "#ff0000");
                line.setAttribute("stroke-width", "5");
                line.setAttribute("stroke-linecap", "round");
                lineOverlay.appendChild(line);
              } else {
                this._drawLineBetween(lineOverlay, tItem.rec.node, bItem.rec.node);
              }
            }
          } else if (lList[tItem.idx - 1]) {
            lList[tItem.idx - 1].node.style.display = "";
          }
          matched++;
          this.playSound("zq");
          if (matched >= totalPairs) this._showEnd(endRec);
        } else {
          this.playSound("cw");
        }
        prev = null;
      };

      [...tList, ...bList].forEach((item) => {
        if (item.rec.mc) item.rec.mc.gotoAndStop(1);
        item.rec.node.addEventListener("click", (e) => {
          e.stopPropagation();
          onItemClick(item);
        });
      });

      if (removeBtn) {
        removeBtn.node.style.cursor = "pointer";
        removeBtn.node.addEventListener("click", (e) => {
          e.stopPropagation();
          reset();
        });
      }
      mc._pageReset = reset;
      reset();
    }

    _drawLineBetween(container, nodeA, nodeB) {
      const ctmInv = this.svg.getScreenCTM()?.inverse();
      if (!ctmInv) return;
      const centerOf = (node) => {
        const r = node.getBoundingClientRect();
        const pt = this.svg.createSVGPoint();
        pt.x = r.left + r.width / 2;
        pt.y = r.top + r.height / 2;
        return pt.matrixTransform(ctmInv);
      };
      const p1 = centerOf(nodeA);
      const p2 = centerOf(nodeB);
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", p1.x);
      line.setAttribute("y1", p1.y);
      line.setAttribute("x2", p2.x);
      line.setAttribute("y2", p2.y);
      line.setAttribute("stroke", "#ff0000");
      line.setAttribute("stroke-width", "5");
      line.setAttribute("stroke-linecap", "round");
      container.appendChild(line);
    }

    // ---------------- Template 4: Multi-Select (5-3, 6-3, 8-3, 12-2, 12-3, 14-2, 14-3, 15-2, 15-3, 16-2) ----------------
    _bindMultiSelect(mc, spec, endRec) {
      const prefix = spec.prefix || "b";
      const items = [];
      for (let i = 1; i <= 20; i++) {
        const rec = mc.getChild(`${prefix}${i}`);
        if (rec) items.push({ idx: i, rec });
      }
      const correctCount = spec.correctCount || Math.max(1, items.length - 1);
      const playEndMc = spec.playEndMc !== false;
      let remaining = new Set();
      const removeBtn = mc.getChild("remove");

      const reset = () => {
        remaining.clear();
        if (endRec?.mc) endRec.mc.gotoAndStop(1);
        const helpMc = mc.getChild("help_mc");
        if (helpMc?.mc) helpMc.mc.gotoAndStop(1);
        items.forEach((it) => {
          if (it.rec.mc) it.rec.mc.gotoAndStop(1);
          if (it.idx <= correctCount) remaining.add(it.idx);
        });
      };

      items.forEach((it) => {
        it.rec.node.style.cursor = "pointer";
        it.rec.node.addEventListener("click", (e) => {
          e.stopPropagation();
          if (it.idx <= correctCount) {
            if (remaining.has(it.idx)) {
              remaining.delete(it.idx);
              if (it.rec.mc) it.rec.mc.gotoAndStop(2);
              this.playSound("zq");
              if (remaining.size === 0 && playEndMc) {
                this._showEnd(endRec);
              }
            }
          } else {
            this.playSound("cw");
          }
        });
      });

      if (removeBtn) {
        removeBtn.node.style.cursor = "pointer";
        removeBtn.node.addEventListener("click", (e) => {
          e.stopPropagation();
          reset();
        });
      }
      mc._pageReset = reset;
      reset();
    }

    // ---------------- Template 4b: Click-to-Toggle (12-2 Page 2: a1, a2) ----------------
    _bindClickToggle(mc, spec) {
      const items = [];
      const count = spec.count || 2;
      for (let i = 1; i <= count; i++) {
        const rec = mc.getChild(`a${i}`);
        if (rec) items.push(rec);
      }

      const reset = () => {
        const helpMc = mc.getChild("help_mc");
        if (helpMc?.mc) helpMc.mc.gotoAndStop(1);
        items.forEach((r) => {
          if (r.mc) r.mc.gotoAndStop(1);
        });
      };

      items.forEach((r) => {
        r.node.style.cursor = "pointer";
        r.node.addEventListener("click", (e) => {
          e.stopPropagation();
          if (r.mc) {
            const next = r.mc.currentFrame === 1 ? 2 : 1;
            r.mc.gotoAndStop(next);
          }
        });
      });

      mc._pageReset = reset;
      reset();
    }

    // ---------------- Template 5: Ordered Click (8-2 Pages 2, 3, 4: single & dual group) ----------------
    _bindOrderedClick(mc, spec) {
      const hasDual = Boolean(spec.hasDualGroup);
      const removeBtn = mc.getChild("remove");

      // Helper to wire one ordered group: buttons (prefixBtn 1..N) -> indicators (prefixInd 1..M) + finalMc
      const setupGroup = (btnPrefix, btnCount, indPrefix, indHideCount, finalMcRec) => {
        const btns = [];
        const inds = {};
        for (let i = 1; i <= btnCount; i++) {
          const r = mc.getChild(`${btnPrefix}${i}`);
          if (r) btns.push({ idx: i, rec: r });
        }
        for (let i = 1; i <= 10; i++) {
          const r = mc.getChild(`${indPrefix}${i}`);
          if (r) inds[i] = r;
        }
        let step = 0;

        const hideInds = () => {
          for (let i = 1; i <= indHideCount; i++) {
            if (inds[i]) inds[i].node.style.display = "none";
          }
        };

        const resetGroup = () => {
          step = 0;
          if (finalMcRec) {
            finalMcRec.node.style.display = "none";
            if (finalMcRec.mc) finalMcRec.mc.gotoAndStop(1);
          }
          // Restore indicator 1 visible and hide 1..indHideCount as in bvi()/cvi()/dvi()
          for (const [k, r] of Object.entries(inds)) {
            r.node.style.display = Number(k) <= indHideCount ? "none" : "";
          }
          btns.forEach((b) => {
            b.rec.node.style.filter = "";
            if (b.rec.mc) b.rec.mc.gotoAndStop(1);
          });
        };

        btns.forEach((b, i) => {
          b.rec.node.style.cursor = "pointer";
          b.rec.node.addEventListener("click", (e) => {
            e.stopPropagation();
            if (i === step) {
              hideInds();
              b.rec.node.style.filter = "drop-shadow(0 0 8px #ffff00)";
              if (b.rec.mc) b.rec.mc.gotoAndStop(2);
              const showIdx = b.idx + 1;
              if (inds[showIdx]) inds[showIdx].node.style.display = "";
              this.playSound("zq");
              step++;
              if (step >= btns.length && finalMcRec) {
                finalMcRec.node.style.display = "";
                if (finalMcRec.mc) finalMcRec.mc.gotoAndPlay(1);
              }
            } else {
              if (b.rec.mc && hasDual) b.rec.mc.gotoAndStop(1);
              this.playSound("cw");
            }
          });
        });

        return resetGroup;
      };

      const resets = [];
      if (hasDual) {
        // 8-2 Pages 3 & 4: Group 1 (a1..aN -> c1..c4 + mcc) and Group 2 (b1..b3 -> d1..d4 + mcc1)
        resets.push(setupGroup("a", spec.aCount || 3, "c", 3, mc.getChild("mcc")));
        resets.push(setupGroup("b", spec.bCount || 3, "d", 3, mc.getChild("mcc1")));
      } else {
        // 8-2 Page 2: Single Group (a1..a3 -> b1..b4 + mcc)
        resets.push(setupGroup("a", spec.aCount || 3, "b", 3, mc.getChild("mcc")));
      }

      const resetAll = () => {
        const helpMc = mc.getChild("help_mc");
        if (helpMc?.mc) helpMc.mc.gotoAndStop(1);
        const aaRec = mc.getChild("aa");
        if (aaRec?.mc) aaRec.mc.gotoAndStop(1);
        resets.forEach((fn) => fn());
      };

      if (removeBtn) {
        removeBtn.node.style.cursor = "pointer";
        removeBtn.node.addEventListener("click", (e) => {
          e.stopPropagation();
          resetAll();
        });
      }
      mc._pageReset = resetAll;
      resetAll();
    }

    // ---------------- Template 6: Free Drag Puzzle (10-2 Page 1) ----------------
    _bindFreeDragPuzzle(mc, spec) {
      const removeBtn = mc.getChild("remove");
      const aimAreaRec = mc.getChild("aim_area") || mc.getChild("aimArea");
      const draggables = [];
      const count = spec.eleNums || 9;

      for (let i = 1; i <= count; i++) {
        const rec = mc.getChild(`a${i}`);
        if (!rec) continue;
        if (rec.mc) rec.mc.stop();
        rec._initialTransform = rec.node.getAttribute("transform") || "";
        rec._origTransform = rec._initialTransform;
        draggables.push(rec);
        rec.node.style.cursor = "grab";
        this._makeDraggable(
          rec.node,
          rec._origTransform,
          () => true,
          (finalT) => {
            if (aimAreaRec?.node) {
              const boxA = rec.node.getBoundingClientRect();
              const boxB = aimAreaRec.node.getBoundingClientRect();
              if (!this._rectsOverlap(boxA, boxB)) {
                rec.node.setAttribute("transform", rec._initialTransform);
                rec._origTransform = rec._initialTransform;
                return;
              }
            }
            rec._origTransform = finalT;
          },
          true
        );
      }

      const reset = () => {
        const helpMc = mc.getChild("help_mc");
        if (helpMc?.mc) helpMc.mc.gotoAndStop(1);
        draggables.forEach((r) => {
          r._origTransform = r._initialTransform;
          r.node.setAttribute("transform", r._initialTransform || "");
        });
      };

      if (removeBtn) {
        removeBtn.node.style.cursor = "pointer";
        removeBtn.node.addEventListener("click", (e) => {
          e.stopPropagation();
          reset();
        });
      }
      mc._pageReset = reset;
    }

    // ---------------- Template 7: _huabi 2-Frame Drawing Board (10-3 Page 1 & 16-3 Page 1) ----------------
    _bindPenDraw(mc, spec) {
      const huabiRec = mc.getChild("_huabi");
      const removeBtn = mc.getChild("remove");
      const paletteColors = ["#ee01e1", "#fac000", "#3abf11", "#04a1e9", "#000000"];

      let penColor = paletteColors[0];
      let penWidth = 6;
      let isEraser = false;
      let drawingEnabled = !huabiRec; // If _huabi exists, enabled when _huabi is on Frame 2
      let drawing = false;
      let curPath = null;
      let dStr = "";

      const drawLayer = document.createElementNS(SVG_NS, "g");
      // Place drawLayer below _huabi and UI buttons so palette stays clickable on top
      if (huabiRec?.node && huabiRec.node.parentNode === mc.el) {
        mc.el.insertBefore(drawLayer, huabiRec.node);
      } else {
        mc.el.appendChild(drawLayer);
      }

      const bindHuabiFrame2 = () => {
        if (!huabiRec?.mc) return;
        const hmc = huabiRec.mc;
        const mccsBtn = hmc.getChild("mccs");
        const cleanBtn = hmc.getChild("_clean");
        const rubberRec = hmc.getChild("rubber");
        const colourMcRec = hmc.getChild("colourMc");
        const cxRec = hmc.getChild("cx");

        const selectSwatch = (idx1Based) => {
          isEraser = false;
          penColor = paletteColors[idx1Based - 1] || paletteColors[0];
          if (rubberRec?.mc) rubberRec.mc.gotoAndStop(1);
          if (colourMcRec?.mc) {
            for (let i = 1; i <= 5; i++) {
              const sw = colourMcRec.mc.getChild(`a${i}`);
              if (sw?.mc) sw.mc.gotoAndStop(i === idx1Based ? 2 : 1);
            }
          }
        };

        if (colourMcRec?.mc) {
          for (let i = 1; i <= 5; i++) {
            const sw = colourMcRec.mc.getChild(`a${i}`);
            if (sw && !sw._bound) {
              sw._bound = true;
              sw.node.style.cursor = "pointer";
              sw.node.addEventListener("click", (e) => {
                e.stopPropagation();
                selectSwatch(i);
              });
            }
          }
        }

        if (rubberRec && !rubberRec._bound) {
          rubberRec._bound = true;
          rubberRec.node.style.cursor = "pointer";
          rubberRec.node.addEventListener("click", (e) => {
            e.stopPropagation();
            isEraser = true;
            if (rubberRec.mc) rubberRec.mc.gotoAndStop(2);
            if (colourMcRec?.mc) {
              for (let i = 1; i <= 5; i++) {
                const sw = colourMcRec.mc.getChild(`a${i}`);
                if (sw?.mc) sw.mc.gotoAndStop(1);
              }
            }
          });
        }

        if (cxRec?.mc) {
          const cxMc = cxRec.mc;
          const anRec = cxMc.getChild("an");
          const slRec = cxMc.getChild("sl");
          const mccPreview = cxMc.getChild("mcc");
          if (mccPreview?.mc) mccPreview.mc.gotoAndStop(1);
          if (anRec && slRec && !anRec._bound) {
            anRec._bound = true;
            anRec.node.style.cursor = "ew-resize";
            const slBox = slRec.node.getBBox();
            const maxSlide = Math.max(100, slBox.width || 150);
            const baseT = anRec.node.getAttribute("transform") || "";
            let sliding = false;
            let startX = 0;
            let curDx = 0;

            anRec.node.addEventListener("mousedown", (e) => {
              e.preventDefault();
              e.stopPropagation();
              sliding = true;
              startX = e.clientX;
            });
            const onSlideMove = (e) => {
              if (!sliding) return;
              const ctm = this.svg.getScreenCTM();
              const sx = ctm ? ctm.a : 1;
              const dx = Math.max(0, Math.min(maxSlide, curDx + (e.clientX - startX) / sx));
              anRec.node.setAttribute("transform", `${baseT} translate(${dx} 0)`);
              penWidth = Math.round(5 + dx / 2);
              if (mccPreview?.mc) {
                const f = Math.max(1, Math.min(mccPreview.mc.totalFrames, Math.round(dx) || 1));
                mccPreview.mc.gotoAndStop(f);
              }
            };
            const onSlideUp = (e) => {
              if (!sliding) return;
              const ctm = this.svg.getScreenCTM();
              const sx = ctm ? ctm.a : 1;
              curDx = Math.max(0, Math.min(maxSlide, curDx + (e.clientX - startX) / sx));
              sliding = false;
            };
            window.addEventListener("mousemove", onSlideMove);
            window.addEventListener("mouseup", onSlideUp);
            this.cleanupFns.push(() => {
              window.removeEventListener("mousemove", onSlideMove);
              window.removeEventListener("mouseup", onSlideUp);
            });
          }
        }

        if (cleanBtn && !cleanBtn._bound) {
          cleanBtn._bound = true;
          cleanBtn.node.style.cursor = "pointer";
          cleanBtn.node.addEventListener("click", (e) => {
            e.stopPropagation();
            drawLayer.innerHTML = "";
            selectSwatch(1);
          });
        }

        if (mccsBtn && !mccsBtn._bound) {
          mccsBtn._bound = true;
          mccsBtn.node.style.cursor = "pointer";
          mccsBtn.node.addEventListener("click", (e) => {
            e.stopPropagation();
            drawLayer.innerHTML = "";
            drawingEnabled = false;
            hmc.gotoAndStop(1);
            bindHuabiFrame1();
          });
        }

        selectSwatch(1);
      };

      const bindHuabiFrame1 = () => {
        if (!huabiRec?.mc) return;
        const hmc = huabiRec.mc;
        const mccBtn = hmc.getChild("mcc");
        if (mccBtn && !mccBtn._bound) {
          mccBtn._bound = true;
          mccBtn.node.style.cursor = "pointer";
          mccBtn.node.addEventListener("click", (e) => {
            e.stopPropagation();
            drawingEnabled = true;
            hmc.gotoAndStop(2);
            bindHuabiFrame2();
          });
        }
      };

      if (huabiRec?.mc) {
        huabiRec.mc.gotoAndStop(1);
        bindHuabiFrame1();
      }

      const toSvgPt = (e) => {
        const inv = this.svg.getScreenCTM()?.inverse();
        if (!inv) return { x: 0, y: 0 };
        const pt = this.svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        return pt.matrixTransform(inv);
      };

      const eraseAt = (pt) => {
        const r = 28;
        for (const child of Array.from(drawLayer.children)) {
          const box = child.getBBox?.();
          if (box && pt.x >= box.x - r && pt.x <= box.x + box.width + r && pt.y >= box.y - r && pt.y <= box.y + box.height + r) {
            child.remove();
          }
        }
      };

      const onDown = (e) => {
        if (!drawingEnabled) return;
        if (e.target.closest?.(".swf-btn")) return;
        if (huabiRec?.node && huabiRec.node.contains(e.target)) {
          // Allow drawing only if clicking hitObj inside _huabi, not toolbar buttons
          const hitObj = huabiRec.mc?.getChild("hitObj");
          if (!hitObj?.node || !hitObj.node.contains(e.target)) return;
        }
        drawing = true;
        const p = toSvgPt(e);
        if (isEraser) {
          eraseAt(p);
          return;
        }
        dStr = `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
        curPath = document.createElementNS(SVG_NS, "path");
        curPath.setAttribute("d", dStr);
        curPath.setAttribute("fill", "none");
        curPath.setAttribute("stroke", penColor);
        curPath.setAttribute("stroke-width", String(penWidth));
        curPath.setAttribute("stroke-linecap", "round");
        curPath.setAttribute("stroke-linejoin", "round");
        drawLayer.appendChild(curPath);
      };

      const onMove = (e) => {
        if (!drawing) return;
        const p = toSvgPt(e);
        if (isEraser) {
          eraseAt(p);
          return;
        }
        if (!curPath) return;
        dStr += ` L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
        curPath.setAttribute("d", dStr);
      };

      const onUp = () => {
        drawing = false;
        curPath = null;
      };

      mc.el.addEventListener("mousedown", onDown);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      this.cleanupFns.push(() => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      });

      const reset = () => {
        drawLayer.innerHTML = "";
        const helpMc = mc.getChild("help_mc");
        if (helpMc?.mc) helpMc.mc.gotoAndStop(1);
        if (huabiRec?.mc) {
          drawingEnabled = false;
          huabiRec.mc.gotoAndStop(1);
          bindHuabiFrame1();
        }
      };

      if (removeBtn) {
        removeBtn.node.style.cursor = "pointer";
        removeBtn.node.addEventListener("click", (e) => {
          e.stopPropagation();
          reset();
        });
      }
      mc._pageReset = reset;
    }

    // ---------------- Shared Helpers ----------------
    _showEnd(endRec) {
      if (!endRec) return;
      endRec.node.style.display = "";
      if (endRec.mc) endRec.mc.gotoAndPlay(2);
    }

    _rectsOverlap(a, b) {
      return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    }

    _makeDraggable(node, origTransform, canDragFn, onDropFn, keepPos = false, onDragStartFn = null) {
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let lastTransform = origTransform;

      const onDown = (e) => {
        if (!canDragFn()) return;
        e.preventDefault();
        e.stopPropagation();
        this.renderer.audio.ensureContext();
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        lastTransform = node.getAttribute("transform") || origTransform;
        node.style.cursor = "grabbing";
        if (node.parentNode) node.parentNode.appendChild(node);
        if (onDragStartFn) onDragStartFn();
      };

      const onMove = (e) => {
        if (!dragging) return;
        const ctm = this.svg.getScreenCTM();
        const sx = ctm ? ctm.a : 1;
        const sy = ctm ? ctm.d : 1;
        const dx = (e.clientX - startX) / sx;
        const dy = (e.clientY - startY) / sy;
        node.setAttribute("transform", `translate(${dx} ${dy}) ${lastTransform}`);
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        node.style.cursor = "grab";
        onDropFn(keepPos ? (node.getAttribute("transform") || "") : origTransform);
      };

      node.addEventListener("mousedown", onDown);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      this.cleanupFns.push(() => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      });
    }

    _findRecByName(name) {
      for (const mc of this.renderer.clips) {
        if (mc._destroyed) continue;
        const found = mc.getChild(name);
        if (found) return found;
      }
      return null;
    }

    _findMcByName(name) {
      const rec = this._findRecByName(name);
      return rec ? rec.mc : null;
    }
  }

  global.LessonGameEngine = LessonGameEngine;
})(window);
