'use strict'

const fs = require('node:fs')

fs.appendFileSync(process.env.SAFFUL_E2E_OUTPUT, JSON.stringify({
  device: process.env.SAFFUL_DEVICE_ID,
  owner: process.env.OWNER_NUMBER,
  port: process.env.PORT,
  runtime: process.cwd(),
}) + '\n')
