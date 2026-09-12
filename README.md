# Win Duo

> 合盖的时候，屏幕上的画面会像 **iPhone Duo** 那样折起来、变模糊、暗下去——
> 而且是**跟着你真实的手**一起动的。你合到哪，它折到哪；你停住，它停住；你开盖，它展平回来。

![四个角度：平放、以及逐渐折叠的三个阶段](docs/f55f1429abb315d9c062dcc052f23f8c.mp4)

---

# ⬇️ 下载

| 下载方式 | 链接 |
|---|---|
| **百度网盘**（国内推荐） | **[WinDuo-0.1.0.zip](通过网盘分享的文件：win duo 链接: https://pan.baidu.com/s/1tDfUUz9QfUJrZYEEq9Bzww?pwd=1y3c 提取码: 1y3c --来自百度网盘超级会员v1的分享)**　 |
| **GitHub Releases** | [最新版](../../releases/latest)（不用登录，但国内可能慢） |

下载下来是一个压缩包，**解压后双击里面的 `WinDuo-Portable-0.1.0.exe`** 就能用。
不需要安装，不需要管理员权限，不改系统文件——它是一个绿色程序，不想要了直接删掉就行。

---

# 三步就能用

**第一步：双击 `WinDuo-Portable-0.1.0.exe`**

- 如果 Windows 弹出蓝色的「Windows 已保护你的电脑」，点 **更多信息** → **仍要运行**。
  这是因为程序没买数字签名（一年几百到几千块），**不代表它有病毒**。
- 双击后**不会出现窗口**。它待在右下角任务栏的托盘里——可能要点一下那个向上的小箭头才看得到。
  图标是一个蓝色的折叠屏。

**第二步：按 `Ctrl + Alt + D`**

屏幕底部会出现一个小提示：**已待命 · 慢慢合盖**。这时候摄像头指示灯会亮起来。

**第三步：慢慢合盖**

画面会跟着你的手折起来。停住 → 它就停在那个角度；开盖 → 它展平回来。

- 想中途结束：按 **`Esc`**
- 想退出程序：右键点托盘图标 → **退出**

---

# ⚠️ 用之前请先改一个系统设置

Windows 默认在你合盖的**瞬间**就让电脑睡眠，那样效果根本来不及看见。

> **控制面板 → 电源选项 → 选择关闭盖子的功能**
> 把「关闭盖子时」的**两个下拉框都改成「不采取任何操作」**

改完之后合盖时屏幕会一直亮着，效果才看得见。

---

<details>
<summary><b>它是什么 / 为什么需要摄像头？（点开看）</b></summary>

这是 macOS 上 [Mac Duo](https://github.com/sumimakito/Mac-Duo)（作者 Makito）的 **Windows 移植版**。

MacBook 有专门的合盖角度传感器，所以它的效果能严丝合缝跟着你的手走。
**普通 Windows 笔记本没有这个传感器**，所以这里改用**摄像头**来推算角度：

> 每台笔记本的摄像头都是刚性固定在盖子上的。盖子转多少度，摄像头就转多少度，
> 画面里的场景就会整体平移——这个关系是几何必然，跟耳机、网线、房间光线通通无关。

摄像头指示灯**只在效果运行期间亮**（从按 `Ctrl+Alt+D` 到按 `Esc`）。
它在本地实时算一个数字来判断角度，**画面一帧都不保存、不缓存、不上传**。

</details>

---

**目录**：[常见问题](#常见问题) · [想调效果](#想调效果) · [给写代码的人](#给写代码的人) · [开发过程](docs/BUILD-LOG.md) · [English](#english)

---

## 常见问题

**摄像头指示灯一直亮着，正常吗？**

正常，但**只在效果运行期间亮**（从你按 `Ctrl+Alt+D` 到按 `Esc` 结束）。它在本地实时算一个数字来判断角度，
**画面一帧都不保存、不缓存、不上传**。程序退出后灯就灭了。

之所以要按快捷键，正是因为摄像头指示灯是硬件直连的、软件关不掉。如果让它常年开着，你才能"直接合盖就跟随"，
但那盏灯就会一直亮着——所以改成按一下"待命"，用完立刻灭。

**按了 `Ctrl+Alt+D` 没反应？**

多半是快捷键被别的软件占了。右键托盘图标 → **设置** → 改「全局快捷键」。

**合盖了，但画面没动？**

先看屏幕**左下角的实时读数**，它会把原因直接告诉你：

| 读数 | 说明 |
|---|---|
| `行程 0` | 摄像头没看到画面变化。可能是镜头被挡片挡住，或者有别的程序（会议软件、浏览器）正占着摄像头 |
| `q` 值很低（例如 `q0.24`） | 画面太单调，摄像头没有可参照的东西。房间里正常的光线和家具就够 |
| 数字在动，但画面不动 | 「跟手强度」太小，调大一点 |

**合到底之后画面变得很黑？**

这是**故意的，而且可以调**：折叠在 50° 就封顶了，再往下合画面不再变深（不然黑会吃掉整个屏幕）。
如果你觉得最深处还是太黑，把「最大压暗」调小。

**怎么卸载？**

右键托盘图标 → 退出，然后把文件夹删掉。
设置存在 `C:\Users\你的用户名\AppData\Roaming\Win Duo\settings.json`，想彻底清干净就把它也删掉。

---

## 想调效果

右键托盘图标 → **设置**。所有滑块都是**即时生效**的，可以一边合盖一边调。

最常用的四个：

| 滑块 | 作用 | 什么时候动它 |
|---|---|---|
| **跟手强度** | 盖子动同样多时画面折多少 | 折得太少或太满 |
| **最大模糊半径** | 最糊的时候有多糊 | 糊成一片看不清 → 调小 |
| **最大压暗** | 远端最终有多黑 | 太黑 → 调小 |
| **静止角** | 你平时使用时的盖子角度 | 合盖刚开始就有模糊 → 改成你实际的坐姿角度 |

还有一个「**平整区间**」：静止角两侧这个范围内画面**完全平整、零模糊**，
适合你工作时盖子会在一个小范围里活动的情况。

![设置面板](docs/settings.png)

---

## 给写代码的人

环境要求：Windows 10 2004 及以上、Node 18+、一个摄像头、任意支持 WebGL2 的显卡。

```sh
git clone https://github.com/hang1025/win-duo.git
cd win-duo
npm install
npm start
```

然后按 `Ctrl+Alt+D`，或点托盘图标。

> **国内网络**：Electron 的二进制下载容易卡住，先挂镜像：
> `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`

打包成单文件便携 exe：

```sh
npm run dist        # 生成 dist/WinDuo-Portable-<version>.exe
npm run pack:share  # 生成 share/WinDuo-<version>.zip（exe + 使用说明.txt）
```

`npm run shortcut` 会在桌面建一个带图标的快捷方式，直接指向 Electron 二进制而不是 `npm start`——
因为 Electron 是 GUI 程序，这样启动不会在背后留一个黑色控制台窗口。

### 角度是怎么读出来的

Mac Duo 读的是真实的角度传感器（Apple `AppleSPUHIDDevice`，HID usage page `0x20` / usage `0x8A`）。
**普通 Windows 笔记本没有对应的东西**：Windows 有 `Windows.Devices.Sensors.HingeAngleSensor`，
但官方定义是"**双屏设备**的铰链角度传感器"，是给 Surface Duo / Neo 那类硬件用的。

实测确认过：把 14 个 `Windows.Devices.Sensors` 类逐个探测，这台机器上**0 个有实例**——
没有铰链角度，没有加速度计，也没有环境光传感器。

所以角度只能从别的地方来，而且必须来自**每台机器上都有的东西**：

> 每台笔记本的摄像头都是**刚性固定在盖子上**的。盖子转 Δθ，摄像头就转 Δθ，
> 画面里的整个场景随之平移约 f·tan(Δθ)——在 640 像素宽、60° 视场下**每度约 9 个像素**。

这是几何必然，跟耳机、网线、房间光线、连着哪个 Wi-Fi 通通无关。另外三个候选都实测排除了：

| 候选 | 为什么不能用 |
|---|---|
| 环境光传感器 | 大多数笔记本根本没有 |
| 扬声器→麦克风 | 3.5mm 耳机口**在物理上会断开内置扬声器**——戴着耳机的人直接让它失效，而这是常态 |
| Wi-Fi RSSI | 必须连着 AP、天线还得恰好在盖子里，多径还会让它非单调 |

难的地方不在几何，而在于**合盖的人自己也在画面里，而且动得比盖子多**：

1. 画面缩到 160×120，切成 **8 条竖带**
2. 每条竖带各自求位移，取 8 条的**中位数**——手和头只污染其中几条，用均值会被它们拖走
3. 太"平"（白墙、漆黑天花板）或置信度不足的竖带直接丢弃
4. **死区放在累加器上**，而不是每帧——每帧阈值会让 120Hz 屏上的慢速合盖被当成噪声丢掉
5. **不假设符号**：画面往哪边移动取决于摄像头怎么装的，方向从本次运行的最大位移里判定
6. 合上瞬间跟随、打开按 250ms 时间常数滑——非对称跟随，既挡住噪声又不会一跳一跳
7. 每次待命都**重新归零**，跨次运行的漂移不会累积

实测（慢慢合盖）：**信噪比 106:1**，3 次合盖全部单调，"盖住不动"时漂移只有行程的 **4%**。

### 效果是怎么做出来的

角度之外的全部，都是 Mac 版的数学按顺序移植过来：

1. **拿到画面** — 在覆盖层显示**之前**截一张屏，所以这张图永远不可能拍到覆盖层自己
2. **算出画面落在哪里** — 把画面当成以屏幕下边缘为轴的板子，眼睛是房间里固定的点
3. **四个角点变成矩阵** — Heckbert 的 square-to-quad，把逆矩阵传给 shader
4. **一个 fragment shader 完成全部观感** — 逆单应采样 + 按高度取 mip 做模糊 + 按高度压暗
5. **抹平** — 临界阻尼弹簧；覆盖层是一个透明、穿透点击、永远置顶、永不抢焦点的窗口

待命期间覆盖层透明度保持为 0，桌面**保持是活的**（不会被一张冻结的截图替换），
淡入正好落在一张没被动过的桌面上——因为平放的那一帧和桌面像素级一致，你什么也看不见。

### 主要参数

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `angleSource` | `camera` | 跟随真实盖子，或播放脚本动画（摄像头打不开时自动回退） |
| `restAngle` | 105° | 你平时使用时的盖子角度，也是折叠起点 |
| `neutralBand` | 0° | 静止角两侧的平整区间 |
| `foldAngle` | 50° | 折叠封顶角度，再往下合画面不变 |
| `trackerGain` | 1 | 跟手强度 |
| `fullTravel` | 170 | 满行程，每次完整合盖自动重新学习 |
| `viewingDistance` | 3×屏高 | 眼睛距离，3 是平放桌面坐姿的实测值 |
| `recession` | 0.4 | 画面转开比例，真机手感调出来的值 |
| `maxBlurRadius` | 90 px | 满强度模糊半径 |
| `maxDim` | 0.85 | 远端最终黑度 |
| `dimReach` | 0.9 | 压暗饱和高度 |
| `releaseOn` | `auto` | `auto` 盖子回位或超时结束；`key` 只由 `Esc` 结束 |
| `hotkey` | `Ctrl+Alt+D` | 全局快捷键 |

`Esc` **只在一次运行期间**注册为全局快捷键——全局绑定会把它从所有程序手里抢走，
一直挂着会让其他软件的 `Esc` 失效。

### 怎么验证它真的在做正确的事

一个"看起来挺像"的 bug，在有人真的去看之前是隐形的。所以这里的检查分两类：

```sh
npm run selftest          # 把效果在九个角度上渲染成 PNG
npm run selftest:real     # 同上，但用真实截屏
npm run verify            # 播放一次，证明覆盖层确实压在桌面之上
npm run verify:camera     # 不用摄像头也不用盖子，跑通整条实时追踪链路
npm run diagnose:cover    # 把覆盖层涂成纯红，逐点检查它盖住了整个屏幕
npm run shot:fold         # 真实屏幕在六个折角下的截图
npm run check:settings    # 中英双语构建设置页并往返读写
npm run timing            # 测量待命延迟
npm run recon             # 当初用来找到角度源的测量仪器
npm run recon:selftest    # 用已知位移校验追踪器
```

这些检查抓到过的真实问题（详见[开发过程](docs/BUILD-LOG.md)）：

- 追踪器**把位移符号算反了**——而一个反向跟踪的算法在被接进效果之前，看起来和正确的完全一样
- 画面**根本不折**，因为位移方向是假设的而不是判定的
- 通过探针读出 shader 在指定屏幕点的计算结果，才发现画面收缩后没覆盖到的顶部一条带
  把**真实桌面原样透了出来**
- 展开时"冻住 → 跳一下"重复 5 次，是在**一次真实运行的轨迹文件**里发现的，不是靠看画面猜的

每次运行都会把轨迹写进 `%APPDATA%\Win Duo\last-run.json`（每 100ms 一个采样：行程、进度、角度、
置信度、竖带数、帧率）。画面看起来不对的时候，这个文件比截图有用得多。

### 仓库结构

```
src/main/            Electron 主进程
  index.js             启动、托盘、快捷键、触发、标定
  overlay.js           覆盖层窗口：边界、穿透点击、置顶
  capture.js           一次截屏
  defaults.js          所有可调参数
  preferences.js       设置读写
  icon.js              用代码画图标（仓库里没有任何二进制素材）
  selftest.js          把各角度渲染成 PNG
  verify.js            证明覆盖层合成在桌面之上
  verify-camera.js     不用摄像头也不用盖子，验证实时链路
  diagnose-cover.js    证明覆盖层盖住了整个屏幕
  shot-fold.js         真实屏幕在各折角下的截图
  timing.js            测量待命延迟
  check-settings.js    设置页冒烟测试
src/renderer/        效果本体
  overlay.js           WebGL2、帧循环、待命/追踪/释放策略
  lib/lid-tracker.js   摄像头追踪器（与侦察器共用）
  lib/geometry.js      画面落在哪里
  lib/homography.js    四个角点 -> 射影矩阵
  lib/shader.js        整个观感，一个 fragment shader
  lib/spring.js        临界阻尼弹簧
  lib/gradient.js      模糊与压暗曲线
src/shared/strings.js  中英界面文案
tools/lid-recon/     当初用来找到角度源的测量仪器
tools/               打包、快捷方式、抽帧、文档配图等
```

### 已知限制

- **待命需要按一下快捷键。** 摄像头指示灯是硬件直连、软件关不掉的，所以摄像头只在一次运行期间工作。
  这排除了"直接合盖就跟随"。
- **约 0.5 秒待命延迟**，几乎全部是 Chromium 那一次性的截屏。
- **追踪器需要有东西可看。** 整个画面是一面白墙时它没有东西可以做相关，读数里的 `q` 会说这件事。
- **独占全屏程序**盖不住，全屏游戏会把覆盖层整个遮掉。
- **不做 HDR 色彩管理**。请关掉 HDR，否则画面和它盖住的桌面会对不上。
- **一次只作用于一块屏**。
- `settings.json` 是持久化的，所以**改了默认值对已经跑过一次的安装不生效**，
  要用设置面板里的「恢复默认」来接收新默认值。

---

## 开发过程

从「看到那个动画」到「真的跟着手走」，中间踩过的坑、每个 bug 是怎么被发现的、
以及为什么最终选了摄像头而不是别的信号，都写在 **[docs/BUILD-LOG.md](docs/BUILD-LOG.md)**。

---

## 致谢与许可

几何、着色器和调参思路来自 **[Mac Duo](https://github.com/sumimakito/Mac-Duo)（作者 Makito）**。
如果你用的是 MacBook，请直接用 Mac Duo——它读的是真实的铰链传感器，完全不需要摄像头。

两者都以 **Apache License 2.0** 授权。归属声明、以及本移植版逐条改了什么
（这是许可证 4(b) 条的要求），见 `NOTICE`。

---
---

## English

**The iPhone Duo fold effect, on any Windows laptop — following the real lid, with no hinge sensor.**

Close the lid and the picture on screen tilts, blurs and darkens in step with your hand. Stop
and it holds; open and it unfolds. It works by tracking the lid through the built-in webcam,
because no ordinary Windows laptop has a hinge sensor.

**Download.** [Release assets](../../releases/latest) hold a single portable `.exe`, and a `.zip`
of the same executable with a Chinese walkthrough beside it. Nothing to install, no admin rights,
nothing added to the system.

**Quick start:** run `WinDuo-Portable-<version>.exe`, press `Ctrl+Alt+D`, close the lid slowly.
`Esc` ends a run. Set *Control Panel → Power Options → Choose what closing the lid does* to
**Do nothing** first, or the machine sleeps before you see anything. Windows shows "Windows
protected your PC" the first time — click **More info → Run anyway**, which is only because the
binary is not code signed. The Chinese section at the top of this file has the full walkthrough
and troubleshooting.

**From source:**

```sh
npm install && npm start     # then Ctrl+Alt+D
npm run dist                 # dist/WinDuo-Portable-<version>.exe
npm run pack:share           # share/WinDuo-<version>.zip, for people without Node
```

**How the angle is read.** Every laptop webcam is rigidly fixed to the lid, so rotating the lid
by Δθ rotates the camera by Δθ and the whole scene slides across the frame by about
f·tan(Δθ) — roughly nine pixels per degree at 640 px and a 60° field of view. That is geometry,
not luck, which is why it survives headphones, cabling, room lighting and Wi-Fi. Three other
candidates were measured and rejected: most laptops have no ambient light sensor at all, the
3.5 mm jack physically disconnects the internal speakers so anyone wearing headphones breaks the
acoustic path, and Wi-Fi RSSI needs a live association and an antenna in the lid and is not
monotonic anyway.

The hard part is that the person closing the lid is also in the frame, moving more than the lid
does. The frame is cut into eight vertical strips, each correlated on its own, and the median is
taken, so a hand or a head only corrupts the strips it covers. Strips too flat or too uncertain
to correlate are dropped. The deadband sits on the running accumulator rather than on each
frame, because a per-frame threshold discards the small per-frame motion of a slow close on a
120 Hz panel. The direction of travel is latched from the largest excursion rather than assumed.
Closing follows instantly and opening follows through a 250 ms lag, which damps noise without
stepping. The tracker is re-zeroed on every arm so drift cannot accumulate.

Measured: **106:1 signal-to-noise**, monotonic in 3 of 3 closes, and the value wanders only
**4%** of its travel while the lid is held still. Nothing is recorded — frames are processed in
memory and only a single number leaves the tracker.

**Everything else** is the Mac version's maths, ported in order: one screen grab taken before the
overlay appears, a projective map from four projected corners, one fragment shader doing the
inverse homography plus a per-pixel mip level for the blur and a height-dependent dimming, and a
critically damped spring to smooth it.

**Verification.** `npm run selftest` renders the effect at nine angles to PNG; `verify` and
`diagnose:cover` prove the overlay composites above the desktop and covers the whole screen;
`verify:camera` drives the entire live path against a generated scene, with no camera and no
hand. These have caught a tracker following a known displacement with the wrong sign, a fold
that never happened because the direction of travel was assumed, and a strip at the top of the
screen where the contracted picture left the untouched desktop showing through. Every run also
writes a 100 ms trace to `last-run.json`, which is how a stepping unfold was found.

**Limitations.** Arming needs a hotkey, because the camera light is hardware-wired and cannot be
on permanently. Roughly 0.5 s of arming latency, almost all of it Chromium's one-shot screen
grab. The tracker needs something to look at. No HDR colour management. One display at a time.

**Licence.** Apache-2.0. A Windows port of [Mac Duo](https://github.com/sumimakito/Mac-Duo) by
Makito; see `NOTICE` for the attribution and the per-file list of changes.
