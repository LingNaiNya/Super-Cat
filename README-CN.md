# Super Cat

<a href="https://github.com/LingNaiNya/Super-Cat/releases">
  <img src="./static/super-cat.png" width="256" alt="Super Cat 图标" />
</a>

## 一款全能的下载工具

[![GitHub release](https://img.shields.io/github/v/release/LingNaiNya/Super-Cat.svg)](https://github.com/LingNaiNya/Super-Cat/releases) ![Total Downloads](https://img.shields.io/github/downloads/LingNaiNya/Super-Cat/total.svg)

[English](./README.md) | 简体中文

Super Cat 是一款全能的下载工具，支持下载 HTTP、FTP、BT、磁力链等资源，界面简洁易用。

本项目基于 [Motrix](https://github.com/agalwood/Motrix) 分支而来，带来更新的界面、基于 GitHub Releases 的应用内更新渠道，以及持续的功能演进。

## 💽 安装稳定版

到 [GitHub Releases](https://github.com/LingNaiNya/Super-Cat/releases) 下载安装包运行安装。

### Windows

建议使用安装包（`Super-Cat-Setup-x.y.z.exe`）安装，以获得完整的体验，例如关联 torrent 文件、捕获磁力链等。

> 安装包暂未做代码签名，首次运行如遇 SmartScreen「未知发布者」提示，选择「仍要运行」即可。

### macOS / Linux

目前暂未发布对应平台的预编译包，请参考下方 **本地开发** 一节用 `npm run build` 自行编译打包。

## ✨ 特性

- 🕹 简洁清晰的用户界面
- 🦄 支持 BitTorrent & 磁力链
- ☑️ BT 文件选择性下载
- 📡 自动更新 Tracker 列表
- 🔌 UPnP & NAT-PMP 端口映射
- 🎛 最多同时进行 10 个下载任务
- 🚀 单个任务最高支持 64 线程
- 🚥 支持限速
- 🕶 自定义 User-Agent
- 🔔 下载完成通知
- 💻 支持触控栏（仅 Mac）
- 🤖 常驻系统托盘，快捷操作
- 📟 托盘实时网速显示（仅 Mac）
- 🌑 暗色模式
- 🗑 删除任务时可选删除相关文件
- 📦 应用内检查更新（渠道为 GitHub Releases）
- 🌍 国际化，[查看支持的语言](#-国际化)
- 🛠 更多功能开发中

## 🖥 应用界面

| 任务列表（暗色） | 任务列表（亮色） |
|---|---|
| ![dark](./screenshots/motrix-task-list-downloading-dark@2x.png) | ![light](./screenshots/motrix-task-list-downloading-light@2x.png) |

## ⌨️ 本地开发

### 克隆代码

```bash
git clone https://github.com/LingNaiNya/Super-Cat.git
cd Super-Cat
```

### 安装依赖

```bash
npm install
```

网络受限时建议先切换 npm 源：

```bash
npm config set registry 'https://registry.npmmirror.com'
export ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
```

### 开发模式

```bash
npm run dev
```

### 编译打包

```bash
npm run build
```

完成之后可以在项目的 `release` 目录看到编译打包好的应用文件。完整的发版流程见 [RELEASE.md](./RELEASE.md)。

## 🛠 技术栈

- [Electron](https://electronjs.org/)
- [Vue](https://vuejs.org/) + [VueX](https://vuex.vuejs.org/) + [Element](https://element.eleme.io)
- [Aria2](https://aria2.github.io/)

## 🤝 参与共建 [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat)](http://makeapullrequest.com)

如果你有兴趣参与共建，欢迎提 PR 和 Fork！

## 🌍 国际化

欢迎翻译成其他语言的版本 🧐！

| Key   | Name                | Status       |
|-------|:--------------------|:-------------|
| ar    | Arabic              | ✔️ [@hadialqattan](https://github.com/hadialqattan), [@AhmedElTabarani](https://github.com/AhmedElTabarani) |
| bg    | Българският език    | ✔️ [@null-none](https://github.com/null-none) |
| ca    | Català              | ✔️ [@marcizhu](https://github.com/marcizhu) |
| de    | Deutsch             | ✔️ [@Schloemicher](https://github.com/Schloemicher) |
| el    | Ελληνικά            | ✔️ [@Likecinema](https://github.com/Likecinema) |
| en-US | English             | ✔️           |
| es    | Español             | ✔️ [@Chofito](https://github.com/Chofito)|
| fa    | فارسی               | ✔️ [@Nima-Ra](https://github.com/Nima-Ra) |
| fr    | Français            | ✔️ [@gpatarin](https://github.com/gpatarin) |
| hu    | Hungarian           | ✔️ [@zalnaRs](https://github.com/zalnaRs) |
| id    | Indonesia           | ✔️ [@aarestu](https://github.com/aarestu) |
| it    | Italiano            | ✔️ [@blackcat-917](https://github.com/blackcat-917) |
| ja    | 日本語               | ✔️ [@hbkrkzk](https://github.com/hbkrkzk) |
| ko    | 한국어                | ✔️ [@KOZ39](https://github.com/KOZ39) |
| nb    | Norsk Bokmål        | ✔️ [@rubjo](https://github.com/rubjo) |
| nl    | Nederlands          | ✔️ [@nickbouwhuis](https://github.com/nickbouwhuis) |
| pl    | Polski              | ✔️ [@KanarekLife](https://github.com/KanarekLife) |
| pt-BR | Portuguese (Brazil) | ✔️ [@andrenoberto](https://github.com/andrenoberto) |
| ro    | Română              | ✔️ [@alyn3d](https://github.com/alyn3d) |
| ru    | Русский             | ✔️ [@bladeaweb](https://github.com/bladeaweb) |
| th    | แบบไทย              | ✔️ [@nxanywhere](https://github.com/nxanywhere) |
| tr    | Türkçe              | ✔️ [@abdullah](https://github.com/abdullah) |
| uk    | Українська          | ✔️ [@bladeaweb](https://github.com/bladeaweb) |
| vi    | Tiếng Việt          | ✔️ [@duythanhvn](https://github.com/duythanhvn) |
| zh-CN | 简体中文             | ✔️           |
| zh-TW | 繁體中文             | ✔️ [@Yukaii](https://github.com/Yukaii) [@5idereal](https://github.com/5idereal) |

## 🙏 致谢

Super Cat 基于 [Dr_rOot](https://github.com/agalwood) 的 [Motrix](https://github.com/agalwood/Motrix) 二次开发，感谢原作者与所有上游贡献者。

## 📜 开源许可

[MIT](./LICENSE) © 2018-present Dr_rOot · 2026 LingNaiNya
