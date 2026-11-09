'use strict'

const path = require('node:path')

process.env.PORT = '0'
process.env.SAFFUL_DISABLE_SESSION_ID = 'true'
require('../../lib/safful-core-compatibility').authorizeBundledCore()

const bot = require('../../lib/smd')
const sessionDirectory = path.join(process.env.SAFFUL_E2E_SESSION_ROOT, 'session') + path.sep

bot.init('', sessionDirectory).then(() => {
  process.stdout.write('SAFFUL_CORE_INIT_OK\n')
  process.exit(0)
}).catch((error) => {
  process.stderr.write(String(error?.stack || error))
  process.exit(1)
})
