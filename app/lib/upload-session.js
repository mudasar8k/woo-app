const DB_NAME = 'wooapp-uploads'
const DB_VERSION = 1
const STORE_NAME = 'files'
const SESSION_PREFIX = 'wooapp_csv_session_'

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = (event) => {
      const db = event.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

export function sessionKey(storeId) {
  return `${SESSION_PREFIX}${storeId}`
}

export function saveSession(storeId, session) {
  if (typeof window === 'undefined') return
  localStorage.setItem(sessionKey(storeId), JSON.stringify(session))
}

export function loadSession(storeId) {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(sessionKey(storeId))
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function clearSession(storeId) {
  if (typeof window === 'undefined') return
  localStorage.removeItem(sessionKey(storeId))
}

export async function saveFileBlob(csvUploadId, file) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(file, String(csvUploadId))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function loadFileBlob(csvUploadId) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(String(csvUploadId))
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

export async function deleteFileBlob(csvUploadId) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(String(csvUploadId))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function clearUploadData(storeId, csvUploadId) {
  clearSession(storeId)
  if (csvUploadId) {
    await deleteFileBlob(csvUploadId)
  }
}
