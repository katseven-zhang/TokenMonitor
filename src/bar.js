import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { DEFAULT_PORT } from './config.js';

/**
 * macOS 菜单栏胶囊的启动。
 *
 * app bundle 随包发布（universal，~340KB），全局安装的用户无需任何工具链。
 * 此前它只存在于仓库里、且不在 files 白名单中，`npm i -g` 的用户拿不到，
 * 而指引用的 `npm run bar` 对全局安装也不可见。
 */
export function barAppPath() {
  return join(import.meta.dirname, '..', 'bin', 'tokenmonitor.app');
}

/**
 * Windows 托盘构建物（#9 Win-Tray）的候选位置，按序探测：
 * 1. 仓库内 dotnet publish 的固定输出（windows/tray/publish/）；
 * 2. 打包布局（dist/windows-x64 安装后托盘位于 <包>\tray\）。
 */
export function trayExeCandidates(root = join(import.meta.dirname, '..')) {
  return [
    join(root, 'windows', 'tray', 'publish', 'TokenMonitorTray.exe'),
    join(root, 'tray', 'TokenMonitorTray.exe'),
  ];
}

export function openBar({ port = DEFAULT_PORT, log = console.log } = {}) {
  if (process.platform === 'win32') {
    const exe = trayExeCandidates().find(existsSync);
    if (!exe) {
      // 找不到构建物：给出明确构建指引（需要 .NET 8 SDK），不静默失败
      throw new Error(
        `找不到 Windows 托盘程序 TokenMonitorTray.exe（tray）。\n` +
        `  构建自包含单文件（需要 .NET 8 SDK）：\n` +
        `  powershell -NoProfile -ExecutionPolicy Bypass -File windows\\tray\\build.ps1\n` +
        `  然后重试 tokenmonitor bar --port ${port}；面板地址 http://127.0.0.1:${port}`,
      );
    }
    // detached：托盘独立于 CLI 生命周期存活；端口透传给托盘
    spawn(exe, ['--port', String(port)], { detached: true, stdio: 'ignore' }).unref();
    log(`托盘已启动（连接 127.0.0.1:${port}；右键图标：打开面板 / 启动或重启后台 / 退出托盘）`);
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('菜单栏胶囊是 macOS 专属功能');
  }
  const app = barAppPath();
  if (!existsSync(app)) {
    throw new Error(`找不到 ${app}\n  从仓库运行时请先编译：npm run build-bar`);
  }
  // 端口经 --args 传给 app：serve --port 9000 的用户不该拿到一个连不上的胶囊
  execFileSync('open', ['-a', app, '--args', '--port', String(port)], { stdio: 'inherit' });
  log(`菜单栏胶囊已启动（连接 127.0.0.1:${port}，从菜单里选「退出」可关闭）`);
}
