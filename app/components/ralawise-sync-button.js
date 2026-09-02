'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/app/components/ui/button'
import { Check, Circle, Loader2, Pause, Play, RefreshCw, X } from 'lucide-react'

const STORAGE_KEY = (storeId) => `ralawise-sync-job:${storeId}`

const STEPS = [
  { key: 'connecting', label: 'Connecting to Ralawise' },
  { key: 'downloading', label: 'Downloading latest files' },
  { key: 'delta', label: 'Comparing to last import' },
  { key: 'importing_products', label: 'Importing products' },
  { key: 'importing_variations', label: 'Importing variations' },
]

const STEP_ORDER = [
  'queued',
  'connecting',
  'downloading',
  'delta',
  'importing_products',
  'importing_variations',
  'finalize',
  'completed',
  'failed',
]

const ACTIVE_STATUSES = new Set([
  'queued',
  'connecting',
  'downloading',
  'delta',
  'importing_products',
  'importing_variations',
  'finalize',
])

function stepIndex(status) {
  const idx = STEP_ORDER.indexOf(status)
  return idx === -1 ? 0 : idx
}

function isTerminal(status) {
  return status === 'completed' || status === 'failed'
}

function isRunning(status) {
  return ACTIVE_STATUSES.has(status)
}

function StepIcon({ state }) {
  if (state === 'done') {
    return <Check className="h-4 w-4 text-green-600" />
  }
  if (state === 'active') {
    return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
  }
  if (state === 'paused') {
    return <Pause className="h-4 w-4 text-amber-600" />
  }
  if (state === 'failed') {
    return <X className="h-4 w-4 text-red-600" />
  }
  return <Circle className="h-4 w-4 text-gray-300" />
}

export default function RalawiseSyncButton({
  storeId,
  vendors = [],
  defaultVendorId = '',
  compact = false,
}) {
  const initialVendor =
    defaultVendorId ||
    (vendors.length === 1 ? String(vendors[0].id) : '') ||
    (vendors[0] ? String(vendors[0].id) : '')

  const [vendorId, setVendorId] = useState(String(initialVendor || ''))
  const [loading, setLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState(null)
  const abortRef = useRef(false)

  const applyJob = useCallback(
    (data) => {
      if (!data) return
      setJob(data)
      if (isTerminal(data.status)) {
        setLoading(false)
        try {
          sessionStorage.removeItem(STORAGE_KEY(storeId))
        } catch {
          // ignore
        }
        if (data.status === 'failed') {
          setError(data.error || data.message || 'Ralawise sync failed')
        }
      } else if (data.status === 'paused') {
        setLoading(false)
      } else if (isRunning(data.status)) {
        setLoading(true)
      }
    },
    [storeId]
  )

  const runBatchLoop = useCallback(async (jobId, startingPhase = 'parents') => {
    setLoading(true)
    abortRef.current = false
    let currentPhase = startingPhase

    try {
      // 1. Process Parent Batches
      while (currentPhase === 'parents') {
        if (abortRef.current) break

        const res = await fetch(`/api/ralawise/sync/${jobId}/batch-parents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchSize: 250 }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Parent batch failed')

        if (data.paused || data.job?.status === 'paused' || data.job?.cancelRequested) {
          applyJob(data.job)
          return
        }

        applyJob(data.job)
        currentPhase = data.phase
      }

      // 2. Process Variation Batches
      while (currentPhase === 'variations') {
        if (abortRef.current) break

        const res = await fetch(`/api/ralawise/sync/${jobId}/batch-variations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchSize: 500 }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Variation batch failed')

        if (data.paused || data.job?.status === 'paused' || data.job?.cancelRequested) {
          applyJob(data.job)
          return
        }

        applyJob(data.job)
        currentPhase = data.phase
      }

      // 3. Finalize
      if (currentPhase === 'finalize') {
        if (abortRef.current) return

        const res = await fetch(`/api/ralawise/sync/${jobId}/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Finalize failed')

        applyJob(data.job)
      }
    } catch (err) {
      console.error('Batched sync error:', err)
      setError(err.message || 'Sync failed')
      setLoading(false)
    }
  }, [applyJob])

  // Restore active or paused job from session/server on mount
  useEffect(() => {
    let savedJobId = null
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY(storeId))
      if (raw) {
        const parsed = JSON.parse(raw)
        savedJobId = parsed?.jobId
      }
    } catch {
      // ignore
    }

    if (savedJobId) {
      fetch(`/api/ralawise/sync/${savedJobId}/status`)
        .then((r) => r.json())
        .then((data) => {
          if (data && !data.error) {
            applyJob(data)
            if (isRunning(data.status)) {
              runBatchLoop(data.jobId, data.phase || 'parents')
            }
          }
        })
        .catch(() => {})
    }
  }, [storeId, applyJob, runBatchLoop])

  const handleSync = async () => {
    setError('')
    setLoading(true)
    setActionBusy(true)
    abortRef.current = false

    try {
      const res = await fetch('/api/ralawise/sync/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId, vendor_id: vendorId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Prepare failed')

      applyJob(data.job)
      try {
        sessionStorage.setItem(
          STORAGE_KEY(storeId),
          JSON.stringify({ jobId: data.jobId })
        )
      } catch {
        // ignore
      }

      if (data.phase === 'completed' || data.no_changes) {
        setLoading(false)
        setActionBusy(false)
        return
      }

      await runBatchLoop(data.jobId, data.phase || 'parents')
    } catch (err) {
      setError(err.message || 'Failed to start sync')
      setLoading(false)
    } finally {
      setActionBusy(false)
    }
  }

  const handleStop = async () => {
    if (!job?.jobId) return
    abortRef.current = true
    setActionBusy(true)
    try {
      const res = await fetch(`/api/ralawise/sync/${job.jobId}/stop`, {
        method: 'POST',
      })
      const data = await res.json()
      applyJob(data)
    } catch (err) {
      console.error('Stop error:', err)
    } finally {
      setActionBusy(false)
      setLoading(false)
    }
  }

  const handleResume = async () => {
    if (!job?.jobId) return
    setError('')
    setActionBusy(true)
    abortRef.current = false
    try {
      const res = await fetch(`/api/ralawise/sync/${job.jobId}/resume`, {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to resume sync')

      applyJob(data)
      try {
        sessionStorage.setItem(
          STORAGE_KEY(storeId),
          JSON.stringify({ jobId: data.jobId })
        )
      } catch {
        // ignore
      }

      await runBatchLoop(job.jobId, data.phase || 'parents')
    } catch (err) {
      setError(err.message || 'Failed to resume sync')
    } finally {
      setActionBusy(false)
    }
  }

  const status = job?.status || 'idle'
  const currentStepIdx = stepIndex(status)
  const result = job?.result
  const showProgress = status !== 'idle'

  const canStop = (isRunning(status) || loading) && !actionBusy
  const canResume = status === 'paused' && !actionBusy && !loading

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {vendors.length > 1 && (
        <label className="block text-sm text-gray-600">
          Vendor
          <select
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            value={vendorId}
            disabled={loading || status === 'paused'}
            onChange={(e) => setVendorId(e.target.value)}
          >
            <option value="">Select vendor</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={loading || status === 'paused' || !vendorId}
          onClick={handleSync}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Syncing from Ralawise...' : 'Sync from Ralawise'}
        </Button>

        {canStop && (
          <Button
            type="button"
            variant="outline"
            className="shrink-0 border-amber-300 text-amber-800 hover:bg-amber-50"
            disabled={actionBusy}
            onClick={handleStop}
          >
            <Pause className="h-4 w-4 mr-1" />
            Stop
          </Button>
        )}

        {canResume && (
          <Button
            type="button"
            variant="outline"
            className="shrink-0 border-green-300 text-green-800 hover:bg-green-50"
            disabled={actionBusy}
            onClick={handleResume}
          >
            <Play className="h-4 w-4 mr-1" />
            Resume
          </Button>
        )}
      </div>

      {showProgress && job && (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-3 space-y-2">
          {status === 'paused' && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              Paused at {(job.current || 0).toLocaleString()} /{' '}
              {(job.total || 0).toLocaleString()}. Click Resume to continue.
            </p>
          )}
          <ol className="space-y-2">
            {STEPS.map((step, idx) => {
              const orderIdx = STEP_ORDER.indexOf(step.key)
              let state = 'pending'
              if (status === 'completed' || currentStepIdx > orderIdx) {
                state = 'done'
              } else if (status === 'failed' && currentStepIdx === orderIdx) {
                state = 'failed'
              } else if (status === 'paused' && currentStepIdx === orderIdx) {
                state = 'paused'
              } else if (
                currentStepIdx === orderIdx ||
                (status === 'queued' && idx === 0)
              ) {
                state = status === 'failed' ? 'failed' : 'active'
              }

              const isProductStep = step.key === 'importing_products'
              const isVarStep = step.key === 'importing_variations'
              const isImportStep = isProductStep || isVarStep

              const stepProcessed = isProductStep
                ? (job.parentProcessed || 0)
                : (isVarStep ? (job.variationProcessed || 0) : job.current)
              const stepTotal = isProductStep
                ? (job.parentTotal || 0)
                : (isVarStep ? (job.variationTotal || 0) : job.total)

              const showCounts =
                (state === 'active' || state === 'paused') &&
                isImportStep &&
                stepTotal > 0

              const stepPercent = stepTotal > 0 ? Math.min(100, Math.round((stepProcessed / stepTotal) * 100)) : 0

              return (
                <li key={step.key} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 shrink-0">
                    <StepIcon state={state} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={
                        state === 'active'
                          ? 'font-medium text-gray-900'
                          : state === 'paused'
                            ? 'font-medium text-amber-800'
                            : state === 'done'
                              ? 'text-gray-700'
                              : state === 'failed'
                                ? 'font-medium text-red-700'
                                : 'text-gray-400'
                      }
                    >
                      {step.label}
                      {state === 'active' ? '...' : ''}
                      {state === 'paused' ? ' (paused)' : ''}
                      {showCounts ? (
                        <span className="ml-1 font-normal text-gray-600">
                          {stepProcessed.toLocaleString()} / {stepTotal.toLocaleString()}
                        </span>
                      ) : null}
                    </p>
                    {state === 'active' && job.message && !isImportStep ? (
                      <p className="text-xs text-gray-500 mt-0.5">{job.message}</p>
                    ) : null}
                    {state === 'active' &&
                    step.key === 'delta' &&
                    (job.products?.skipped > 0 || job.variations?.skipped > 0) ? (
                      <p className="text-xs text-gray-500 mt-0.5">
                        Skipped {job.products.skipped.toLocaleString()} products,{' '}
                        {job.variations.skipped.toLocaleString()} variations unchanged
                      </p>
                    ) : null}
                    {showCounts ? (
                      <div className="mt-1.5">
                        <div className="w-full bg-gray-200 rounded-full h-2">
                          <div
                            className={`h-2 rounded-full transition-all duration-300 ${
                              state === 'paused' ? 'bg-amber-500' : 'bg-green-600'
                            }`}
                            style={{
                              width: `${stepPercent}%`,
                            }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {status === 'completed' && (
        <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 space-y-1">
          <p className="font-medium">
            {result?.no_changes
              ? 'No changes since last import'
              : 'Ralawise sync complete'}
          </p>
          <p>
            Products: {job.products?.new ?? result?.products?.new ?? 0} new,{' '}
            {job.products?.updated ?? result?.products?.updated ?? 0} updated
            {(job.products?.skipped ?? result?.products?.skipped)
              ? ` (${(job.products?.skipped ?? result?.products?.skipped).toLocaleString()} unchanged skipped)`
              : ''}
            {(job.products?.errors ?? result?.products?.errorCount)
              ? ` (${job.products?.errors ?? result?.products?.errorCount} errors)`
              : ''}
          </p>
          <p>
            Variations: {job.variations?.new ?? result?.variations?.new ?? 0} new,{' '}
            {job.variations?.updated ?? result?.variations?.updated ?? 0} updated
            {(job.variations?.skipped ?? result?.variations?.skipped)
              ? ` (${(job.variations?.skipped ?? result?.variations?.skipped).toLocaleString()} unchanged skipped)`
              : ''}
            {(job.variations?.errors ?? result?.variations?.errorCount)
              ? ` (${job.variations?.errors ?? result?.variations?.errorCount} errors)`
              : ''}
          </p>
          <p className="text-xs text-green-700">
            New products stay pending until approved. Updated approved products are ready for
            store export/sync.
          </p>
        </div>
      )}
    </div>
  )
}
