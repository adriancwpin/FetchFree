import http from 'node:http'
import { app } from './app.js'
import { config } from './config.js'

// "localhost" (used by the bank callback and the login link) may resolve to IPv4 or IPv6
// loopback depending on the browser, so the default listens on both — still never the network.
const hosts = config.host === '127.0.0.1' ? ['127.0.0.1', '::1'] : [config.host]
for (const host of hosts) {
  http
    .createServer(app)
    .listen(config.port, host, () => {
      console.log(`Server listening on http://${host.includes(':') ? `[${host}]` : host}:${config.port}`)
    })
    .on('error', (err) => {
      // IPv6 may be disabled on this machine; IPv4 loopback is enough then.
      if (host === '::1') {
        console.warn(`Not listening on [::1]: ${err.message}`)
        return
      }
      throw err
    })
}
