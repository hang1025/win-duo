'use strict';

/**
 * Builds the folder and zip that get shared outside the repository.
 *
 * The audience for this is someone who does not write code and may not have Node
 * installed, so it contains a single executable and a plain text file that opens
 * in Notepad. Nothing to install, nothing to configure, nothing to run from a
 * command line.
 *
 *   npm run dist
 *   npm run pack:share
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SHARE = path.join(ROOT, 'share');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const GUIDE = `Win Duo 使用说明
========================================

这是什么
----------------------------------------
合盖的时候，屏幕上的画面会像 iPhone Duo 那样折起来、变模糊、暗下去，
而且是跟着你合盖的手一起动的。你停住，画面就停住；你开盖，它就展平回去。

不需要装驱动，不需要管理员权限，不改系统文件。
它是一个绿色程序：双击就能用，不想要了直接把文件删掉就行。


怎么用（三步）
----------------------------------------
1. 双击 WinDuo-Portable-${pkg.version}.exe

   如果 Windows 弹出蓝色的"Windows 已保护你的电脑"：
   点"更多信息" → 点"仍要运行"。
   这是因为程序没有花钱买数字签名，不代表它有病毒。

   程序启动后不会出现窗口，它待在右下角任务栏的托盘里（可能要点一下
   那个向上的小箭头才能看到）。图标是一个蓝色的小折叠屏。

2. 按 Ctrl + Alt + D

   屏幕底部会出现一个小提示："已待命 · 慢慢合盖"。
   这时候摄像头指示灯会亮起来 —— 这是正常的，它要靠摄像头来判断
   你合盖合到哪个角度了。

3. 慢慢合盖

   画面会跟着你的手折起来。停住，它就停在那个角度；开盖，它展平回来。

想中途结束：按一下 Esc。

想退出程序：右键点托盘图标 → 退出。


用之前建议改一个系统设置（很重要）
----------------------------------------
Windows 默认在你合盖的瞬间就让电脑睡眠，那样你就什么都看不到了。

  控制面板 → 电源选项 → 选择关闭盖子的功能
  → "关闭盖子时" 两个都改成 "不采取任何操作"

改完再合盖，屏幕会一直亮着，效果才看得见。


常见问题
----------------------------------------
问：摄像头灯一直亮着，正常吗？
答：只要效果在运行（从按 Ctrl+Alt+D 到按 Esc 结束）它就会亮。
    它在本地实时算一个数字，画面一帧都不保存、不上传。程序退出后灯就灭了。

问：为什么要先按快捷键？
答：因为笔记本的摄像头指示灯是硬件直连的，软件关不掉。如果让它一直开着
    你才能"直接合盖就跟随"，那灯就会常年亮着。所以改成按一下快捷键
    "待命"，用完之后灯立刻灭。

问：按了 Ctrl+Alt+D 没反应？
答：可能被别的程序占用了这个快捷键。右键托盘图标 → 设置 → 全局快捷键，
    改一个别的（比如 Control+Alt+F）。

问：合盖了但画面没动？
答：先看屏幕左下角的实时读数：
    · "行程"一直是 0 → 摄像头没看到画面变化，可能是镜头被挡片挡住，
      或者有其他程序（会议软件、浏览器）正占着摄像头
    · "q"值很低（比如 q0.2）→ 环境太单调，摄像头没有东西可以参照。
      房间里正常的光线和家具就够了
    · 数字在动但画面不动 → 把设置里的"跟手强度"调大

问：效果太强 / 太弱 / 太糊？
答：右键托盘图标 → 设置，里面有滑块，边调边合盖看，改完立刻生效。
    三个最常用的：
    · 跟手强度：盖子动同样多时画面折多少
    · 最大模糊半径：太大就糊成一片，调小可以看清内容
    · 最大压暗：远端最终有多黑

问：怎么卸载？
答：右键托盘图标 → 退出，然后把文件夹删掉就行。
    设置存在 C:\\Users\\你的用户名\\AppData\\Roaming\\Win Duo 里，
    想彻底清干净就把这个文件夹也删掉。


致谢
----------------------------------------
这个项目的几何、着色器和调参思路来自 macOS 上的 Mac Duo
（作者 Makito，Apache-2.0 许可）：
https://github.com/sumimakito/Mac-Duo

Win Duo 是它的 Windows 移植，主要区别是把"读合盖角度传感器"换成了
"用摄像头推算角度"，因为普通 Windows 笔记本没有那个传感器。
`;

function main() {
  if (process.platform !== 'win32') {
    console.error('[share] the share package is Windows only');
    process.exit(1);
  }

  const exe = fs.readdirSync(DIST).find((name) => name.endsWith('.exe') && name.includes('Portable'));
  if (!exe) {
    console.error('[share] no portable build in dist/; run "npm run dist" first');
    process.exit(1);
  }

  const folderName = `WinDuo-${pkg.version}`;
  const stage = path.join(SHARE, folderName);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  fs.copyFileSync(path.join(DIST, exe), path.join(stage, exe));
  // A .txt so it opens in Notepad on a double click, with CRLF so it looks right
  // there, and a BOM so Notepad picks UTF-8 rather than the local code page.
  fs.writeFileSync(
    path.join(stage, '使用说明.txt'),
    `\uFEFF${GUIDE.replace(/\n/g, '\r\n')}`,
  );

  const zip = path.join(SHARE, `${folderName}.zip`);
  fs.rmSync(zip, { force: true });

  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path ${JSON.stringify(path.join(stage, '*'))} -DestinationPath ${JSON.stringify(zip)} -Force`,
  ], { encoding: 'utf8' });

  if (result.status !== 0 || !fs.existsSync(zip)) {
    console.error('[share] could not create the zip:');
    console.error(String(result.stderr || result.stdout).trim());
    process.exit(1);
  }

  const mb = (file) => `${(fs.statSync(file).size / 1048576).toFixed(1)} MB`;
  console.log(`[share] ${folderName}/`);
  console.log(`  ${exe}  (${mb(path.join(stage, exe))})`);
  console.log('  使用说明.txt');
  console.log(`[share] ${zip}  (${mb(zip)})`);
  console.log('');
  console.log(`[share] upload ${path.basename(zip)} to whatever you are sharing with.`);
  console.log(`[share] it was assembled on ${os.platform()} ${os.arch()}.`);
}

main();
