'use strict'

const fs = require('node:fs')
const output = process.env.SAFFUL_E2E_OUTPUT
fs.appendFileSync(output, JSON.stringify({ device: process.env.SAFFUL_DEVICE_ID, pid: process.pid }) + '\n')
setInterval(() => {}, 1000)
if (process.env.SAFFUL_DEVICE_ID === '2') {
  const ready = setInterval(() => {
    if (fs.readFileSync(output, 'utf8').trim().split('\n').length < 2) return
    clearInterval(ready)
    process.send({ type: 'safful:restart-deployment' })
  }, 20)
}
