'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Papa from 'papaparse'
import {
  saveSession,
  loadSession,
  clearUploadData,
  saveFileBlob,
  loadFileBlob,
} from '../lib/upload-session'

const CHUNK_SIZE = 100
const MAX_CHUNK_RETRIES = 3

export default function CSVUploader({ storeId, vendors, defaultFileType = 'products' }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [formData, setFormData] = useState({
    vendor_id: vendors.length > 0 ? vendors[0].id : '',
    file_type: defaultFileType === 'variations' ? 'variations' : 'products',
  })
  const [file, setFile] = useState(null)
  const [dragActive, setDragActive] = useState(false)
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 })
  const [resumableSession, setResumableSession] = useState(null)
  const [checkingResume, setCheckingResume] = useState(true)
  const abortRef = useRef(false)
  const uploadingRef = useRef(false)

  const parseCSVFile = useCallback((inputFile) => {
    return new Promise((resolve, reject) => {
      Papa.parse(inputFile, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => {
          return header.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
        },
        complete: (results) => resolve(results.data),
        error: (parseError) => reject(parseError),
      })
    })
  }, [])

  useEffect(() => {
    let cancelled = false

    async function checkResume() {
      const session = loadSession(storeId)
      if (!session?.csvUploadId) {
        if (!cancelled) setCheckingResume(false)
        return
      }

      try {
        const statusRes = await fetch(`/api/csv/upload/${session.csvUploadId}/status`)
        if (!statusRes.ok) {
          await clearUploadData(storeId, session.csvUploadId)
          if (!cancelled) setCheckingResume(false)
          return
        }

        const status = await statusRes.json()
        if (status.status === 'completed') {
          await clearUploadData(storeId, session.csvUploadId)
          if (!cancelled) setCheckingResume(false)
          return
        }

        const blob = await loadFileBlob(session.csvUploadId)
        if (!blob) {
          if (!cancelled) setCheckingResume(false)
          return
        }

        const synced = {
          ...session,
          lastCompletedChunk: status.last_chunk_index ?? session.lastCompletedChunk ?? -1,
          totalChunks: status.total_chunks ?? session.totalChunks,
          totalRows: status.expected_row_count ?? session.totalRows,
        }
        saveSession(storeId, synced)

        if (!cancelled) {
          setResumableSession(synced)
          setFormData({
            vendor_id: String(synced.vendorId),
            file_type: synced.fileType,
          })
        }
      } catch {
        // ignore resume check errors
      } finally {
        if (!cancelled) setCheckingResume(false)
      }
    }

    checkResume()
    return () => {
      cancelled = true
    }
  }, [storeId])

  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (uploadingRef.current) {
        e.preventDefault()
        e.returnValue = 'Upload in progress. You can resume later from this page.'
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (e.dataTransfer.files?.[0]) handleFileSelect(e.dataTransfer.files[0])
  }

  const handleFileChange = (e) => {
    if (e.target.files?.[0]) handleFileSelect(e.target.files[0])
  }

  const handleFileSelect = (selectedFile) => {
    if (!selectedFile.name.endsWith('.csv')) {
      setError('Please select a CSV file')
      return
    }
    setFile(selectedFile)
    setResumableSession(null)
    setError('')
    setUploadProgress({ current: 0, total: 0 })
  }

  const uploadChunkWithRetry = async (payload, chunkNumber) => {
    let lastError
    for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
      if (abortRef.current) throw new Error('Upload cancelled')
      try {
        const response = await fetch('/api/csv/upload-chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || `Chunk ${chunkNumber} failed`)
        }
        return response.json()
      } catch (err) {
        lastError = err
        if (attempt < MAX_CHUNK_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * attempt))
        }
      }
    }
    throw lastError
  }

  const runUpload = async ({
    csvData,
    csvUploadId,
    totalChunks,
    startChunk = 0,
    fileName,
    vendorId,
    fileType,
    persistSession = true,
  }) => {
    abortRef.current = false
    uploadingRef.current = true
    setLoading(true)
    setUploadProgress({ current: startChunk, total: totalChunks })

    const session = {
      csvUploadId,
      storeId,
      vendorId,
      fileType,
      fileName,
      totalRows: csvData.length,
      totalChunks,
      chunkSize: CHUNK_SIZE,
      lastCompletedChunk: startChunk - 1,
    }
    if (persistSession) saveSession(storeId, session)

    let totalProcessed = 0
    const totalErrors = []

    try {
      for (let i = startChunk; i < totalChunks; i++) {
        if (abortRef.current) {
          session.lastCompletedChunk = i - 1
          saveSession(storeId, session)
          setSuccess(`Upload paused at chunk ${i} of ${totalChunks}. You can resume when ready.`)
          return { paused: true }
        }

        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, csvData.length)
        const chunk = csvData.slice(start, end)

        setSuccess(`Uploading chunk ${i + 1} of ${totalChunks} (rows ${start + 1}-${end})...`)
        setUploadProgress({ current: i + 1, total: totalChunks })

        const chunkResult = await uploadChunkWithRetry(
          {
            csvUploadId,
            storeId,
            vendorId,
            fileType,
            chunk,
            chunkIndex: i,
            totalChunks,
            fileName,
          },
          i + 1
        )

        if (!chunkResult.skipped) {
          totalProcessed += chunkResult.processedCount || 0
          if (chunkResult.errors?.length) {
            totalErrors.push(...chunkResult.errors)
          }
        }

        session.lastCompletedChunk = i
        saveSession(storeId, session)
      }

      await fetch(`/api/csv/upload/${csvUploadId}/finalize`, { method: 'POST' })
      await clearUploadData(storeId, csvUploadId)

      const errorCount = totalErrors.length
      const successMsg = `CSV uploaded successfully! ${totalProcessed} rows processed.`
      const errorMsg = errorCount > 0 ? ` ${errorCount} rows had errors.` : ''
      setSuccess(successMsg + errorMsg)
      setResumableSession(null)
      setFile(null)
      setUploadProgress({ current: 0, total: 0 })

      const fileInput = document.getElementById('file-input')
      if (fileInput) fileInput.value = ''

      setTimeout(() => {
        router.push(`/admin/store/${storeId}/products`)
      }, 2000)

      return { completed: true }
    } finally {
      uploadingRef.current = false
      setLoading(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (!file) {
      setError('Please select a CSV file')
      return
    }
    if (!formData.vendor_id) {
      setError('Please select a vendor')
      return
    }

    try {
      setSuccess('Parsing CSV file...')
      const csvData = await parseCSVFile(file)
      if (csvData.length === 0) throw new Error('CSV file is empty')

      const totalChunks = Math.ceil(csvData.length / CHUNK_SIZE)
      setSuccess(`Initializing upload for ${csvData.length} rows...`)

      const initResponse = await fetch('/api/csv/init-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeId,
          vendorId: formData.vendor_id,
          fileType: formData.file_type,
          fileName: file.name,
          totalRows: csvData.length,
          totalChunks,
        }),
      })

      if (!initResponse.ok) {
        const initData = await initResponse.json()
        throw new Error(initData.error || 'Failed to initialize upload')
      }

      const { csvUploadId } = await initResponse.json()
      await saveFileBlob(csvUploadId, file)

      await runUpload({
        csvData,
        csvUploadId,
        totalChunks,
        startChunk: 0,
        fileName: file.name,
        vendorId: formData.vendor_id,
        fileType: formData.file_type,
      })
    } catch (err) {
      setError(err.message)
      setLoading(false)
      uploadingRef.current = false
    }
  }

  const handleResume = async () => {
    if (!resumableSession) return
    setError('')
    setSuccess('Loading saved file...')

    try {
      const blob = await loadFileBlob(resumableSession.csvUploadId)
      if (!blob) {
        throw new Error('Saved file not found. Please select the CSV again to resume.')
      }

      const csvData = await parseCSVFile(blob)
      const startChunk = (resumableSession.lastCompletedChunk ?? -1) + 1
      const totalChunks =
        resumableSession.totalChunks || Math.ceil(csvData.length / CHUNK_SIZE)

      if (startChunk >= totalChunks) {
        await fetch(`/api/csv/upload/${resumableSession.csvUploadId}/finalize`, {
          method: 'POST',
        })
        await clearUploadData(storeId, resumableSession.csvUploadId)
        setResumableSession(null)
        setSuccess('Upload was already complete.')
        return
      }

      setFile(blob)
      await runUpload({
        csvData,
        csvUploadId: resumableSession.csvUploadId,
        totalChunks,
        startChunk,
        fileName: resumableSession.fileName,
        vendorId: resumableSession.vendorId,
        fileType: resumableSession.fileType,
      })
    } catch (err) {
      setError(err.message)
      setLoading(false)
      uploadingRef.current = false
    }
  }

  const handleDiscardResume = async () => {
    if (resumableSession) {
      await clearUploadData(storeId, resumableSession.csvUploadId)
    }
    setResumableSession(null)
    setFile(null)
    setSuccess('')
    setError('')
  }

  const handlePause = () => {
    abortRef.current = true
  }

  const resumeProgress =
    resumableSession && resumableSession.totalChunks
      ? Math.round(
          ((resumableSession.lastCompletedChunk + 1) / resumableSession.totalChunks) * 100
        )
      : 0

  return (
    <div className="bg-white shadow rounded-lg p-6 max-w-2xl">
      {checkingResume && (
        <p className="text-sm text-gray-500 mb-4">Checking for incomplete uploads...</p>
      )}

      {!checkingResume && resumableSession && !loading && (
        <div className="bg-amber-50 border border-amber-300 text-amber-900 px-4 py-3 rounded mb-4">
          <p className="font-medium">Incomplete upload found</p>
          <p className="text-sm mt-1">
            <strong>{resumableSession.fileName}</strong> — {resumeProgress}% complete (
            {resumableSession.lastCompletedChunk + 1} of {resumableSession.totalChunks} chunks)
          </p>
          <p className="text-xs mt-1 text-amber-800">
            You can resume where it stopped, even after closing this tab.
          </p>
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={handleResume}
              className="px-3 py-1.5 bg-amber-600 text-white text-sm rounded hover:bg-amber-700"
            >
              Resume Upload
            </button>
            <button
              type="button"
              onClick={handleDiscardResume}
              className="px-3 py-1.5 border border-amber-400 text-sm rounded hover:bg-amber-100"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-400 text-green-700 px-4 py-3 rounded mb-4">
          {success}
          {uploadProgress.total > 0 && (
            <div className="mt-2">
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-green-600 h-2 rounded-full transition-all duration-300"
                  style={{
                    width: `${(uploadProgress.current / uploadProgress.total) * 100}%`,
                  }}
                />
              </div>
              <p className="text-xs mt-1 text-green-800">
                Chunk {uploadProgress.current} of {uploadProgress.total} — safe to leave and
                resume later
              </p>
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label htmlFor="vendor_id" className="block text-sm font-medium text-gray-700">
            Vendor *
          </label>
          <select
            id="vendor_id"
            name="vendor_id"
            required
            value={formData.vendor_id}
            onChange={(e) => setFormData({ ...formData, vendor_id: e.target.value })}
            disabled={loading}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          >
            <option value="">Select a vendor...</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Upload Type *
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              disabled={loading}
              onClick={() => setFormData({ ...formData, file_type: 'products' })}
              className={`rounded-lg border-2 p-4 text-left transition-colors ${
                formData.file_type === 'products'
                  ? 'border-indigo-600 bg-indigo-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="font-medium text-gray-900">Products</div>
              <div className="text-xs text-gray-500 mt-1">
                Parent product rows (SKU, name, price, etc.)
              </div>
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => setFormData({ ...formData, file_type: 'variations' })}
              className={`rounded-lg border-2 p-4 text-left transition-colors ${
                formData.file_type === 'variations'
                  ? 'border-indigo-600 bg-indigo-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="font-medium text-gray-900">Variations</div>
              <div className="text-xs text-gray-500 mt-1">
                Variant rows linked by parent SKU (size, color, etc.)
              </div>
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            CSV File *
          </label>
          <p className="text-xs text-gray-500 mb-2">
            {formData.file_type === 'products'
              ? 'Upload a products CSV. Upload variations separately after parent products exist.'
              : 'Upload a variations CSV. Parent products must already exist in the catalog.'}
            {' '}Large files upload in the background — you can leave and resume later.
          </p>
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center ${
              dragActive
                ? 'border-indigo-500 bg-indigo-50'
                : 'border-gray-300 hover:border-gray-400'
            }`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            {file ? (
              <div>
                <p className="text-sm text-gray-600 mb-1">
                  <strong>{file.name}</strong>
                </p>
                <p className="text-xs text-gray-500 mb-2">
                  Size: {(file.size / 1024 / 1024).toFixed(2)}MB
                </p>
                {uploadProgress.total > 0 && (
                  <div className="mt-2">
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
                        style={{
                          width: `${(uploadProgress.current / uploadProgress.total) * 100}%`,
                        }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Chunk {uploadProgress.current} of {uploadProgress.total}
                    </p>
                  </div>
                )}
                {!loading && (
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="text-sm text-red-600 hover:text-red-800"
                  >
                    Remove
                  </button>
                )}
              </div>
            ) : (
              <div>
                <p className="text-gray-600 mb-2">
                  Drag and drop a CSV file here, or click to select
                </p>
                <label htmlFor="file-input" className="cursor-pointer">
                  <span className="text-indigo-600 hover:text-indigo-800">Select File</span>
                  <input
                    id="file-input"
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    className="hidden"
                    disabled={loading}
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end space-x-4">
          {loading && (
            <button
              type="button"
              onClick={handlePause}
              className="px-4 py-2 border border-amber-400 text-amber-800 rounded-md hover:bg-amber-50"
            >
              Pause
            </button>
          )}
          <button
            type="button"
            onClick={() => router.back()}
            disabled={loading}
            className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !file}
            className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Uploading...' : 'Upload CSV'}
          </button>
        </div>
      </form>
    </div>
  )
}
