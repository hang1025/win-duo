/**
 * UI strings, English and Chinese.
 *
 * Loaded both as a CommonJS module by the main process and as a classic script
 * by the settings page, so it deliberately has no imports.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WinDuoStrings = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const en = {
    tray: {
      play: 'Play the fold',
      settings: 'Settings…',
      launchAtLogin: 'Start at login',
      enabled: 'Enabled',
      openSettingsFolder: 'Open settings folder',
      quit: 'Quit',
      tooltip: 'Win Duo',
    },
    settings: {
      title: 'Win Duo',
      subtitle: 'The iPhone Duo fold effect, on any Windows laptop.',
      tracking: 'Lid tracking',
      trigger: 'Trigger',
      angle: 'Angle',
      optics: 'Optics',
      motion: 'Motion',
      preview: 'Preview',
      reset: 'Reset to defaults',
      footer: 'Changes apply immediately and are written to settings.json',
    },
    params: {
      enabled: { label: 'Enabled' },
      launchAtLogin: { label: 'Start at login' },
      displayMode: { label: 'Display', primary: 'Primary', cursor: 'Under the cursor' },
      hotkey: { label: 'Global hotkey' },
      angleSource: {
        label: 'Angle source',
        camera: 'Follow the lid (webcam)',
        sweep: 'Scripted animation',
        hint: 'Following the lid reads the angle from the built-in webcam. The camera light comes on only while armed, and no frames are stored.',
      },
      neutralBand: {
        label: 'Flat zone',
        hint: 'Degrees either side of the rest angle where the picture stays completely flat. Set it to the range you move the lid within while working.',
      },
      releaseOn: {
        label: 'Ending the run',
        auto: 'When the lid comes back to rest',
        click: 'Only when I click',
        hint: 'On "only when I click" the run never times out and the camera stays on until then. Clicking always ends a run, whichever is set.',
      },
      showAngleReadout: { label: 'Show the tracked angle on screen' },
      restAngle: {
        label: 'Rest angle',
        hint: 'The lid angle you work at, and the angle the fold starts from. Set it to whatever your screen stands at when you are sitting normally.',
      },
      foldAngle: {
        label: 'Angle the fold finishes at',
        hint: 'The fold stops here and holds as the lid keeps going. About 50 degrees: past that the picture is mostly black, so following the lid further only buries it.',
      },
      trackerGain: {
        label: 'Follow strength',
        hint: 'How much fold you get per unit of lid movement. Raise it if the fold does not go far enough before the screen fades out.',
      },
      fullTravel: {
        label: 'Full-close travel',
        hint: 'Learned automatically from each complete close, so leave it alone unless the fold consistently stops short or overshoots.',
      },
      thresholdAngle: {
        label: 'Trigger angle',
        hint: 'The fold starts once the angle drops below this. 90° is a lid standing straight up.',
      },
      blurSpan: {
        label: 'Blur span',
        hint: 'How many more degrees of travel it takes to reach full blur.',
      },
      viewingDistance: {
        label: 'Eye distance',
        hint: 'In screen heights. Lower is a stronger perspective. Sitting at a desk is about 3; across the room, about 6.',
      },
      recession: {
        label: 'Picture rotation',
        hint: 'Degrees the picture turns away for each degree of lid travel. 1 pins the picture to the room.',
      },
      maxBlurRadius: {
        label: 'Maximum blur radius',
        hint: 'Radius at full strength, applied towards the far edge.',
      },
      blurEvenness: {
        label: 'Blur evenness',
        hint: '0 keeps the hinge edge sharp, 1 blurs the whole picture by the same amount.',
      },
      maxDim: { label: 'Maximum dimming', hint: 'How black the far edge goes.' },
      dimReach: {
        label: 'Dimming reach',
        hint: 'Height, as a fraction of the screen, at which the dimming reaches full strength.',
      },
      dimHingeFloor: {
        label: 'Hinge dimming',
        hint: 'Dimming kept at the hinge edge, as a fraction of the far edge.',
      },
      sweepClosing: { label: 'Close duration', hint: 'Seconds for the scripted sweep to close.' },
      sweepHold: { label: 'Hold duration', hint: 'Seconds the picture stays folded.' },
      sweepOpening: { label: 'Open duration', hint: 'Seconds to unfold back to flat.' },
    },
  };

  const zh = {
    tray: {
      play: '播放开合效果',
      settings: '设置…',
      launchAtLogin: '开机时启动',
      enabled: '启用效果',
      openSettingsFolder: '打开设置文件所在目录',
      quit: '退出',
      tooltip: 'Win Duo',
    },
    settings: {
      title: 'Win Duo',
      subtitle: '把 iPhone Duo 的开合透视效果带到任意一台 Windows 笔记本上。',
      tracking: '合盖跟随',
      trigger: '触发',
      angle: '角度',
      optics: '光学',
      motion: '动画',
      preview: '预览效果',
      reset: '恢复默认',
      footer: '设置即时生效，并写入 settings.json',
    },
    params: {
      enabled: { label: '启用效果' },
      launchAtLogin: { label: '开机时启动' },
      displayMode: { label: '作用屏幕', primary: '主屏幕', cursor: '鼠标所在屏幕' },
      hotkey: { label: '全局快捷键' },
      angleSource: {
        label: '角度来源',
        camera: '跟随真实盖子（摄像头）',
        sweep: '脚本动画',
        hint: '跟随真实盖子的角度来自内置摄像头。指示灯只在待命期间亮起，画面一帧都不保存。',
      },
      neutralBand: {
        label: '平整区间',
        hint: '静止角两侧这个度数范围内画面完全平整。设成你工作时盖子会在其中活动的范围。',
      },
      releaseOn: {
        label: '结束方式',
        auto: '盖子回位时自动结束',
        click: '只有我点击才结束',
        hint: '选「只有我点击才结束」时，不会超时、摄像头会一直开着直到你点击。无论选哪个，点击都能随时结束。',
      },
      showAngleReadout: { label: '在屏幕上显示实时角度' },
      restAngle: {
        label: '静止角',
        hint: '你平时使用时的盖子角度，也是折叠的起点。设成你正常坐姿下屏幕实际张开的角度。',
      },
      foldAngle: {
        label: '折叠封顶角度',
        hint: '折到这个角度就停住，盖子再往下合画面也不变。约 50°：再深画面基本就全黑了，跟着盖子继续折只会把它埋掉。',
      },
      trackerGain: {
        label: '跟手强度',
        hint: '盖子动同样多时画面折多少。如果屏幕还没暗下去效果就已经折满了，就调小。',
      },
      fullTravel: {
        label: '满行程',
        hint: '每次完整合盖后自动学习，一般不用管。只有在效果总是折不到位或提前折满时才手动改。',
      },
      thresholdAngle: {
        label: '触发角度',
        hint: '角度低于这个值时开始出现效果。90° 相当于盖子竖直。',
      },
      blurSpan: {
        label: '模糊跨度',
        hint: '越过触发角度后再合多少度，模糊达到最强。',
      },
      viewingDistance: {
        label: '眼睛距离',
        hint: '单位是屏高。越小透视越强。坐着看约 3，站远了约 6。',
      },
      recession: {
        label: '画面转开比例',
        hint: '盖子每转一度，画面转开多少度。1 表示画面钉在房间里。',
      },
      maxBlurRadius: {
        label: '最大模糊半径',
        hint: '最强模糊时的半径，作用在远离铰链的一侧。',
      },
      blurEvenness: {
        label: '模糊均匀度',
        hint: '0 让铰链一侧保持清晰，1 表示整幅画面一样糊。',
      },
      maxDim: { label: '最大压暗', hint: '远端一侧最终的黑度。' },
      dimReach: {
        label: '压暗到达高度',
        hint: '从铰链往上到屏高的多少比例时，压暗达到满值。',
      },
      dimHingeFloor: {
        label: '铰链侧压暗',
        hint: '铰链一侧保留的压暗，相对远端满值的比例。',
      },
      sweepClosing: { label: '合上时长', hint: '脚本扫掠合上所用的秒数。' },
      sweepHold: { label: '停留时长', hint: '画面保持折起的秒数。' },
      sweepOpening: { label: '打开时长', hint: '展平回去所用的秒数。' },
    },
  };

  /** Resolves a dotted path like 'params.maxDim.label'. */
  function pick(table, path) {
    return path.split('.').reduce((node, part) => (node == null ? undefined : node[part]), table);
  }

  /** Picks a language from a locale tag such as 'zh-CN'. */
  function forLocale(locale) {
    return String(locale || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  return { en, zh, pick, forLocale };
}));
