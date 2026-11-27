import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveWindowsEnvFromWsl, windowsPathToWslPath } from './paths.mjs';

/**
 * 在 WSL2 中查找宿主机可用的 Windows Node.js 可执行文件（用于 NAT 网络下的本地回环转发）
 */
function findWindowsNodeExecutable() {
  const winAppData = resolveWindowsEnvFromWsl('APPDATA');
  if (winAppData) {
    const agyNode = windowsPathToWslPath(`${winAppData}\\Antigravity\\bin\\node.exe`);
    if (agyNode && fs.existsSync(agyNode)) {
      return agyNode;
    }
  }

  const winProgFiles = resolveWindowsEnvFromWsl('ProgramFiles');
  if (winProgFiles) {
    const stdNode = windowsPathToWslPath(`${winProgFiles}\\nodejs\\node.exe`);
    if (stdNode && fs.existsSync(stdNode)) {
      return stdNode;
    }
  }

  return 'node.exe';
}

/**
 * 创建 WSL2 -> Windows localhost 的轻量级 TCP 端口转发桥（仅在 WSL NAT 模式直连失败时按需启用）
 */
export function createWslLocalhostBridge() {
  let proxyProcess = null;
  let proxyLocalPort = 0;
  let currentTargetPort = 0;

  // 关闭当前运行中的转发子进程
  async function close() {
    if (proxyProcess) {
      const proc = proxyProcess;
      proxyProcess = null;
      proxyLocalPort = 0;
      currentTargetPort = 0;
      try {
        proc.kill();
      } catch {
        // 忽略已退出进程
      }
    }
  }

  // 在 WSL 内测试一个空闲端口并在 Windows 侧或通过 stdio 建立双向流桥接
  async function ensureEndpoint(winPort) {
    const numericPort = Number(winPort);
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      throw new Error('无效的调试端口');
    }

    if (proxyProcess && proxyLocalPort > 0 && currentTargetPort === numericPort) {
      return { host: '127.0.0.1', port: proxyLocalPort };
    }

    await close();
    const winNode = findWindowsNodeExecutable();

    // 在 WSL 本地监听随机端口，每次新连接通过一次轻量 Windows node.exe 管道桥接到宿主机 127.0.0.1:winPort
    const server = net.createServer((clientSocket) => {
      clientSocket.setNoDelay(true);
      const inlineBridge = `
        const net = require('net');
        const sock = net.connect(${numericPort}, '127.0.0.1');
        process.stdin.pipe(sock);
        sock.pipe(process.stdout);
        sock.on('error', () => process.exit(1));
        sock.on('close', () => process.exit(0));
        process.stdin.on('end', () => sock.end());
      `;
      const child = spawn(winNode, ['-e', inlineBridge], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });

      clientSocket.pipe(child.stdin);
      child.stdout.pipe(clientSocket);

      const cleanup = () => {
        try {
          clientSocket.destroy();
        } catch {}
        try {
          child.kill();
        } catch {}
      };
      clientSocket.on('error', cleanup);
      clientSocket.on('close', cleanup);
      child.on('error', cleanup);
      child.on('close', () => {
        try {
          clientSocket.end();
        } catch {}
      });
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address();
    proxyLocalPort = typeof addr === 'object' && addr ? addr.port : 0;
    currentTargetPort = numericPort;
    proxyProcess = {
      kill() {
        server.close();
      },
    };

    return { host: '127.0.0.1', port: proxyLocalPort };
  }

  // 将 CDP 返回的 WebSocket 地址重写为代理端口
  function rewriteTargets(targets, winPort) {
    if (!Array.isArray(targets) || !proxyLocalPort) return targets;
    return targets.map((item) => {
      if (!item || typeof item.webSocketDebuggerUrl !== 'string') return item;
      const rewritten = item.webSocketDebuggerUrl.replace(
        new RegExp(`127\\.0\\.0\\.1:${winPort}\\b`),
        `127.0.0.1:${proxyLocalPort}`
      );
      return { ...item, webSocketDebuggerUrl: rewritten };
    });
  }

  return {
    ensureEndpoint,
    rewriteTargets,
    close,
  };
}
