import test = require('tape')
import headless from '@pnpm/headless'
import path = require('path')
import testDefaults from './utils/testDefaults'

const fixtures = path.join(__dirname, 'fixtures')

test('installing a simple project', async (t) => {
  const prefix = path.join(fixtures, 'simple')
  await headless(await testDefaults({prefix}))
  t.end()
})
