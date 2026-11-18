/**
 * Pure H5 Launcher for 绘玩创·思维游戏第1级
 * Mirrors Main.as navigation on top of h5/ui/scene.json + h5/lessons/catalog.json
 */
(function () {
  const uiSvg = document.getElementById("ui-stage");
  const lessonSvg = document.getElementById("lesson-stage");
  const videoOverlay = document.getElementById("video-overlay");
  const introVideo = document.getElementById("intro-video");
  const skipIntroBtn = document.getElementById("skip-intro-btn");

  const hudHome = document.getElementById("hud-home-btn");
  const hudBack = document.getElementById("hud-back-btn");
  const hudSelect = document.getElementById("hud-lesson-select");
  const hudBgm = document.getElementById("hud-bgm-btn");
  const hudFs = document.getElementById("hud-fullscreen-btn");
  const hudStatus = document.getElementById("hud-status");

  let uiRenderer = null;
  let lessonRenderer = null;
  let lessonEngine = null;
  let catalog = null;
  let currentLessonId = 1;
  let bgmAudio = new Audio();
  bgmAudio.preload = "none";
  bgmAudio.src = "media/2.mp3";
  bgmAudio.loop = true;
  let bgmPlaying = false;

  function setStatus(txt) {
    hudStatus.textContent = txt;
  }

  function updateBgmLabel() {
    hudBgm.textContent = bgmPlaying ? "音乐: 开" : "音乐: 关";
  }

  function playBgm() {
    bgmAudio.play().then(() => {
      bgmPlaying = true;
      updateBgmLabel();
    }).catch(() => {});
  }

  function stopBgm() {
    bgmAudio.pause();
    bgmPlaying = false;
    updateBgmLabel();
  }

  function toggleBgm() {
    if (bgmPlaying) stopBgm();
    else playBgm();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  function unloadLesson() {
    if (lessonEngine) {
      lessonEngine.destroy();
      lessonEngine = null;
    }
    if (lessonRenderer) {
      lessonRenderer.destroy();
      lessonRenderer = null;
    }
    lessonSvg.classList.add("hidden");
  }

  function goHome() {
    unloadLesson();
    uiSvg.classList.remove("in-lesson");
    hudBack.classList.add("hidden");
    if (uiRenderer && uiRenderer.rootMc) {
      if (uiRenderer.bgRect) uiRenderer.bgRect.style.display = "";
      uiRenderer.rootMc.gotoAndStop(1);
      bindUiFrame1();
    }
    setStatus("主菜单");
  }

  function goLessonMenu(lessonId) {
    currentLessonId = lessonId;
    unloadLesson();
    uiSvg.classList.remove("in-lesson");
    hudBack.classList.remove("hidden");
    if (uiRenderer && uiRenderer.rootMc) {
      if (uiRenderer.bgRect) uiRenderer.bgRect.style.display = "";
      uiRenderer.rootMc.gotoAndStop(2);
      const mb2 = uiRenderer.rootMc.getChild("Mainbutton2");
      if (mb2 && mb2.mc) {
        mb2.mc.gotoAndStop(Number(lessonId));
      }
      bindUiFrame2();
    }
    setStatus(`第${lessonId}课 - 选择环节`);
  }

  async function openLessonPart(lessonId, partNum) {
    currentLessonId = Number(lessonId);
    stopBgm();
    unloadLesson();

    if (uiRenderer && uiRenderer.rootMc) {
      if (uiRenderer.bgRect) uiRenderer.bgRect.style.display = "none";
      uiSvg.classList.add("in-lesson");
      uiRenderer.rootMc.gotoAndStop(3);
      bindUiCommonButtons();
    }

    hudBack.classList.remove("hidden");
    lessonSvg.classList.remove("hidden");
    const basePath = `lessons/lesson-${String(lessonId).padStart(2, "0")}/${partNum}`;
    setStatus(`加载 第${lessonId}课-${partNum}...`);

    try {
      const [sceneRes, lessonRes, asRes] = await Promise.all([
        fetch(`${basePath}/scene.json`),
        fetch(`${basePath}/lesson.json`),
        fetch(`${basePath}/script.as`).catch(() => null),
      ]);
      const scene = await sceneRes.json();
      const lesson = await lessonRes.json();
      const asText = asRes && asRes.ok ? await asRes.text() : null;
      const logic = asText ? AS3Runtime.parse(asText, scene.symbols || {}) : null;

      lessonRenderer = new SwfSceneRenderer(lessonSvg, basePath, scene, logic?.frameScriptsByCid);
      await lessonRenderer.preloadAssets();
      lessonRenderer.mountRoot();

      lessonEngine = new LessonGameEngine(lessonRenderer, lesson, logic);
      lessonEngine.start();

      hudSelect.value = `${lessonId}-${partNum}`;
      setStatus(`第${lessonId}课 - 部分${partNum} (${lesson.mode})`);
    } catch (err) {
      console.error(err);
      setStatus(`加载失败: ${err.message}`);
    }
  }

  function bindUiCommonButtons() {
    if (!uiRenderer || !uiRenderer.rootMc) return;
    const root = uiRenderer.rootMc;
    const bindClick = (name, fn) => {
      const rec = root.getChild(name);
      if (rec && !rec._bound) {
        rec._bound = true;
        rec.node.style.cursor = "pointer";
        rec.node.addEventListener("click", (e) => {
          e.stopPropagation();
          fn();
        });
      }
    };
    bindClick("Home_btn", goHome);
    bindClick("Return_btn", () => {
      if (root.currentFrame === 3) {
        goLessonMenu(currentLessonId);
      } else if (root.currentFrame === 2) {
        goHome();
      }
    });
    bindClick("Sound_btn", () => {
      toggleBgm();
      const sb = root.getChild("Sound_btn");
      if (sb && sb.mc) {
        sb.mc.gotoAndStop(bgmPlaying ? 1 : 2);
      }
    });
    bindClick("Screen_btn", toggleFullscreen);
  }

  function bindUiFrame1() {
    bindUiCommonButtons();
    const root = uiRenderer.rootMc;
    const yp = root.getChild("yp");
    if (yp) yp.node.style.display = "none";
    const mb = root.getChild("Mainbutton");
    if (mb && mb.mc) {
      mb.mc.stop();
      // Bind lesson buttons a1..a16 (and any named children inside Mainbutton)
      for (const [name, rec] of mb.mc.namedChildren.entries()) {
        if (/^a\d+$/.test(name)) {
          const lid = Number(name.slice(1));
          rec.node.style.cursor = "pointer";
          rec.node.addEventListener("click", (e) => {
            e.stopPropagation();
            goLessonMenu(lid);
          });
        }
      }
      // Also support clicking anywhere inside Mainbutton sub-elements with data-name="aX"
      if (!mb._delegated) {
        mb._delegated = true;
        mb.node.addEventListener("click", (e) => {
          let cur = e.target;
          while (cur && cur !== mb.node) {
            const dn = cur.getAttribute?.("data-name");
            if (dn && /^a\d+$/.test(dn)) {
              e.stopPropagation();
              goLessonMenu(Number(dn.slice(1)));
              return;
            }
            cur = cur.parentNode;
          }
        });
      }
    }
  }

  function bindUiFrame2() {
    bindUiCommonButtons();
    const root = uiRenderer.rootMc;
    const mb2 = root.getChild("Mainbutton2");
    if (mb2 && mb2.mc) {
      mb2.mc.stop();
      if (!mb2._delegated) {
        mb2._delegated = true;
        mb2.node.addEventListener("click", (e) => {
          let cur = e.target;
          while (cur && cur !== mb2.node) {
            const dn = cur.getAttribute?.("data-name");
            if (dn && /^a[123]$/.test(dn)) {
              e.stopPropagation();
              openLessonPart(currentLessonId, Number(dn.slice(1)));
              return;
            }
            cur = cur.parentNode;
          }
        });
      }
    }
  }

  function finishIntro() {
    introVideo.pause();
    videoOverlay.classList.add("hidden");
    playBgm();
  }

  async function init() {
    // Wire HUD controls
    hudHome.addEventListener("click", goHome);
    hudBack.addEventListener("click", () => {
      if (uiRenderer && uiRenderer.rootMc && uiRenderer.rootMc.currentFrame === 3) {
        goLessonMenu(currentLessonId);
      } else {
        goHome();
      }
    });
    hudBgm.addEventListener("click", toggleBgm);
    hudFs.addEventListener("click", toggleFullscreen);
    hudSelect.addEventListener("change", () => {
      const val = hudSelect.value;
      if (!val) return;
      const [lid, pid] = val.split("-").map(Number);
      openLessonPart(lid, pid);
    });

    // Load catalog.json
    try {
      const catRes = await fetch("lessons/catalog.json");
      catalog = await catRes.json();
      hudSelect.innerHTML = '<option value="">-- 快速跳转课时 --</option>';
      for (const l of catalog.lessons) {
        for (const p of l.parts) {
          const opt = document.createElement("option");
          opt.value = `${l.id}-${p.part}`;
          opt.textContent = `第${l.id}课 - 部分${p.part} (${p.mode === "animation" ? "动画" : "互动"})`;
          hudSelect.appendChild(opt);
        }
      }
    } catch (e) {
      console.warn("catalog.json load failed:", e);
    }

    // Load Main UI (Main-xiao.swf -> ui/scene.json + ui/Main-xiao.as)
    try {
      const [uiRes, uiAsRes] = await Promise.all([
        fetch("ui/scene.json"),
        fetch("ui/Main-xiao.as").catch(() => null),
      ]);
      const uiScene = await uiRes.json();
      const uiAsText = uiAsRes && uiAsRes.ok ? await uiAsRes.text() : null;
      const uiLogic = uiAsText ? AS3Runtime.parse(uiAsText, uiScene.symbols || {}) : null;
      uiRenderer = new SwfSceneRenderer(uiSvg, "ui", uiScene, uiLogic?.frameScriptsByCid);
      await uiRenderer.preloadAssets();
      uiRenderer.mountRoot();
      bindUiFrame1();
      setStatus("主菜单就绪");
    } catch (e) {
      console.error("UI load failed:", e);
      setStatus("UI加载失败，请通过本地HTTP服务打开");
    }

    // Intro video (optional skip; auto-fallback if autoplay is blocked so black overlay never gets stuck)
    if (introVideo && introVideo.canPlayType("video/mp4")) {
      introVideo.src = "media/00.mp4";
      videoOverlay.classList.remove("hidden");
      introVideo.addEventListener("ended", finishIntro);
      introVideo.addEventListener("error", finishIntro);
      introVideo.addEventListener("click", finishIntro);
      skipIntroBtn.addEventListener("click", finishIntro);
      introVideo.play().catch(() => {
        // Unmuted autoplay blocked by browser policy -> try muted autoplay, or skip to main menu if still blocked
        introVideo.muted = true;
        introVideo.play().catch(() => {
          finishIntro();
        });
      });
    }
  }

  init();
})();
