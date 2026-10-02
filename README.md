# 奶蛙小游戏合集

把大家都玩过的国民小游戏，全部换成「奶蛙」皮肤。点开就能玩，手机和电脑都行。

**在线玩：https://allenllii.github.io/naiwa-games/**

| 游戏 | 玩法同款 | 在线玩 |
|---|---|---|
| 打奶蛙 | 打地鼠 | [whack/](https://allenllii.github.io/naiwa-games/whack/) |
| 奶了个奶 | 羊了个羊 | [sheep/](https://allenllii.github.io/naiwa-games/sheep/) |
| 奶蛙消消乐 | 开心消消乐 | [match3/](https://allenllii.github.io/naiwa-games/match3/) |
| 奶蛙跳一跳 | 微信跳一跳 | [jump/](https://allenllii.github.io/naiwa-games/jump/) |

## 特点

- 纯原生 HTML / CSS / JavaScript，零依赖、零构建；双击 `index.html` 也能离线玩
- 手机优先：触屏、横竖屏、安全区适配；电脑支持鼠标和键盘
- 奶蛙真实笑声 + Web Audio 现场合成的音效；最高分保存在本机浏览器（localStorage），没有后端
- 核心规则与界面分离，每个游戏都带 Node 逻辑测试，例如 `node whack/test-logic.js`

## 声音说明

- 笑声每次都播同一整段「啊哈哈哈哈哈哈」（约 1 秒），连击时会叠在一起；其余音效现场合成。
- iPhone 上网页声音默认受侧面静音键控制，静音键打开时没有声音，和原生游戏一样。
- 微信内置浏览器对网页声音限制更严：程序会自动改用备用方式播放，仍没声音时会提示「在浏览器打开」。
- 手机没声音时，在网址后面加 `?audiodebug=1`，左上角会显示声音状态，点一下会试播一声笑，方便排查。

## 本地运行

双击根目录的 `index.html`；或者在项目根目录运行 `python -m http.server 8000`，再打开 http://localhost:8000/

## 目录

```
index.html        合集入口页
assets/nai/       奶蛙图片素材（11 张透明底 WebP）
assets/audio/     奶蛙完整笑声原声（laugh-full.mp3，约 10 秒，备用）
common/           共用音效模块（sfx.js）和笑声录音数据（laugh-data.js，游戏实际播放的那一段）
whack/ sheep/ match3/ jump/   四个游戏，各自带 test-logic.js
```

## 素材与声明

- 「奶蛙」是网络梗，本项目仅供学习娱乐，不作商用。
- 图片：取自《合成大奶娃》（https://yhsome.github.io/BigNaiWa/ ）里的 11 张奶蛙立绘，版权归原作者与原创作者所有。
- 笑声：来自奶蛙大笑视频的音频，版权归原作者所有。
- 页面外观灵感来自《合成大奶娃》。
- 如有侵权，请联系删除。
