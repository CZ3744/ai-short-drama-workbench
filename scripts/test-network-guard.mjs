/** 测试预加载护栏：允许进程内启动的临时 HTTP fixture，拒绝外部服务及正在运行的工作台。 */
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

if (process.env.NODE_ENV !== 'test' || !process.env.VIDEO_GENERATE_TEST_FIXTURE) {
  throw new Error('test-network-guard 只能由隔离测试入口加载');
}

const knownStudioPorts = new Set([8788, 5173, 3000, 8080]);
function check(host, port) {
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host ?? 'localhost').toLowerCase());
  if (!local || knownStudioPorts.has(Number(port))) {
    throw new Error(`测试网络护栏：禁止请求真实服务 ${host}:${port}；请注入 mock 或临时本地 HTTP fixture。`);
  }
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    if (first.port !== undefined) check(first.host, first.port);
    // tsx 的内部 IPC 使用本地命名管道，不视为外部 API。
  } else if (typeof first === 'number' || /^\d+$/.test(String(first))) {
    check(typeof args[1] === 'string' ? args[1] : undefined, first);
  }
  return Reflect.apply(originalConnect, this, args);
};
syncBuiltinESMExports();

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  check(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
  return originalFetch(input, init);
};
