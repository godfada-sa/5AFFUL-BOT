'use strict'

// One deadline per account worker, shared across replacement sockets.
let current
let deadline
const observed = new WeakSet()
const terminalCodes = new Set([401, 403, 411, 440, 500])
const ackClasses = new Set(['status', 'message', 'receipt', 'notification', 'call'])

// rc14 handles message/receipt notifications but misses top-level status
// packets. Use the library's transport ACK (separate from read receipts).
function attachStatusAck(socket) {
  const ws = socket.ws
  if (!ws?.on || typeof socket.sendMessageAck !== 'function' || ws.listenerCount('CB:status')) return
  let reported = false
  ws.on('CB:status', async node => {
    if (node?.tag !== 'status' || !node.attrs?.id || !node.attrs?.from) return
    try {
      await socket.sendMessageAck(node)
      if (!reported) {
        reported = true
        process.stderr.write(`[reconnect] Device ${process.env.SAFFUL_DEVICE_ID || '1'} acknowledged its first status packet on this connection.\n`)
      }
    } catch {
      process.stderr.write(`[reconnect] Device ${process.env.SAFFUL_DEVICE_ID || '1'} could not acknowledge a status packet.\n`)
    }
  })
}

function watch(socket) {
  if (observed.has(socket)) return
  observed.add(socket)
  current = socket
  attachStatusAck(socket)
  let awaitingPairing = false
  socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (current !== socket) return
    const error = lastDisconnect?.error
    const code = error?.output?.statusCode ?? error?.data?.statusCode ?? error?.statusCode
    const streamAck = error?.data?.tag === 'ack'
    if (connection === 'close') {
      const kind = error?.data?.attrs?.class
      const detail = streamAck ? `, stream ack class=${ackClasses.has(kind) ? kind : 'other'}` : ''
      process.stderr.write(`[reconnect] Device ${process.env.SAFFUL_DEVICE_ID || '1'} socket closed (code ${Number(code) || 'unknown'}${detail}).\n`)
    }
    if (qr) awaitingPairing = true
    if (connection === 'open') awaitingPairing = false
    const terminal = terminalCodes.has(Number(code)) && !(Number(code) === 500 && streamAck)
    if (connection === 'open' || qr || (connection === 'close' && terminal)) {
      clearTimeout(deadline)
      deadline = undefined
    } else if (!awaitingPairing && connection === 'close' && !deadline) {
      deadline = setTimeout(() => {
        process.stderr.write(`[reconnect] Device ${process.env.SAFFUL_DEVICE_ID || '1'} offline for 30 seconds. Restarting worker.\n`)
        process.exit(1)
      }, 30000)
      deadline.unref()
    }
  })
}

module.exports = { watch }
