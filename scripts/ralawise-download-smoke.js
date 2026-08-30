/**
 * Smoke test: download Ralawise ZIPs from env URLs and unzip CSVs.
 *
 * Usage:
 *   RALAWISE_PARENT_URL=... RALAWISE_VARIATIONS_URL=... node scripts/ralawise-download-smoke.js
 *
 * Also loads .env / .env.local if present.
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const {
  downloadCatalog,
  getEnvDownloadUrls,
} = require('../app/lib/ralawise-client')
const { parseCSV } = require('../app/lib/csv-parser')

async function main() {
  const { parentUrl, variationsUrl } = getEnvDownloadUrls()

  if (!parentUrl || !variationsUrl) {
    console.error(
      'Set RALAWISE_PARENT_URL and RALAWISE_VARIATIONS_URL (with ?t= ticket) in .env'
    )
    process.exit(1)
  }

  console.log('Downloading catalog…')
  const result = await downloadCatalog({ parentUrl, variationsUrl })
  console.log('Work dir:', result.workDir)
  console.log('Parent CSV:', result.parentCsvPath)
  console.log('Variations CSV:', result.variationsCsvPath)

  const products = await parseCSV(result.parentCsvText)
  const variations = await parseCSV(result.variationsCsvText)

  console.log('Product rows:', products.length)
  console.log('Variation rows:', variations.length)
  if (products[0]) console.log('Product columns:', Object.keys(products[0]).slice(0, 12).join(', '), '…')
  if (variations[0]) console.log('Variation columns:', Object.keys(variations[0]).join(', '))

  const hasSku = products[0] && (products[0].sku || products[0].post_title)
  const hasParent = variations[0] && variations[0].parent_sku
  if (!hasSku) throw new Error('Parent CSV missing expected columns')
  if (!hasParent) throw new Error('Variations CSV missing parent_sku')

  console.log('Smoke test OK')
}

main().catch((err) => {
  console.error('Smoke test FAILED:', err.message)
  process.exit(1)
})
