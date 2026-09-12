# Win Duo

**The iPhone Duo fold effect, on any Windows laptop. No hinge sensor required.**

[English](#english) · [简体中文](#简体中文)

![The effect at four angles: flat, then progressively folded, blurred and dimmed towards the far edge](docs/fold-progression.png)

*Rendered by `npm run selftest` — four angles of the same picture, from flat to fully folded.*

---

## English

### What it is

When Apple shipped the iPhone Duo, the thing people copied was not the hinge — it was the
animation. As the screen folds, the content does not just disappear behind the crease: it
tilts away in perspective, blurs and dims as it recedes, so it reads as one continuous
object moving in a room rather than a panel switching off.

**Win Duo puts that animation on a Windows laptop.** Press a hotkey and your actual desktop
— whatever is on screen at that moment — tilts, blurs, darkens and folds back, then unfolds
and hands the screen back to you untouched.

The whole app is about 2,300 lines of JavaScript, and the effect itself is six files totalling
roughly 750. No native modules, no compiler, no Visual Studio, no administrator rights.
Every pixel is computed by one fragment shader.

### The honest bit

Mac Duo, the reference implementation for macOS, reads a real **lid angle sensor**: an Apple
`AppleSPUHIDDevice` (HID usage page `0x20`, usage `0x8A`) that reports the hinge angle
0–360° at roughly 10 Hz. That is why it can follow your hand exactly as you close the lid.

**A normal Windows laptop has nothing equivalent.** Windows does have a hinge angle API,
but [`Windows.Devices.Sensors.HingeAngleSensor`][hinge] is documented as *"the hinge angle
sensor in a **dual-screen device**"* — it exists for Surface Duo and Neo class hardware. On
a consumer laptop there is no hinge sensor at all; the lid is a binary hall switch that
reports open or shut and nothing in between.

So Win Duo does the only honest thing: it replaces the sensor with a **scripted angle
sweep** and triggers on demand. Everything downstream of the angle — the projection, the
shader, the spring — is exactly what the Mac version does. The effect looks the same. It
just does not track your hand, because on this hardware nothing can.

That is also why it is triggered by a hotkey rather than by closing the lid: Windows turns
the display off the moment the lid shuts, so even a perfect lid listener would have nothing
left to draw on.

### Quick start

```sh
git clone https://github.com/<you>/win-duo.git
cd win-duo
npm install
npm start
```

Then press **`Ctrl+Alt+D`**, or click the tray icon.

The app lives in the tray. There is no main window: the tray menu has *Play the fold*,
*Settings…*, *Enabled*, *Start at login* and *Quit*.

> **In China?** Electron's binary download can stall. Point npm at a mirror first:
> `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` (Windows) or
> `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` (macOS/Linux).

Requirements: Windows 10 2004 or newer, Node 18+, and any GPU that can do WebGL2.
It also runs on macOS and Linux, where the screen capture path still works.

### How the effect works

Five pieces, and only the first one is different from the Mac version.

**1 — Get the picture.** One screen grab (`desktopCapturer`) taken *before* the overlay is
shown, so the picture can never contain the overlay itself.

**2 — Decide where the picture lands.** The picture is a sheet hinged to the bottom edge of
the screen. The eye is a fixed point in the room; the glass turns under it. Projecting the
sheet back onto the glass gives four points:

```js
const travel     = Math.max(startAngle - currentAngle, 0);
const separation = Math.min(recession * travel, 88) * DEG;
const reach      = height * viewingDistance + height / 2 * Math.cos(start);
const rise       = height / 2 * Math.sin(start);
const along      = reach * Math.cos(current) + rise * Math.sin(current);
const depth      = Math.max(reach * Math.sin(current) - rise * Math.cos(current), height / 10);

const project = (x, y) => {
  const scale = depth / (depth + y * Math.sin(separation));
  return [half + (x - half) * scale, along + (y * Math.cos(separation) - along) * scale];
};
```

**3 — Turn four points into a matrix.** Heckbert's square-to-quad solution gives a
projective map from the rectangle onto that quadrilateral. Upload its **inverse** to the
shader, so the shader can ask, for each screen pixel, *which pixel of the picture do I show
here?*

**4 — One fragment shader does the whole look.**

```glsl
vec2 picturePoint = (uScreenToPicture * vec3(screenPoint, 1.0)).xy / mapped.z;

float height = clamp(picturePoint.y / uScreenSize.y, 0.0, 1.0);   // 0 at the hinge, 1 at the far edge
float blur   = uBlurStrength * (uBlurFloor + (1.0 - uBlurFloor) * height);
float mip    = clamp(log2(max(blur * uMaxRadius, 1.0)), 0.0, uMaxLevel);

vec4 colour = textureLod(uPicture, texCoord, mip);
colour.rgb *= (1.0 - uMaxDim * fade);   // fade rises with height, through a smoothstep
```

The height gradient is the whole trick: near the hinge the picture stays sharp and bright,
and towards the far edge it blurs and goes black. Combined with the perspective contraction
that reads as one surface folding away, not as a fade-out.

The blur comes free: the picture is uploaded once with 120 points of black margin around it
and a mip pyramid built over the result, so "blur by this much here" is just
`textureLod` at the matching level. Interpolating between levels hides the blockiness a
halving pyramid would otherwise show at large radii.

**5 — Smooth it.** A critically damped spring turns the stepped angle into a per-frame
value, and the overlay is a transparent, borderless, click-through, always-on-top window
that never takes focus.

### Settings

The settings panel writes to `settings.json` in Electron's user data directory. The ones
worth touching first:

| Setting | Default | What it does |
| --- | --- | --- |
| `thresholdAngle` | 90° | The fold starts once the angle drops below this. |
| `blurSpan` | 60° | More degrees of travel to reach full blur. |
| `viewingDistance` | 6× screen height | Eye distance. **This is the one to tune.** Lower is a stronger perspective; set it to roughly your real eye distance divided by your screen height (sitting at a desk ≈ 3). |
| `recession` | 1 | Degrees the picture turns away per degree of lid travel. |
| `maxBlurRadius` | 135 px | Blur radius at full strength. |
| `maxDim` | 1.0 | How black the far edge goes. |
| `blurEvenness` | 0 | Blur at the hinge edge as a fraction of the far edge. |
| `sweepClosing` / `sweepHold` / `sweepOpening` | 1.2 / 0.5 / 0.8 s | The scripted sweep the hotkey plays. |

The defaults deliberately stop folding at 45° rather than going to a shut lid. Past roughly
45° the picture is mostly black — correct for a lid that is nearly closed, but it reads as a
glitch when nothing physical is moving. `npm run selftest` dumps every angle so you can pick
your own stopping point.

### Checking it actually works

Two of these are automated and one of them is the reason this project was possible to write
without a second machine to compare against.

```sh
npm run selftest        # renders the effect at ten angles to selftest-output/*.png
npm run selftest:real   # the same, from a real screen grab instead of a drawn test pattern
npm run verify          # plays a run and proves the overlay composites above the desktop
npm run check:settings  # builds the settings page in both languages and round-trips a value
npm run timing          # measures hotkey-to-first-frame latency
```

`selftest` is the important one. The geometry is easy to get subtly wrong — a flipped axis
or a transposed matrix still produces a plausible-looking warp — so the test draws a grid
with a red bar on top, a green bar at the bottom and labelled edges, and dumps it. If the
red bar ever appears at the bottom, something is transposed.

`verify` never looks at your screen contents. It grabs the screen before and during a run
and compares only the average brightness of horizontal bands; a working run darkens the top
band far more than the bottom one.

Measured on a 2560×1600 laptop at 150% scaling:

```
+   0ms  grabbing the screen
+ 501ms  screen grabbed
+ 524ms  handed to the overlay
+ 612ms  picture-built        (16.4 MB bitmap swapped, uploaded, mipmapped)
+ 614ms  first-frame
```

So about **0.6 s from hotkey to first frame, and 0.5 s of that is Chromium's one-shot screen
grab.** That cost is a session setup, not a transfer: it measured 470–550 ms whether the
thumbnail was requested at 854×534 or 2561×1601. Removing it would mean keeping a live
capture stream running while idle, which trades half a second for a permanently open screen
capture session. For a novelty effect that seemed like the wrong trade.

### Repository layout

```
src/main/         Electron main process
  index.js          boot, tray, hotkey, IPC, the trigger
  overlay.js        the overlay window: bounds, click-through, always-on-top
  capture.js        one screen grab
  defaults.js       every tunable, with the ported defaults
  selftest.js       renders angles to PNG
  verify.js         proves the overlay composites
  icon.js           draws the tray icon in code (no binary assets in the repo)
src/renderer/     the effect
  overlay.js        WebGL2 setup, the frame loop, the sweep
  lib/geometry.js   where the picture lands
  lib/homography.js four corners -> projective matrix
  lib/shader.js     the whole look, in one fragment shader
  lib/spring.js     critically damped spring
  lib/gradient.js   blur and dimming curves
src/shared/strings.js   English and Chinese UI strings
tools/            diagnostics (capture benchmark, bounds probe, docs image)
```

### Known limitations

- **About 0.5 s of latency** between the hotkey and the first frame, as measured above.
- **Panel viewing angle.** Past roughly 40° the image washes out on most laptop panels. The
  effect assumes you watch from where you actually sit; that is what `viewingDistance` is for.
- **Exclusive-fullscreen applications** are not covered, and fullscreen games will hide the
  overlay entirely.
- **HDR is not colour managed.** Turn HDR off, or the picture will not match the desktop it
  lands on.
- **One display at a time.** Pick primary or the display under the cursor in settings.
- The screenshot is taken before the overlay appears, so it is always of the real desktop.
  Taskbar clocks and animating windows will therefore differ slightly from the live screen
  for the fraction of a second the picture is flat.

### Credits and licence

This is a **Windows port of [Mac Duo][macduo] by [Makito][makito]**, which is the original
implementation and the source of the geometry, the shader and the tuning defaults. If you
are on a MacBook, use Mac Duo — it reads the real lid sensor and is better in every way that
matters on that hardware.

Both are licensed under the Apache License 2.0. See `NOTICE` for the attribution and for a
point-by-point list of what changed in this port, as section 4(b) of the licence requires.

[hinge]: https://learn.microsoft.com/en-us/uwp/api/windows.devices.sensors.hingeanglesensor
[macduo]: https://github.com/sumimakito/Mac-Duo
[makito]: https://github.com/sumimakito

---
---

## 简体中文

### 这是什么

苹果发布 iPhone Duo 之后，大家复刻的其实不是铰链，而是那个**动画**。屏幕折起来的时候，内容不是简单地被折痕挡住消失，而是带着透视向后倒、越远越糊越暗——看起来像一块连续的物体在空间里转动，而不是一块屏幕被关掉。

**Win Duo 把这个动画搬到了 Windows 笔记本上。** 按一下快捷键，你**当前真实的桌面**（屏幕上此刻是什么就是什么）会向后倾斜、变糊、变暗、折起，然后重新展平，把屏幕原样还给你。

整个程序大约 2300 行 JavaScript，其中效果本体是六个文件、合计约 750 行。没有原生模块，不需要编译器，不需要 Visual Studio，不需要管理员权限。每一个像素都由一个 fragment shader 算出来。

### 一句实话

macOS 上的参考实现 Mac Duo 读的是**真实的合盖角度传感器**：一个 Apple `AppleSPUHIDDevice`（HID usage page `0x20`，usage `0x8A`），以约 10Hz 直接把铰链角度 0–360° 报出来。所以它能严丝合缝地跟着你的手走。

**普通 Windows 笔记本没有对应的东西。** Windows 确实有一套合盖角度 API，但 [`Windows.Devices.Sensors.HingeAngleSensor`][hinge] 的官方定义是 *"**双屏设备**的铰链角度传感器"*——它是给 Surface Duo / Neo 这类硬件准备的。消费级笔记本上根本没有角度传感器：盖子就是一个二值霍尔开关，只会告诉你"开"或"关"，中间什么都没有。

所以 Win Duo 只做了一件老实的事：**用一段脚本化的角度扫掠替掉传感器**，按需触发。角度之后的所有环节——投影、shader、弹簧——和 Mac 版一模一样。效果看起来是一样的。它只是不跟着你的手走，因为在这类硬件上没有任何东西能跟。

这也正是它用快捷键触发、而不是"合盖触发"的原因：Windows 在盖子合上的瞬间就会关掉屏幕，所以哪怕你有一个完美的合盖监听器，也没有屏幕可以画了。

### 快速开始

```sh
git clone https://github.com/<you>/win-duo.git
cd win-duo
npm install
npm start
```

然后按 **`Ctrl+Alt+D`**，或者点托盘图标。

程序常驻托盘，没有主窗口。托盘菜单里有「播放开合效果」「设置…」「启用效果」「开机时启动」「退出」。

> **国内网络**：Electron 的二进制下载容易卡住，先挂镜像：
> `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（Windows），
> `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（macOS/Linux）。

环境要求：Windows 10 2004 及以上、Node 18+、任意支持 WebGL2 的显卡。在 macOS 和 Linux 上也能跑（截屏那条路径同样有效）。

### 效果是怎么做出来的

一共五步，只有第一步和 Mac 版不同。

**1 — 拿到画面。** 在覆盖层显示**之前**截一张屏（`desktopCapturer`），所以这张图永远不可能拍到覆盖层自己。

**2 — 算出画面落在哪里。** 把画面当成一块以屏幕下边缘为轴的板子，眼睛是房间里一个固定的点，玻璃在眼睛下方转动。把板子投影回玻璃平面，得到四个角点：

```js
const travel     = Math.max(startAngle - currentAngle, 0);
const separation = Math.min(recession * travel, 88) * DEG;
const reach      = height * viewingDistance + height / 2 * Math.cos(start);
const rise       = height / 2 * Math.sin(start);
const along      = reach * Math.cos(current) + rise * Math.sin(current);
const depth      = Math.max(reach * Math.sin(current) - rise * Math.cos(current), height / 10);

const project = (x, y) => {
  const scale = depth / (depth + y * Math.sin(separation));
  return [half + (x - half) * scale, along + (y * Math.cos(separation) - along) * scale];
};
```

**3 — 四个点变成一个矩阵。** 用 Heckbert 的 square-to-quad 解法得到「矩形 → 那个四边形」的射影映射，然后把它的**逆矩阵**传给 shader。这样 shader 就能反过来问：屏幕上这个像素，该显示画面里的哪个像素？

**4 — 整个观感由一个 fragment shader 完成。**

```glsl
vec2 picturePoint = (uScreenToPicture * vec3(screenPoint, 1.0)).xy / mapped.z;

float height = clamp(picturePoint.y / uScreenSize.y, 0.0, 1.0);   // 0 在铰链边，1 在远端
float blur   = uBlurStrength * (uBlurFloor + (1.0 - uBlurFloor) * height);
float mip    = clamp(log2(max(blur * uMaxRadius, 1.0)), 0.0, uMaxLevel);

vec4 colour = textureLod(uPicture, texCoord, mip);
colour.rgb *= (1.0 - uMaxDim * fade);   // fade 随高度上升，走 smoothstep
```

**按高度做渐变就是全部的诀窍**：靠近铰链的地方画面保持清晰明亮，越往远端越糊越黑。叠加上透视收缩，读起来就是"一整块表面在折走"，而不是"淡出"。

模糊是白送的：画面只上传一次，四周留 120 点黑边，然后对整张图建 mip 金字塔。「这里要糊这么多」就只是按对应层级做一次 `textureLod`。层级之间做插值，还能盖掉减半金字塔在大半径下会出现的块状感。

**5 — 抹平。** 一个临界阻尼弹簧把阶跃的角度变成逐帧的连续值；覆盖层是一个透明、无边框、穿透点击、永远置顶、永不抢焦点的窗口。

### 设置

设置面板写入 Electron 用户数据目录下的 `settings.json`。最该先动的几个：

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `thresholdAngle` | 90° | 角度低于这个值开始折。 |
| `blurSpan` | 60° | 再走多少度达到最大模糊。 |
| `viewingDistance` | 6 × 屏高 | 眼睛距离。**最该调的就是这个。** 越小透视越强；设成你真实的观看距离除以屏幕高度（坐着看大约是 3）。 |
| `recession` | 1 | 盖子每转一度，画面转开多少度。 |
| `maxBlurRadius` | 135 px | 满强度时的模糊半径。 |
| `maxDim` | 1.0 | 远端最终的黑度。 |
| `blurEvenness` | 0 | 铰链一侧的模糊，相对远端满值的比例。 |
| `sweepClosing` / `sweepHold` / `sweepOpening` | 1.2 / 0.5 / 0.8 秒 | 快捷键播放的那段脚本扫掠。 |

默认参数故意只折到 45°，而不是折到合上。超过约 45° 之后画面大部分已经黑了——对于一块真的快合上的盖子这是对的，但在没有任何物理运动的情况下，它读起来像 bug。`npm run selftest` 会把每个角度都渲染出来，你可以自己挑一个停手的位置。

### 怎么验证它真的在做正确的事

下面这些是自动化的。其中一条，是这个项目能在没有第二台机器做对照的情况下写出来的原因。

```sh
npm run selftest        # 把效果在十个角度上渲染到 selftest-output/*.png
npm run selftest:real   # 同上，但用真实截屏而不是画的测试图
npm run verify          # 播放一次，并证明覆盖层确实压在桌面之上
npm run check:settings  # 用中英两种语言构建设置页，并往返读写一个值
npm run timing          # 测量热键到首帧的延迟
```

`selftest` 是最重要的那个。这套几何很容易出微妙的错——坐标轴反了或者矩阵转置了，一样能画出一个看起来挺像的扭曲——所以测试图画了网格、顶部一条红杠、底部一条绿杠、四面带字母标注，然后导出成 PNG。**红杠要是跑到底部去了，就是哪里转置了。**

`verify` 完全不看你的屏幕内容：它在播放前后各截一次屏，只比较横向条带的平均亮度。正常工作时，顶部条带会比底部条带暗得多。

在一台 2560×1600、150% 缩放的笔记本上实测：

```
+   0ms  grabbing the screen
+ 501ms  screen grabbed
+ 524ms  handed to the overlay
+ 612ms  picture-built        （16.4 MB 位图完成通道交换、上传、建 mip 金字塔）
+ 614ms  first-frame
```

也就是说 **热键到首帧约 0.6 秒，其中 0.5 秒是 Chromium 那一次性的截屏**。这笔开销是采集会话的建立，不是传输：无论缩略图要 854×534 还是 2561×1601，实测都是 470–550ms。想干掉它就得常驻一条实时采集流，用"永远开着的屏幕采集会话"换这半秒。对一个玩具性质的效果来说，这笔交易不划算。

### 仓库结构

```
src/main/         Electron 主进程
  index.js          启动、托盘、热键、IPC、触发
  overlay.js        覆盖层窗口：边界、穿透点击、置顶
  capture.js        一次截屏
  defaults.js       所有可调参数，带着移植过来的默认值
  selftest.js       把各角度渲染成 PNG
  verify.js         证明覆盖层确实合成在桌面之上
  icon.js           用代码画托盘图标（仓库里没有任何二进制素材）
src/renderer/     效果本体
  overlay.js        WebGL2 初始化、帧循环、扫掠
  lib/geometry.js   画面落在哪里
  lib/homography.js 四个角点 -> 射影矩阵
  lib/shader.js     整个观感，一个 fragment shader
  lib/spring.js     临界阻尼弹簧
  lib/gradient.js   模糊与压暗曲线
src/shared/strings.js   中英界面文案
tools/            诊断工具（截屏基准、窗口边界探针、文档配图）
```

### 已知限制

- **约 0.5 秒延迟**，从按下快捷键到第一帧，数据见上。
- **面板视角**：多数笔记本屏过了约 40° 就开始泛白。这个效果假定你从真正坐着的位置看，`viewingDistance` 就是干这个的。
- **独占全屏程序**盖不住，全屏游戏会把覆盖层整个遮掉。
- **不做 HDR 色彩管理**。请关掉 HDR，否则画面和它盖住的桌面会对不上。
- **一次只作用于一块屏**，设置里可选主屏或鼠标所在屏。
- 截屏发生在覆盖层显示之前，所以它永远是真实桌面的样子。也正因如此，在画面是平的那不到一秒里，任务栏时钟和正在动的窗口会和实时屏幕略有出入。

### 致谢与许可

这是 **[Mac Duo][macduo]（作者 [Makito][makito]）的 Windows 移植版**。Mac Duo 是最初的实现，本项目的几何、shader 和调参默认值都来自它。如果你用的是 MacBook，请直接用 Mac Duo——它读的是真实的角度传感器，在那台硬件上每个方面都更好。

两者都以 Apache License 2.0 授权。归属声明、以及本移植版逐条改了什么（这是许可证 4(b) 条的要求），见 `NOTICE`。

[hinge]: https://learn.microsoft.com/en-us/uwp/api/windows.devices.sensors.hingeanglesensor
[macduo]: https://github.com/sumimakito/Mac-Duo
[makito]: https://github.com/sumimakito
