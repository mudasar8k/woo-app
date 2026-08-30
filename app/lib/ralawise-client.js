const fs = require('fs')
const path = require('path')
const os = require('os')
const AdmZip = require('adm-zip')

const PARENT_CSV_NAME = 'wordpressdatafullparent.csv'
const VARIATIONS_CSV_NAME = 'wordpressdatafullvariations.csv'
const WORDPRESS_DATA_URL =
  'https://shop.ralawise.com/marketing-hub/web-data/wordpress/'
const RALAWISE_HOME = 'https://shop.ralawise.com/'

/**
 * Writable temp root for Ralawise downloads.
 * Vercel/Lambda only allow writes under os.tmpdir() (/tmp), not process.cwd().
 */
function getRalawiseTempRoot() {
  if (
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.RALAWISE_USE_OS_TMP === '1'
  ) {
    return path.join(os.tmpdir(), 'ralawise')
  }
  return path.join(process.cwd(), 'tmp', 'ralawise')
}

function getRalawiseWorkDir(prefix = 'run') {
  return path.join(getRalawiseTempRoot(), `${prefix}-${Date.now()}`)
}

/**
 * Download a ZIP from url and validate it is not an HTML/unauthorized response.
 * @returns {Promise<Buffer>}
 */
async function downloadZip(url, label) {
  if (!url || typeof url !== 'string') {
    throw new Error(`Missing ${label} download URL`)
  }

  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'application/zip,application/x-zip-compressed,*/*',
      'User-Agent': 'WooApp-RalawiseSync/1.0',
    },
  })

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  const finalUrl = response.url || url

  if (!response.ok) {
    throw new Error(
      `Failed to download ${label}: HTTP ${response.status} from ${finalUrl}`
    )
  }

  if (
    contentType.includes('text/html') ||
    finalUrl.includes('unauthorize') ||
    finalUrl.includes('transit-unauthorized')
  ) {
    throw new Error(
      `Unauthorized or expired download link for ${label}. Refresh RALAWISE_*_URL (?t=) or configure Ralawise login credentials.`
    )
  }

  const buffer = Buffer.from(await response.arrayBuffer())

  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    const peek = buffer.slice(0, 200).toString('utf8')
    if (peek.includes('unauthorize') || peek.includes('<html')) {
      throw new Error(
        `Unauthorized or expired download link for ${label}. Refresh RALAWISE_*_URL (?t=) or configure Ralawise login credentials.`
      )
    }
    throw new Error(`Downloaded ${label} is not a valid ZIP file`)
  }

  return buffer
}

function extractCsvFromZip(zipBuffer, preferredName, label) {
  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries().filter((e) => !e.isDirectory)

  let entry =
    entries.find((e) => path.basename(e.entryName).toLowerCase() === preferredName) ||
    entries.find((e) => path.basename(e.entryName).toLowerCase().endsWith('.csv'))

  if (!entry) {
    throw new Error(`No CSV found inside ${label} ZIP`)
  }

  return {
    fileName: path.basename(entry.entryName),
    content: entry.getData().toString('utf8'),
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeCatalogFromZips({ dir, parentZip, variationsZip }) {
  const parentZipPath = path.join(dir, 'parent.zip')
  const variationsZipPath = path.join(dir, 'variations.zip')
  const parentCsvPath = path.join(dir, PARENT_CSV_NAME)
  const variationsCsvPath = path.join(dir, VARIATIONS_CSV_NAME)

  fs.writeFileSync(parentZipPath, parentZip)
  fs.writeFileSync(variationsZipPath, variationsZip)

  const parentCsv = extractCsvFromZip(parentZip, PARENT_CSV_NAME, 'products')
  const variationsCsv = extractCsvFromZip(
    variationsZip,
    VARIATIONS_CSV_NAME,
    'variations'
  )

  fs.writeFileSync(parentCsvPath, parentCsv.content, 'utf8')
  fs.writeFileSync(variationsCsvPath, variationsCsv.content, 'utf8')

  return {
    workDir: dir,
    parentCsvPath,
    variationsCsvPath,
    parentCsvText: parentCsv.content,
    variationsCsvText: variationsCsv.content,
  }
}

async function reportProgress(onProgress, payload) {
  if (typeof onProgress === 'function') {
    await onProgress(payload)
  }
}

/**
 * Download parent + variations ZIPs via public URLs and write CSVs to workDir.
 */
async function downloadCatalog({ parentUrl, variationsUrl, workDir, onProgress }) {
  const dir = workDir || getRalawiseWorkDir('run')

  ensureDir(dir)

  const parentCsvPath = path.join(dir, PARENT_CSV_NAME)
  const variationsCsvPath = path.join(dir, VARIATIONS_CSV_NAME)

  try {
    await reportProgress(onProgress, {
      step: 'downloading',
      message: 'Downloading latest catalog ZIPs…',
    })
    const [parentZip, variationsZip] = await Promise.all([
      downloadZip(parentUrl, 'products'),
      downloadZip(variationsUrl, 'variations'),
    ])
    return {
      ...writeCatalogFromZips({ dir, parentZip, variationsZip }),
      source: 'env-url',
    }
  } catch (error) {
    for (const file of [parentCsvPath, variationsCsvPath]) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      } catch {
        // ignore
      }
    }
    throw error
  }
}

function getEnvDownloadUrls() {
  const parentUrl = process.env.RALAWISE_PARENT_URL || ''
  const variationsUrl = process.env.RALAWISE_VARIATIONS_URL || ''
  return {
    parentUrl: parentUrl.trim(),
    variationsUrl: variationsUrl.trim(),
  }
}

function toAbsoluteUrl(href) {
  return new URL(href, RALAWISE_HOME).toString()
}

async function isZipUrlUsable(url) {
  if (!url) return false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Range: 'bytes=0-3',
        'User-Agent': 'WooApp-RalawiseSync/1.0',
      },
    })
    clearTimeout(timer)

    const finalUrl = response.url || url
    if (
      finalUrl.includes('unauthorize') ||
      finalUrl.includes('transit-unauthorized')
    ) {
      return false
    }
    if (!response.ok) return false
    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('text/html')) return false
    const buf = Buffer.from(await response.arrayBuffer())
    return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b
  } catch {
    return false
  }
}

function isVercelRuntime() {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV)
}

function canUsePlaywright() {
  // Chromium is not viable on Vercel serverless — use HTTP login instead.
  if (isVercelRuntime()) return false
  if (process.env.RALAWISE_DISABLE_PLAYWRIGHT === '1') return false
  try {
    require.resolve('playwright')
    return true
  } catch {
    return false
  }
}

/**
 * Simple cookie jar for Node fetch (Set-Cookie → Cookie header).
 */
class CookieJar {
  constructor() {
    this.cookies = new Map()
  }

  absorb(response) {
    const list =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : []
    for (const raw of list) {
      const [pair] = String(raw).split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name) this.cookies.set(name, value)
    }
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  get(name) {
    return this.cookies.get(name) || ''
  }
}

function extractLoginVerificationToken(html) {
  const forms = [
    ...String(html).matchAll(
      /<form[^>]*class="[^"]*login-form[^"]*"[^>]*>[\s\S]*?<\/form>/gi
    ),
  ]
  for (const form of forms) {
    if (!form[0].includes('id="EmailAddress"')) continue
    const match = form[0].match(
      /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i
    )
    if (match?.[1]) return match[1]
  }
  const fallback = String(html).match(
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i
  )
  return fallback?.[1] || null
}

function extractDownloadUrlsFromHtml(html) {
  const hrefs = [...String(html).matchAll(/href=["']([^"']+)["']/gi)].map(
    (m) => m[1]
  )
  const parentHref =
    hrefs.find((h) => /wordpressdatafullparent/i.test(h)) ||
    hrefs.find(
      (h) => /webdatadownloads/i.test(h) && /parent/i.test(h) && /\.zip/i.test(h)
    )
  const variationsHref =
    hrefs.find((h) => /wordpressdatafullvariations/i.test(h)) ||
    hrefs.find(
      (h) =>
        /webdatadownloads/i.test(h) && /variation/i.test(h) && /\.zip/i.test(h)
    )

  if (!parentHref || !variationsHref) {
    throw new Error(
      'Could not find Ralawise WordPress download links after HTTP login'
    )
  }

  return {
    parentUrl: toAbsoluteUrl(parentHref),
    variationsUrl: toAbsoluteUrl(variationsHref),
  }
}

async function downloadZipWithCookies(url, label, jar) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'application/zip,application/x-zip-compressed,*/*',
      'User-Agent': 'WooApp-RalawiseSync/1.0',
      Cookie: jar.header(),
      Referer: WORDPRESS_DATA_URL,
    },
  })
  jar.absorb(response)

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  const finalUrl = response.url || url

  if (!response.ok) {
    throw new Error(
      `Authenticated download failed for ${label}: HTTP ${response.status}`
    )
  }
  if (
    contentType.includes('text/html') ||
    finalUrl.includes('unauthorize') ||
    finalUrl.includes('transit-unauthorized')
  ) {
    throw new Error(
      `Unauthorized download for ${label}. Check RALAWISE_EMAIL / RALAWISE_PASSWORD.`
    )
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error(
      `Authenticated download for ${label} did not return a ZIP (login may have failed)`
    )
  }
  return buffer
}

/**
 * Vercel-safe path: form POST login + HTML scrape + cookie ZIP download.
 * No Chromium / Playwright required.
 */
async function downloadCatalogWithHttp({
  email = process.env.RALAWISE_EMAIL,
  password = process.env.RALAWISE_PASSWORD,
  workDir,
  onProgress,
} = {}) {
  if (!email || !password) {
    throw new Error(
      'RALAWISE_EMAIL and RALAWISE_PASSWORD are required to refresh download links'
    )
  }

  const dir = workDir || getRalawiseWorkDir('run')
  ensureDir(dir)

  await reportProgress(onProgress, {
    step: 'connecting',
    message: 'Connecting to Ralawise (HTTP)…',
  })

  const jar = new CookieJar()
  const home = await fetch(RALAWISE_HOME, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html',
      'User-Agent': 'WooApp-RalawiseSync/1.0',
    },
  })
  jar.absorb(home)
  const homeHtml = await home.text()
  const token =
    extractLoginVerificationToken(homeHtml) ||
    jar.get('__RequestVerificationToken')

  if (!token) {
    throw new Error('Could not read Ralawise login verification token')
  }

  const form = new URLSearchParams({
    EmailAddress: email,
    Password: password,
    Login: '',
    __RequestVerificationToken: token,
  })

  const login = await fetch(
    'https://shop.ralawise.com/Services/Authentication/SignIn',
    {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': 'WooApp-RalawiseSync/1.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*',
        Cookie: jar.header(),
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://shop.ralawise.com',
        Referer: RALAWISE_HOME,
      },
      body: form.toString(),
    }
  )
  jar.absorb(login)

  let loginJson
  try {
    loginJson = await login.json()
  } catch {
    throw new Error(
      `Ralawise HTTP login failed (HTTP ${login.status}). Check credentials.`
    )
  }

  if (!loginJson?.Success) {
    throw new Error(
      loginJson?.Message ||
        'Ralawise HTTP login failed — check RALAWISE_EMAIL / RALAWISE_PASSWORD'
    )
  }

  const page = await fetch(WORDPRESS_DATA_URL, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html',
      'User-Agent': 'WooApp-RalawiseSync/1.0',
      Cookie: jar.header(),
      Referer: RALAWISE_HOME,
    },
  })
  jar.absorb(page)
  const pageHtml = await page.text()
  const finalPageUrl = page.url || WORDPRESS_DATA_URL

  if (!page.ok || finalPageUrl.includes('unauthorize')) {
    throw new Error(
      'Ralawise login session rejected — check RALAWISE_EMAIL / RALAWISE_PASSWORD'
    )
  }

  const urls = extractDownloadUrlsFromHtml(pageHtml)

  await reportProgress(onProgress, {
    step: 'downloading',
    message: 'Downloading latest catalog ZIPs…',
  })

  const [parentZip, variationsZip] = await Promise.all([
    downloadZipWithCookies(urls.parentUrl, 'products', jar),
    downloadZipWithCookies(urls.variationsUrl, 'variations', jar),
  ])

  return {
    ...writeCatalogFromZips({ dir, parentZip, variationsZip }),
    parentUrl: urls.parentUrl,
    variationsUrl: urls.variationsUrl,
    source: 'http',
  }
}

async function launchBrowser(chromium) {
  try {
    return await chromium.launch({ headless: true })
  } catch (launchError) {
    try {
      return await chromium.launch({ headless: true, channel: 'chrome' })
    } catch {
      throw new Error(
        `Playwright browser launch failed (${launchError.message}). Run: npx playwright install chromium`
      )
    }
  }
}

async function loginRalawise(page, email, password) {
  await page.goto(RALAWISE_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 })

  const acceptCookies = page.locator(
    '#onetrust-accept-btn-handler, button:has-text("Accept All"), button:has-text("Accept")'
  )
  try {
    if (await acceptCookies.first().isVisible({ timeout: 5000 })) {
      await acceptCookies.first().click({ timeout: 5000 })
      await page.waitForTimeout(500)
    }
  } catch {
    // no cookie banner
  }
  await page.evaluate(() => {
    const sdk = document.getElementById('onetrust-consent-sdk')
    if (sdk) sdk.remove()
    document
      .querySelectorAll('.onetrust-pc-dark-filter')
      .forEach((el) => el.remove())
  })

  const emailField = page.locator('#EmailAddress').first()
  const passwordField = page.locator('#Password').first()
  await emailField.waitFor({ state: 'visible', timeout: 15000 })
  await emailField.fill(email)
  await passwordField.fill(password)
  await page.locator('#login').first().click({ force: true })
  await page.waitForTimeout(3000)
}

async function scrapeDownloadHrefs(page) {
  await page.goto(WORDPRESS_DATA_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })

  if (page.url().includes('unauthorize')) {
    throw new Error('Ralawise login failed — check RALAWISE_EMAIL / RALAWISE_PASSWORD')
  }

  const links = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'))
    const find = (needle) => {
      const el = anchors.find((a) => {
        const text = (a.textContent || '').trim().toLowerCase()
        const href = (a.getAttribute('href') || '').toLowerCase()
        return text.includes(needle) || href.includes(needle)
      })
      return el ? el.getAttribute('href') : null
    }
    const zipHrefs = anchors
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && h.includes('webdatadownloads'))
    return {
      parentHref:
        find('wordpressdatafullparent') ||
        find('download - products') ||
        zipHrefs.find((h) => h.includes('wordpressdatafullparent')),
      variationsHref:
        find('wordpressdatafullvariations') ||
        find('download - variations') ||
        zipHrefs.find((h) => h.includes('wordpressdatafullvariations')),
    }
  })

  if (!links.parentHref || !links.variationsHref) {
    throw new Error('Could not find Ralawise WordPress download links after login')
  }

  return {
    parentUrl: toAbsoluteUrl(links.parentHref),
    variationsUrl: toAbsoluteUrl(links.variationsHref),
  }
}

async function downloadZipWithContext(requestContext, url, label) {
  const response = await requestContext.get(url, { timeout: 120000 })
  if (!response.ok()) {
    throw new Error(`Authenticated download failed for ${label}: HTTP ${response.status()}`)
  }
  const buffer = Buffer.from(await response.body())
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error(
      `Authenticated download for ${label} did not return a ZIP (login may have failed)`
    )
  }
  return buffer
}

/**
 * Login, scrape fresh ?t= links, download ZIPs with session cookies.
 */
async function downloadCatalogWithPlaywright({
  email = process.env.RALAWISE_EMAIL,
  password = process.env.RALAWISE_PASSWORD,
  workDir,
  onProgress,
} = {}) {
  if (!email || !password) {
    throw new Error(
      'RALAWISE_EMAIL and RALAWISE_PASSWORD are required to refresh download links'
    )
  }

  let chromium
  try {
    ;({ chromium } = require('playwright'))
  } catch {
    throw new Error(
      'Playwright is not installed. Run: npm install playwright && npx playwright install chromium'
    )
  }

  const dir = workDir || getRalawiseWorkDir('run')
  ensureDir(dir)

  await reportProgress(onProgress, {
    step: 'connecting',
    message: 'Connecting to Ralawise…',
  })

  const browser = await launchBrowser(chromium)
  try {
    const context = await browser.newContext({
      userAgent: 'WooApp-RalawiseSync/1.0',
      acceptDownloads: true,
    })
    const page = await context.newPage()
    await loginRalawise(page, email, password)
    const urls = await scrapeDownloadHrefs(page)

    await reportProgress(onProgress, {
      step: 'downloading',
      message: 'Downloading latest catalog ZIPs…',
    })

    const [parentZip, variationsZip] = await Promise.all([
      downloadZipWithContext(context.request, urls.parentUrl, 'products'),
      downloadZipWithContext(context.request, urls.variationsUrl, 'variations'),
    ])

    return {
      ...writeCatalogFromZips({ dir, parentZip, variationsZip }),
      parentUrl: urls.parentUrl,
      variationsUrl: urls.variationsUrl,
      source: 'playwright',
    }
  } finally {
    await browser.close()
  }
}

/** @deprecated use downloadCatalogAuthenticated / downloadCatalogWithHttp */
async function scrapeDownloadUrlsWithPlaywright(opts = {}) {
  const catalog = await downloadCatalogAuthenticated(opts)
  return {
    parentUrl: catalog.parentUrl,
    variationsUrl: catalog.variationsUrl,
    source: catalog.source,
  }
}

/**
 * Authenticated catalog fetch: HTTP login first (Vercel-safe), Playwright only locally.
 */
async function downloadCatalogAuthenticated({
  workDir,
  onProgress,
  forcePlaywright = false,
} = {}) {
  const hasCreds =
    Boolean(process.env.RALAWISE_EMAIL) && Boolean(process.env.RALAWISE_PASSWORD)
  if (!hasCreds) {
    throw new Error(
      'Missing or expired Ralawise download URLs. Set fresh RALAWISE_PARENT_URL / RALAWISE_VARIATIONS_URL, or RALAWISE_EMAIL / RALAWISE_PASSWORD.'
    )
  }

  if (forcePlaywright) {
    if (!canUsePlaywright()) {
      throw new Error(
        'Playwright is unavailable on this runtime (Vercel). Use HTTP login credentials or env ZIP URLs.'
      )
    }
    return downloadCatalogWithPlaywright({ workDir, onProgress })
  }

  try {
    return await downloadCatalogWithHttp({ workDir, onProgress })
  } catch (httpError) {
    if (!canUsePlaywright()) {
      throw httpError
    }
    console.warn(
      'Ralawise HTTP login failed, falling back to Playwright:',
      httpError.message
    )
    return downloadCatalogWithPlaywright({ workDir, onProgress })
  }
}

/**
 * Resolve URLs for callers that only need links (env if still public).
 */
async function resolveRalawiseDownloadUrls({ forceScrape = false } = {}) {
  const envUrls = getEnvDownloadUrls()

  if (!forceScrape && envUrls.parentUrl && envUrls.variationsUrl) {
    const usable =
      (await isZipUrlUsable(envUrls.parentUrl)) &&
      (await isZipUrlUsable(envUrls.variationsUrl))
    if (usable) {
      return { ...envUrls, source: 'env' }
    }
  }

  if (process.env.RALAWISE_EMAIL && process.env.RALAWISE_PASSWORD) {
    const catalog = await downloadCatalogAuthenticated()
    return {
      parentUrl: catalog.parentUrl,
      variationsUrl: catalog.variationsUrl,
      source: catalog.source,
      // Attached so import can skip a second download when scrape already fetched
      _catalog: catalog,
    }
  }

  throw new Error(
    'Missing or expired Ralawise download URLs. Set fresh RALAWISE_PARENT_URL / RALAWISE_VARIATIONS_URL, or RALAWISE_EMAIL / RALAWISE_PASSWORD.'
  )
}

/**
 * Preferred entry: env ZIP URLs → HTTP login (Vercel) → Playwright (local only).
 */
async function fetchRalawiseCatalog({
  workDir,
  forcePlaywright = false,
  onProgress,
} = {}) {
  const envUrls = getEnvDownloadUrls()

  await reportProgress(onProgress, {
    step: 'connecting',
    message: 'Connecting to Ralawise…',
  })

  if (!forcePlaywright && envUrls.parentUrl && envUrls.variationsUrl) {
    try {
      return await downloadCatalog({
        parentUrl: envUrls.parentUrl,
        variationsUrl: envUrls.variationsUrl,
        workDir,
        onProgress,
      })
    } catch (envError) {
      if (!(process.env.RALAWISE_EMAIL && process.env.RALAWISE_PASSWORD)) {
        throw envError
      }
      console.warn(
        'Env Ralawise URLs failed, falling back to authenticated login:',
        envError.message
      )
    }
  }

  return downloadCatalogAuthenticated({
    workDir,
    onProgress,
    forcePlaywright,
  })
}

module.exports = {
  downloadCatalog,
  downloadCatalogWithHttp,
  downloadCatalogWithPlaywright,
  downloadCatalogAuthenticated,
  downloadZip,
  extractCsvFromZip,
  getEnvDownloadUrls,
  getRalawiseTempRoot,
  getRalawiseWorkDir,
  resolveRalawiseDownloadUrls,
  scrapeDownloadUrlsWithPlaywright,
  fetchRalawiseCatalog,
  isZipUrlUsable,
  canUsePlaywright,
  isVercelRuntime,
  PARENT_CSV_NAME,
  VARIATIONS_CSV_NAME,
}
