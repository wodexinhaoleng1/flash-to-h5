/**
 * Direct AS3 (.as) Parser & Runtime Descriptor for Pure H5
 * Parses extracted ActionScript 3 (.as) files directly in the browser,
 * mapping classes to SWF character IDs (scene.symbols) and extracting:
 *  - addFrameScript(frameIdx0Based, method) -> stop() / parent callbacks
 *  - Per-class exact interaction rules from init/down/up/onClick/clickHandler/etc.
 */
(function (global) {
  function parseClassBlocks(asText) {
    const blocks = [];
    const pkgClsPat = /package\s*([^\s{]*)\s*\{\s*public\s+dynamic\s+class\s+(\S+)\s+extends\s+(\S+)\s*\{/g;
    const matches = [];
    let m;
    while ((m = pkgClsPat.exec(asText)) !== null) {
      matches.push({
        pkg: m[1] || "",
        name: m[2],
        superClass: m[3],
        bodyStart: m.index + m[0].length,
        start: m.index,
      });
    }
    for (let i = 0; i < matches.length; i++) {
      const end = i + 1 < matches.length ? matches[i + 1].start : asText.length;
      const body = asText.slice(matches[i].bodyStart, end);
      const vars = {};
      const varPat = /public\s+var\s+(\w+):([^;]+);/g;
      let vm;
      while ((vm = varPat.exec(body)) !== null) {
        vars[vm[1]] = vm[2].trim();
      }
      const methods = {};
      const fnPat = /public\s+function\s+(\w+)\s*\([^)]*\)(?::\S+)?\s*\{([\s\S]*?)\n\t\t\}/g;
      let fm;
      while ((fm = fnPat.exec(body)) !== null) {
        methods[fm[1]] = fm[2];
      }
      const fullName = matches[i].pkg ? `${matches[i].pkg}.${matches[i].name}` : matches[i].name;
      blocks.push({
        pkg: matches[i].pkg,
        name: matches[i].name,
        fullName,
        superClass: matches[i].superClass,
        vars,
        funcs: Object.keys(methods),
        methods,
        body,
      });
    }
    return blocks;
  }

  function extractFrameScripts(block) {
    const ctorBody = block.methods[block.name] || "";
    const m = ctorBody.match(/addFrameScript\(([^)]+)\)/);
    if (!m) return null;
    const args = m[1].split(",").map((s) => s.trim());
    const scripts = {};
    for (let i = 0; i + 1 < args.length; i += 2) {
      const frameIdx0 = Number(args[i]);
      const fnName = args[i + 1];
      const fnBody = block.methods[fnName] || "";
      if (!Number.isNaN(frameIdx0)) {
        scripts[frameIdx0] = {
          fnName,
          stop: /\bstop\(\);/.test(fnBody),
          resetParentTips: /Object\(parent\)\.tips_btn\.gotoAndStop\(1\)/.test(fnBody),
        };
      }
    }
    return Object.keys(scripts).length ? scripts : null;
  }

  function extractNavTarget(fnBody) {
    if (!fnBody) return null;
    const mYx = fnBody.match(/Object\(parent\)\.(yx\d+)\.visible\s*=\s*true/);
    const mPlayMc = fnBody.match(/Object\(parent\)\.(yx\d+)\._mc\.play\(\)/);
    return {
      targetYx: mYx ? mYx[1] : null,
      autoPlayYxMc: mPlayMc ? mPlayMc[1] : null,
    };
  }

  function extractDragRules(b) {
    const { vars, methods, body } = b;
    const initBody = methods.init || "";
    const downBody = methods.down || "";
    const upBody = methods.up || "";

    const hideHInInit = /h\.getChildAt\([^)]+\)\)\.visible\s*=\s*false/.test(initBody);
    const hideMccInInit = /\bmcc\.visible\s*=\s*false/.test(initBody);
    const dragDownFrame2 = /object\.gotoAndStop\(2\)/.test(downBody);
    const hideDragOnMatch = /object\.visible\s*=\s*false/.test(upBody);
    const hShowOnMatch = /hChild\.visible\s*=\s*true/.test(upBody);

    let hGotoOnMatch = null;
    if (/hChild\.gotoAndStop\(\(int\(id\w*\)\s*\+\s*1\)\)/.test(upBody)) {
      hGotoOnMatch = "id_plus_1";
    } else if (/hChild\.gotoAndStop\(2\)/.test(upBody)) {
      hGotoOnMatch = "frame2";
    } else if (/hChild\.nextFrame\(\)/.test(upBody)) {
      hGotoOnMatch = "nextFrame";
    }

    let matchRule = "id_eq_index";
    if ("orderHs" in vars) {
      matchRule = "orderHs";
    } else if (/hChild\.currentFrame\s*<=\s*int\(index\)/.test(upBody)) {
      matchRule = "le_index";
    } else if (/index\s*=\s*hChild\.name\.slice\(0,\s*1\)/.test(upBody) && /id\s*==\s*index/.test(upBody)) {
      matchRule = "prefix";
    } else if (!/id\w*\s*==\s*index\w*/.test(upBody)) {
      matchRule = "any_empty";
    }

    const mTarget = (upBody || body).match(/if\s*\(Num\s*!=\s*(\d+)\)/);
    return {
      hideHInInit,
      hideMccInInit,
      dragDownFrame2,
      hideDragOnMatch,
      hShowOnMatch,
      hGotoOnMatch,
      matchRule,
      targetCount: mTarget ? Number(mTarget[1]) : null,
    };
  }

  function classifyBlock(b) {
    const { vars, funcs, methods, body, superClass } = b;
    const fnSet = new Set(funcs);
    if (superClass === "Sound" || superClass === "Sprite" || superClass === "mc_cla" || superClass === "mc_box") {
      return null;
    }

    if (fnSet.has("onPlay") && fnSet.has("onStop") && fnSet.has("gotoFrame")) {
      return { type: "animation", className: b.name, fullName: b.fullName };
    }

    const yxVars = Object.keys(vars)
      .filter((v) => /^yx\d+$/.test(v))
      .sort((a, c) => Number(a.slice(2)) - Number(c.slice(2)));
    if (yxVars.length > 0 && fnSet.has("mcvisble") && funcs.length <= 4) {
      return { type: "yx_container", className: b.name, fullName: b.fullName, pages: yxVars };
    }

    const hasNav = "Right" in vars || "Left" in vars;
    const hasInteractive =
      [
        "init", "down", "up", "onClick", "clickHandler", "mousedownHandler",
        "mousedownElement", "mccSelect", "tips_btnClick", "aaClick", "aaclick",
        "onClick_an", "_init",
      ].some((f) => fnSet.has(f)) ||
      "d" in vars || "h" in vars || "b1" in vars || "t1" in vars || "a1" in vars ||
      "mc1" in vars || "_huabi" in vars || "mcc" in vars;

    if (!hasInteractive && !hasNav) return null;

    const info = {
      className: b.name,
      fullName: b.fullName,
      hasLeft: "Left" in vars,
      hasRight: "Right" in vars,
      leftNav: extractNavTarget(methods.LeftClick),
      rightNav: extractNavTarget(methods.RightClick),
      hasHelp: "help_btn" in vars || "help_mc" in vars,
      hasHelpBtn: "help_btn" in vars,
      hasTips: "tips_btn" in vars,
      hasEndMc: "end_mc" in vars,
      hasRemove: "remove" in vars,
      hasAa: "aa" in vars,
      aaAction: /aa\.nextFrame\(\)/.test(body) ? "nextFrame" : "play",
    };

    // 7-3 Page 1: Lx_all box-to-item line connection game (inside mcc)
    if (superClass === "Lx_all" || fnSet.has("onClick_an") || ("mcc" in vars && !("a1" in vars) && !("b1" in vars) && !("t1" in vars) && !("d" in vars) && !("an" in vars))) {
      info.type = "lx_connect";
      return info;
    }

    // 10-3 & 16-3 Page 1: _huabi 2-frame drawing board
    if ("_huabi" in vars || fnSet.has("mccSelect") || "colourMc" in vars) {
      info.type = "pen_draw";
      return info;
    }

    // 2-2 Page 4: Dual sub-MovieClip drag_match container (mc1 + mc2)
    if ("mc1" in vars && "mc2" in vars) {
      info.type = "dual_sub_drag";
      return info;
    }

    // 10-2 Page 1: Free drag puzzle onto aimArea
    if (fnSet.has("mousedownElement") && "aimArea" in vars) {
      info.type = "free_drag_puzzle";
      const mEn = body.match(/eleNums\s*=\s*(\d+)/);
      info.eleNums = mEn ? Number(mEn[1]) : 9;
      return info;
    }

    // 7-2 Page 2: Two-stage drag (d -> h -> d1)
    if (fnSet.has("down") && fnSet.has("down1") && "d1" in vars) {
      info.type = "drag_two_stage";
      const mNum = body.match(/if\s*\(Num\s*!=\s*(\d+)\)/);
      info.stage1Count = mNum ? Number(mNum[1]) : 7;
      return info;
    }

    // Standard & variant Drag Match (d -> h)
    if (fnSet.has("down") && fnSet.has("up") && "d" in vars && "h" in vars) {
      info.type = "drag_match";
      Object.assign(info, extractDragRules(b));
      return info;
    }

    // Pair Line Matching (t1..tN <-> b1..bN)
    if (fnSet.has("onClick") && "t1" in vars && "b1" in vars) {
      const tVars = Object.keys(vars).filter((v) => /^t\d+$/.test(v)).sort((a, c) => Number(a.slice(1)) - Number(c.slice(1)));
      const bVars = Object.keys(vars).filter((v) => /^b\d+$/.test(v)).sort((a, c) => Number(a.slice(1)) - Number(c.slice(1)));
      const lVars = Object.keys(vars).filter((v) => /^l\d+$/.test(v));
      const mTests = body.match(/tests\s*=\s*\[([0-9,\s]+)\]/);
      const tests = mTests ? mTests[1].split(",").map((x) => Number(x.trim())) : tVars.map((_, i) => i + 1);
      const mMid = body.match(/mid\s*=\s*(\d+)/);
      const mTargetM = (methods.onClick || "").match(/if\s*\(m\s*!=\s*(\d+)\)/);
      info.type = lVars.length > 0 ? "pair_line_reveal" : "pair_line_draw";
      info.tCount = tVars.length;
      info.bCount = bVars.length;
      info.tests = tests;
      info.mid = mMid ? Number(mMid[1]) : bVars.length + 1;
      info.targetMatches = mTargetM ? Number(mTargetM[1]) : tVars.length;
      info.tGotoFrame2 = /\.gotoAndStop\(2\)/.test(methods.onClick || "");
      return info;
    }

    // 8-2 Pages 2, 3, 4: Ordered click (single or dual group a1..aN / b1..bN)
    if (fnSet.has("clickHandler") && ("orders" in vars || "orderCps" in vars)) {
      const aVars = Object.keys(vars).filter((v) => /^a\d+$/.test(v));
      const bVars = Object.keys(vars).filter((v) => /^b\d+$/.test(v));
      const cVars = Object.keys(vars).filter((v) => /^c\d+$/.test(v));
      const dVars = Object.keys(vars).filter((v) => /^d\d+$/.test(v));
      info.type = "ordered_click";
      info.aCount = aVars.length;
      info.bCount = bVars.length;
      info.cCount = cVars.length;
      info.dCount = dVars.length;
      info.hasDualGroup = fnSet.has("clickHandler1") || "orders1" in vars;
      info.hasMcc = "mcc" in vars;
      info.hasMcc1 = "mcc1" in vars;
      return info;
    }

    // 12-2 Page 2: Click-to-toggle (a1, a2 toggle between frame 1 and frame 2)
    if (fnSet.has("onClick") && "num" in vars && !("btns" in vars)) {
      const aVars = Object.keys(vars).filter((v) => /^a\d+$/.test(v));
      info.type = "click_toggle";
      info.count = aVars.length || 2;
      return info;
    }

    // Multi-Select Quiz (b1..bN)
    if (fnSet.has("onClick") && ("b1" in vars || "a1" in vars)) {
      const bVars = Object.keys(vars).filter((v) => /^b\d+$/.test(v));
      const aVars = Object.keys(vars).filter((v) => /^a\d+$/.test(v));
      const mLen = body.match(/\blen\s*=\s*(\d+)/);
      const total = bVars.length > 0 ? bVars.length : aVars.length;
      let correctCount = bVars.length > 1 ? bVars.length - 1 : aVars.length;
      if (mLen) {
        const lval = Number(mLen[1]);
        correctCount = body.includes("len - 1") ? lval - 2 : lval - 1;
      }
      info.type = "multi_select";
      info.prefix = bVars.length > 0 ? "b" : "a";
      info.totalCount = total;
      info.correctCount = Math.max(1, correctCount);
      info.playEndMc = /end_mc\.gotoAndPlay\(2\)/.test(methods.onClick || body);
      return info;
    }

    info.type = "demo_page";
    info.hasDemoMc = "_mc" in vars;
    return info;
  }

  function parseAS3(asText, symbols = {}) {
    const blocks = parseClassBlocks(asText);
    const pages = [];
    const classByCid = {};
    const frameScriptsByCid = {};
    const superClassByCid = {};
    let yxPages = [];
    let isAnim = false;

    for (const b of blocks) {
      const cid = symbols[b.fullName] ?? symbols[b.name] ?? null;
      if (cid !== null) {
        superClassByCid[cid] = b.superClass;
      }
      const fScripts = extractFrameScripts(b);
      if (cid !== null && fScripts) {
        frameScriptsByCid[cid] = fScripts;
      }

      const res = classifyBlock(b);
      if (!res) continue;
      if (cid !== null) {
        res.cid = cid;
        classByCid[cid] = res;
      }
      if (res.type === "animation") isAnim = true;
      else if (res.type === "yx_container") yxPages = res.pages;
      else pages.push(res);
    }

    return {
      mode: isAnim ? "animation" : "interactive",
      yxPages,
      pages,
      classByCid,
      frameScriptsByCid,
      superClassByCid,
    };
  }

  global.AS3Runtime = { parse: parseAS3 };
})(window);
