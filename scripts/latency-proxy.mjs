// TCP proxy that adds a fixed delay in each direction, to simulate a distant database.
// Usage: node scripts/latency-proxy.mjs <listenPort> <targetHost:port> <oneWayDelayMs>
import net from 'node:net';

const [listen = '6543', target = 'localhost:5432', delay = '60'] = process.argv.slice(2);
const [host, port] = target.split(':');
const ms = Number(delay);

const pipe = (from, to) => from.on('data', (chunk) => setTimeout(() => to.write(chunk), ms));

net
  .createServer((client) => {
    const upstream = net.connect(Number(port), host);
    pipe(client, upstream);
    pipe(upstream, client);
    const close = () => (client.destroy(), upstream.destroy());
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
  })
  .listen(Number(listen), () => console.log(`latency proxy :${listen} -> ${target} (+${ms} ms each way)`));
