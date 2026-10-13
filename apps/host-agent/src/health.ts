import http from 'node:http';
import { type DeviceManager } from './device-manager';
import { type ServerLink } from './server-link';
import { AGENT_VERSION } from './version';

/** Local-only health endpoint for monitoring (binds to 127.0.0.1). */
export function startHealthServer(
  port: number,
  link: ServerLink,
  manager: DeviceManager,
): http.Server {
  const started = Date.now();
  const server = http.createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const body = {
      status: link.connected ? 'ok' : 'disconnected',
      version: AGENT_VERSION,
      hostId: link.hostId,
      serverConnected: link.connected,
      lastError: link.lastError,
      devices: manager
        .devices()
        .map((d) => ({ serial: d.serial, platform: d.platform, state: d.state, model: d.model })),
      activeStreams: manager.activeStreams,
      uptimeSec: Math.round((Date.now() - started) / 1000),
      craftedBy: 'Vaibhav Sonawane through Claude',
    };
    res
      .writeHead(link.connected ? 200 : 503, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(body));
  });
  server.listen(port, '127.0.0.1');
  return server;
}
