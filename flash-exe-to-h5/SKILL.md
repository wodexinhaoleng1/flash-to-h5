---
name: flash-exe-to-h5
description: >-
  Extract Flash Projector / Enigma Virtual Box (.exe) bundles, decompile AVM2
  (DoABC2) bytecode into human-readable ActionScript 3 (.as) files, convert all
  embedded SWF lessons into editable HTML5 packages (JSON + SVG + PNG + MP3 + script.as)
  with zero Flash dependency, and run a standalone H5 SVG/WebAudio engine that directly
  parses and executes .as frame scripts (addFrameScript) and all original AS3 interactive templates.
---

# Flash EXE 转纯 H5 互动课件工作流（直接驱动 `.as` 逻辑）

本 Skill 用于将打包了 Flash 内容的 `.exe`（如 **Enigma Virtual Box + Flash Projector** 打包的交互式教学软件）完整解包、反编译全部 `DoABC2` 字节码为可读 `.as` 源码、将 SWF 转换为人类可直接编辑的 H5 资源包（`scene.json` + `lesson.json` + `script.as` + `assets/{images,shapes,audio}`），并生成**直接读取 `.as` 文件控制全部子元件帧脚本与交互逻辑**的零 Flash 依赖 H5 引擎。

---

## 目录结构

```text
flash-exe-to-h5/
├── SKILL.md
├── scripts/
│   ├── unpack_evb.py         # [Step 1] 解包 EVB\x00 虚拟文件系统 & 末尾 0xFA123456 Projector SWF
│   ├── abc_disasm.py         # [Step 2a] AVM2 (DoABC2) 字节码底层读取与反汇编器
│   ├── extract_as.py         # [Step 2b] 将所有 SWF 的 DoABC2 反编译为可读 ActionScript 3 (.as) 文件
│   ├── swf_to_h5.py          # [Step 3a] 单 SWF 转 H5 素材包 (PNG/JPG/SVG/MP3/scene.json/lesson.json)
│   └── convert_all.py        # [Step 3b] 全量批处理脚本 (生成 h5/ + 挂载 script.as + 拷贝运行时模板)
└── resources/
    └── h5_template/          # [Step 4] 纯 H5 运行时模板 (SVG + WebAudio + AS3 直接解析器 + 高并发本地服务)
        ├── index.html
        ├── start_h5.bat
        ├── server.py
        ├── css/style.css
        └── js/
            ├── renderer.js
            ├── as3-runtime.js
            ├── game-engine.js
            └── launcher.js
```

---

## 标准执行步骤

### Step 1：探测与解包 `.exe`

运行 [unpack_evb.py](./scripts/unpack_evb.py) 解包目标 `.exe`：

```bash
python scripts/unpack_evb.py <bundle.exe> extracted
```

- 自动检测文件尾 `0xFA123456` Flash Projector SWF。
- 自动定位 PE `.enigma1` 节中的 `EVB\x00` 签名，递归解析 UTF-16LE 节点树（文件夹 `type == 3`，文件 `type == 2`），将所有 `.swf`、`.as`、`.mp4`、`.mp3` 原样提取到 `extracted/`。

---

### Step 2：反编译 `DoABC2` 字节码为 `.as` 文件

运行 [extract_as.py](./scripts/extract_as.py) 将主界面 SWF 与全部课时 SWF 的 `DoABC2` (tag 82) 字节码反编译为可读的 ActionScript 3 源码：

```bash
python scripts/extract_as.py extracted extracted/as
```

- 输出 `extracted/as/Main.as`、`extracted/as/Main-xiao.as` 及 `extracted/as/1-1.as` ~ `16-3.as`。
- 完整保留包名、类名、父类、成员变量声明、`addFrameScript(frameIdx0, method)` 帧脚本绑定，以及 `init` / `down` / `up` / `reset` / `onClick` / `clickHandler` / `clickHandler1` / `LeftClick` / `RightClick` / `tips_btnClick` / `onClick_an` / `mccSelect` 等全部方法实现。

---

### Step 3：转换 SWF 素材包并挂载 `.as` 与 H5 运行时

运行 [convert_all.py](./scripts/convert_all.py) 一键生成完整可运行的 `h5/` 目录：

```bash
python scripts/convert_all.py <project_root>
```

**素材转换关键规范与避坑要点**（见 [swf_to_h5.py](./scripts/swf_to_h5.py)）：
1. **两阶段扫描（Pass 1 先提取图片与字体，Pass 2 再转图形与文本）**：
   - 确保所有 `DefineBitsLossless` (20/36)、`DefineBitsJPEG2/3` (21/35) 与 `DefineFont3` (75) 在解析 `DefineShape` 和 `DefineText` 之前 100% 就绪。
2. **位图填充矩阵 `patternTransform` 单位换算（切勿乘 20！）**：
   - SWF 位图填充矩阵 `bmat[0..3]` 的单位是 **twips/pixel**（标准 `1:1` 为 `20.0`），而 SVG `<path>` 坐标已经除以 `20.0` 转为像素，因此 `<pattern patternTransform="matrix(...)">` 的前 4 个分量**必须除以 `20.0`（`bmat[0] / 20.0`）**，切勿乘以 `20`（否则位图会被放大 400 倍导致画面缺失）。
   - 遇到 `bmp_id == 0xFFFF` 无效位图占位填充时，输出透明填充（`opacity: 0.0`），避免产生 `#cccccc` 灰色遮挡块。
3. **`DefineBitsJPEG3` (35) Alpha 通道与尺寸还原**：
   - 解压 `alpha_off` 之后的 zlib 透明通道并与 JPEG 合并导出为带精确宽高的 RGBA `.png`。
4. **`DefineMorphShape` (46) 与 `DefineMorphShape2` (84) 补间形状导出**：
   - 导出 `shape_{cid}.svg` 并在 `scene.json` 的 `morphs` 中记录 `startBounds` 与 `endBounds`，确保 `help_mc` 提示卷轴展开遮罩与动态生长线条完整显示。
5. **整数 Twips 顶点闭合拼接与 `newStyles` 批次刷新**：
   - 以精确整数 twips 追踪顶点坐标再拼接闭合路径 `Z`；遇到 `flags & 0x10`（`newStyles`）时先 flush 当前批次 `<path>` 再递增 `batch_idx` 生成唯一渐变/图案 ID（`grad_{shape_id}_{batch_idx}_{i}`）。

---

### Step 4：纯 H5 渲染器与 `.as` 直接解析运行时（核心机制）

`resources/h5_template/` 中的核心组件协同工作：

1. **[as3-runtime.js](./resources/h5_template/js/as3-runtime.js)（浏览器端直接解析 `script.as`）**：
   - 结合 `scene.json` 的 `symbols`（`SymbolClass` 映射），将 `script.as` 中的每个类精确绑定到对应的元件 `cid`，并记录 `superClassByCid`（识别 `mc_cla` / `mc_box` 等子类）。
   - 提取每个 `cid` 的 **`addFrameScript(frameIdx0, fn)`**（如 `stop()`、播放结束重置父级 `Object(parent).tips_btn.gotoAndStop(1)`），生成 `frameScriptsByCid`。
   - 精确提取各类交互规则：
     - **拖拽题 5 种细分规则**：`hideHInInit`（`h` 槽位初始是否隐藏，区分隐藏槽位与第 1 帧可见底框）、`hideDragOnMatch`（匹配后拖拽物是否隐藏或可重复拖出）、`dragDownFrame2`、`hGotoOnMatch`（`id_plus_1` / `frame2` / `nextFrame`）、`matchRule`（`id_eq_index` / `prefix` 首字母匹配 / `le_index` 帧累加 / `orderHs` / `any_empty`）及 `hideMccInInit`。
     - **复合模板识别**：`dual_sub_drag`（`2-2` 第 4 页 `mc1` + `mc2` 双子画板）、`lx_connect`（`7-3` 第 1 页 `Lx_all` 物品归类连线）、`ordered_click`（`8-2` 单组与双组 `a->b/c + mcc` & `b->d + mcc1` 按序点击）、`click_toggle`（`12-2` 第 2 页点击切换第 1/2 帧）、`pen_draw`（`10-3` / `16-3` `_huabi` 两帧画板）、`multi_select`（含 `playEndMc` 判断）。

2. **[renderer.js](./resources/h5_template/js/renderer.js)（SVG + WebAudio 渲染引擎）**：
   - **同深度（`depth`）替换属性继承（SWF `PlaceObject2 Move+HasCharacter`）**：当某帧在同一 `depth` 替换 `cid` 但未重复提供 `matrix` / `cxform` / `name` / `clipDepth` 时，严格继承该 `depth` 原有属性，并在跳帧时按目标帧累计状态增量更新 DOM、自动清理销毁的子 `SwfMovieClip`。
   - **受控并发预加载池**：`preloadAssets()` 采用 12 并发工作池 + 自动重试机制，避免 200+ SVG 同时请求打满连接队列。
   - **跨 SVG ID 隔离、遮罩展平与 Morph `ratio` 插值**：自动为 `grad_*`、`pat_*`、`clip_*`、`cxf_*` 添加实例前缀；`<clipPath>` 直接展平几何节点不嵌套 `<g>`；支持 `DefineMorphShape` 按 `ratio / 65535` 动态插值。

3. **[game-engine.js](./resources/h5_template/js/game-engine.js)（全量 AS3 交互模板还原）**：
   - 完整实现 `animation`（含点击进度条 `rect` 跳帧与拖拽滑块）、`drag_match`（全部 5 种细分规则）、`dual_sub_drag`、`drag_two_stage`、`lx_connect`、`pair_line_reveal` / `pair_line_draw`（含 `t.gotoAndStop(2)`）、`multi_select`、`click_toggle`、`ordered_click`（单组与双组）、`free_drag_puzzle`、`pen_draw`（`_huabi` 展开/收起、5 色画笔、橡皮擦、粗细滑块、清空）与 `demo_page`。

4. **[launcher.js](./resources/h5_template/js/launcher.js) & [server.py](./resources/h5_template/server.py)**：
   - 进入课时（UI 第 3 帧）时保持右上角原生 Flash `Return_btn` 悬浮于课时画布上方（对齐 `Main.as` 中 `container.addChild(_loader)` 的层级关系）。
   - 片头 `00.mp4` 延迟到主界面就绪后加载，若浏览器拦截有声自动播放则自动静音回退或直接进入主菜单，杜绝黑屏遮挡。
   - `server.py` 提供双栈（IPv6 `::1` + IPv4 `127.0.0.1`）高并发（`request_queue_size = 128`）HTTP/1.1 服务，支持 `206 Partial Content` 视频流分片、禁用 `304` 缓存卡顿、自动关闭 Windows 终端快速编辑模式防假死，并静默处理流媒体中断异常。

---

## 验证清单

- [ ] `h5/` 目录内无任何 `.swf` 文件，每节课时包含 `scene.json`、`lesson.json`、`script.as` 与 `assets/`，且全部 `scene.json` 缺失 `cid` 数为 `0`。
- [ ] 位图填充 `patternTransform` 比例正常（無 400 倍放大导致的素材消失），同 `depth` 换帧元件位置与缩放正确。
- [ ] 主菜单无 `yp` 白屏或片头黑屏遮挡，课时内右上角原生返回按钮 `Return_btn` 正常显示可点。
- [ ] `-1` 动画课时内框画面正常显示、音画同步、进度条可点击跳帧与拖拽。
- [ ] `-2` / `-3` 互动课时 `yx1..yxN` 独立分页不重叠，`help_mc` 卷轴遮罩正常展开，全部拖拽、连线、双组点选、双子画板与 `_huabi` 调色画板均与原版 Flash 逻辑一致。
