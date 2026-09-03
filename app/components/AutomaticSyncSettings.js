'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/app/components/ui/button'
import { Check, Clock, Globe, Mail, AlertCircle, Loader2, Send } from 'lucide-react'

export default function AutomaticSyncSettings({ storeId, storeName }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingEmail, setTestingEmail] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [syncTime, setSyncTime] = useState('14:00')
  const [notifyEmails, setNotifyEmails] = useState('')
  const [statusData, setStatusData] = useState(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [testEmailSuccess, setTestEmailSuccess] = useState('')
  const [testEmailError, setTestEmailError] = useState('')

  useEffect(() => {
    fetch(`/api/stores/${storeId}/sync-settings`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setEnabled(Boolean(data.enabled))
          setSyncTime(data.syncTime || '14:00')
          setNotifyEmails(data.notifyEmails || '')
          setStatusData(data)
        } else {
          setError(data.error || 'Failed to load sync settings')
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [storeId])

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true)
    setMessage('')
    setError('')

    try {
      const res = await fetch(`/api/stores/${storeId}/sync-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          syncTime,
          notifyEmails,
        }),
      })

      const data = await res.json()
      if (res.ok && data.ok) {
        setMessage('Automatic sync settings saved successfully.')
        setEnabled(data.enabled)
        setSyncTime(data.syncTime)
        setNotifyEmails(data.notifyEmails || '')
        // Refresh status
        fetch(`/api/stores/${storeId}/sync-settings`)
          .then((r) => r.json())
          .then((d) => d.ok && setStatusData(d))
          .catch(() => {})
      } else {
        setError(data.error || 'Failed to save settings')
      }
    } catch (err) {
      setError(err.message || 'An error occurred while saving')
    } finally {
      setSaving(false)
    }
  }

  const handleSendTestEmail = async () => {
    if (!notifyEmails || notifyEmails.trim() === '') {
      setTestEmailError('Please enter at least one recipient email address before testing.')
      return
    }

    setTestingEmail(true)
    setTestEmailSuccess('')
    setTestEmailError('')

    try {
      const res = await fetch(`/api/stores/${storeId}/sync-settings/test-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: notifyEmails }),
      })

      const data = await res.json()
      if (res.ok && data.ok) {
        setTestEmailSuccess(data.message || 'Test email sent successfully.')
      } else {
        setTestEmailError(data.error || 'Failed to send test email')
      }
    } catch (err) {
      setTestEmailError(err.message || 'An error occurred while sending test email')
    } finally {
      setTestingEmail(false)
    }
  }

  const formatUkDate = (dateStr) => {
    if (!dateStr) return 'Never'
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(dateStr)) + ' (UK)'
  }

  if (loading) {
    return (
      <div className="bg-white shadow rounded-lg p-6 flex items-center justify-center space-x-2 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>Loading automatic sync settings...</span>
      </div>
    )
  }

  return (
    <div className="bg-white shadow rounded-lg p-6 space-y-6">
      <div className="border-b border-gray-200 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <Clock className="h-5 w-5 text-indigo-600" />
              Automatic Ralawise Daily Sync
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Configure automated daily supplier catalog import and email reporting for {storeName}.
            </p>
          </div>
          <span
            className={`px-3 py-1 rounded-full text-xs font-semibold ${
              enabled
                ? 'bg-green-100 text-green-800'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            {enabled ? 'AUTOMATIC SYNC ACTIVE' : 'SCHEDULE DISABLED'}
          </span>
        </div>
      </div>

      {message && (
        <div className="p-3 bg-green-50 border border-green-200 text-green-800 rounded-md text-sm flex items-center gap-2">
          <Check className="h-4 w-4 shrink-0 text-green-600" />
          <span>{message}</span>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-md text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-5">
        {/* Toggle Switch */}
        <div className="flex items-center justify-between py-2 border-b border-gray-100">
          <div>
            <label htmlFor="auto-sync-toggle" className="font-medium text-gray-900 cursor-pointer">
              Enable Daily Automatic Sync
            </label>
            <p className="text-xs text-gray-500">
              When enabled, WooApp automatically downloads and synchronizes delta changes from Ralawise once daily.
            </p>
          </div>
          <input
            id="auto-sync-toggle"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Sync Time */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Scheduled Sync Time
            </label>
            <input
              type="time"
              value={syncTime}
              onChange={(e) => setSyncTime(e.target.value)}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Default is <strong>14:00 (2:00 PM)</strong>. Sync runs once daily at this local time.
            </p>
          </div>

          {/* Timezone (Read-only) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Timezone
            </label>
            <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-md px-3 py-2 text-sm text-gray-700">
              <Globe className="h-4 w-4 text-gray-400" />
              <span>UK Time (Europe/London) � GMT / BST</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Automatically adjusts for UK Daylight Saving Time (BST).
            </p>
          </div>
        </div>

        {/* Notification Emails */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Mail className="h-4 w-4 text-gray-500" />
            Notification Recipient Emails
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={notifyEmails}
              onChange={(e) => {
                setNotifyEmails(e.target.value)
                setTestEmailSuccess('')
                setTestEmailError('')
              }}
              placeholder="e.g. admin@southline.co.uk, alerts@southline.co.uk"
              className="block flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
            <Button
              type="button"
              variant="outline"
              disabled={testingEmail || !notifyEmails.trim()}
              onClick={handleSendTestEmail}
              className="shrink-0 border-indigo-200 text-indigo-700 hover:bg-indigo-50"
            >
              {testingEmail ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-1.5" />
                  Send Test Email
                </>
              )}
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            Comma-separated email addresses to receive sync completion summaries and pause/failure alerts.
          </p>

          {/* Test Email Result Feedback */}
          {testEmailSuccess && (
            <div className="p-2.5 bg-green-50 border border-green-200 text-green-800 rounded-md text-xs flex items-center gap-2">
              <Check className="h-4 w-4 shrink-0 text-green-600" />
              <span>{testEmailSuccess}</span>
            </div>
          )}

          {testEmailError && (
            <div className="p-2.5 bg-red-50 border border-red-200 text-red-800 rounded-md text-xs flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
              <span>{testEmailError}</span>
            </div>
          )}
        </div>

        {/* Status Observability Grid */}
        {statusData && (
          <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div>
              <span className="text-gray-500 block">Last Scheduled Sync:</span>
              <span className="font-semibold text-gray-900">
                {formatUkDate(statusData.lastScheduledSyncAt)}
              </span>
            </div>
            <div>
              <span className="text-gray-500 block">Last Status:</span>
              <span
                className={`font-semibold capitalize ${
                  statusData.lastScheduledStatus === 'completed'
                    ? 'text-green-700'
                    : statusData.lastScheduledStatus === 'failed' || statusData.lastScheduledStatus === 'paused'
                      ? 'text-amber-700'
                      : 'text-gray-700'
                }`}
              >
                {statusData.lastScheduledStatus || 'No runs recorded'}
              </span>
            </div>
            <div>
              <span className="text-gray-500 block">Last Email Sent:</span>
              <span className="font-semibold text-gray-900">
                {formatUkDate(statusData.lastScheduledEmailAt || statusData.lastJob?.completionEmailSentAt)}
              </span>
            </div>
          </div>
        )}

        {/* Note on WordPress separation */}
        <div className="rounded-md bg-blue-50 border border-blue-100 p-3 text-xs text-blue-800">
          <strong>Safe Architecture Note:</strong> Automatic Ralawise sync updates the WooApp central catalog only. Exporting products to WordPress remains strictly a manual, controlled operation from the Products & Export page.
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving} className="min-w-[140px]">
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Settings'
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
