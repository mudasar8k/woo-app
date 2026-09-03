/**
 * Transactional email notifications for Ralawise Sync (Resend integration).
 */

const RESEND_API_URL = 'https://api.resend.com/emails'

/**
 * Format date/time in UK local time (Europe/London) with timezone abbreviation.
 */
function formatUkDateTime(date) {
  if (!date) return 'N/A'
  const d = typeof date === 'string' ? new Date(date) : date
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(d) + ' (UK Time)'
}

/**
 * Format duration in human-readable minutes/seconds.
 */
function formatDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return 'N/A'
  const start = new Date(startedAt).getTime()
  const end = new Date(completedAt).getTime()
  const diffSec = Math.max(0, Math.round((end - start) / 1000))
  const mins = Math.floor(diffSec / 60)
  const secs = diffSec % 60
  if (mins === 0) return `${secs}s`
  return `${mins}m ${secs}s`
}

/**
 * Parse comma/semicolon separated email addresses.
 */
function parseRecipients(input, fallback = '') {
  const combined = [input, fallback].filter(Boolean).join(',')
  const list = combined
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0 && e.includes('@'))
  return [...new Set(list)]
}

/**
 * Dispatch an email via Resend REST API (zero npm dependencies).
 */
async function sendResendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'WooApp Sync <onboarding@resend.dev>'

  if (!apiKey) {
    console.warn('[Notifications] RESEND_API_KEY not configured. Email not sent:', {
      to,
      subject,
    })
    return { ok: false, error: 'RESEND_API_KEY is not configured', skipped: true }
  }

  if (!to || to.length === 0) {
    console.warn('[Notifications] No recipients provided. Email not sent.')
    return { ok: false, error: 'No recipient emails specified', skipped: true }
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
      }),
    })

    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const errMsg = data?.message || `Resend API error (${res.status})`
      console.error('[Notifications] Resend API failed:', errMsg)
      return { ok: false, error: errMsg }
    }

    console.log('[Notifications] Email sent successfully via Resend:', {
      id: data?.id,
      to,
      subject,
    })
    return { ok: true, id: data?.id }
  } catch (err) {
    console.error('[Notifications] Email fetch failed:', err.message)
    return { ok: false, error: err.message }
  }
}

/**
 * Send completion email with atomic idempotency check.
 */
async function sendSyncCompletionEmail(db, { store, job, approvedProductCount = 564 }) {
  if (!job?.id) return { ok: false, error: 'Invalid job' }

  // 1. Atomic conditional update to ensure idempotency
  const claimRes = await db.query(
    `UPDATE ralawise_sync_jobs
     SET completion_email_sent_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND completion_email_sent_at IS NULL
     RETURNING id, completion_email_sent_at`,
    [job.id]
  )

  if (claimRes.rows.length === 0) {
    console.log(`[Notifications] Completion email already sent for job #${job.id}. Skipping.`)
    return { ok: true, alreadySent: true }
  }

  const recipients = parseRecipients(
    store.ralawise_sync_notify_emails,
    process.env.RALAWISE_SYNC_NOTIFY_EMAILS
  )

  if (recipients.length === 0) {
    console.log('[Notifications] No notification email configured for store. Skipping.')
    return { ok: true, noRecipients: true }
  }

  const duration = formatDuration(job.started_at, job.completed_at || new Date())
  const startTimeUk = formatUkDateTime(job.started_at)
  const completedTimeUk = formatUkDateTime(job.completed_at || new Date())
  const trigger = job.trigger_source === 'scheduled' ? 'Scheduled Daily Sync' : 'Manual Sync'
  const dateStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date())

  const subject = `[WooApp] ${store.name || 'Southline'} Ralawise Sync Complete - ${dateStr}`

  const prodNew = Number(job.products_new) || 0
  const prodUpdated = Number(job.products_updated) || 0
  const prodErrors = Number(job.products_errors) || 0

  const varNew = Number(job.variations_new) || 0
  const varUpdated = Number(job.variations_updated) || 0
  const varErrors = Number(job.variations_errors) || 0

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px;">
      <h2 style="color: #059669; margin-top: 0;">Ralawise Sync Completed Successfully</h2>
      <p>The Ralawise supplier catalog synchronization for <strong>${store.name || 'Store'}</strong> finished without critical errors.</p>
      
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 8px 0; color: #6b7280;"><strong>Store:</strong></td>
          <td style="padding: 8px 0; text-align: right;">${store.name} (ID: ${store.id})</td>
        </tr>
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 8px 0; color: #6b7280;"><strong>Trigger Type:</strong></td>
          <td style="padding: 8px 0; text-align: right;">${trigger}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 8px 0; color: #6b7280;"><strong>Started (UK):</strong></td>
          <td style="padding: 8px 0; text-align: right;">${startTimeUk}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 8px 0; color: #6b7280;"><strong>Completed (UK):</strong></td>
          <td style="padding: 8px 0; text-align: right;">${completedTimeUk}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 8px 0; color: #6b7280;"><strong>Duration:</strong></td>
          <td style="padding: 8px 0; text-align: right;">${duration}</td>
        </tr>
      </table>

      <h3 style="color: #1f2937; margin-bottom: 8px;">Sync Summary</h3>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr style="background-color: #f9fafb; text-align: left;">
            <th style="padding: 8px; border: 1px solid #e5e7eb;">Entity</th>
            <th style="padding: 8px; border: 1px solid #e5e7eb;">New</th>
            <th style="padding: 8px; border: 1px solid #e5e7eb;">Updated</th>
            <th style="padding: 8px; border: 1px solid #e5e7eb;">Errors</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding: 8px; border: 1px solid #e5e7eb;"><strong>Parent Products</strong></td>
            <td style="padding: 8px; border: 1px solid #e5e7eb;">${prodNew.toLocaleString()}</td>
            <td style="padding: 8px; border: 1px solid #e5e7eb;">${prodUpdated.toLocaleString()}</td>
            <td style="padding: 8px; border: 1px solid #e5e7eb;">${prodErrors}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #e5e7eb;"><strong>Variations</strong></td>
            <td style="padding: 8px; border: 1px solid #e5e7eb;">${varNew.toLocaleString()}</td>
            <td style="padding: 8px; border: 1px solid #e5e7eb;">${varUpdated.toLocaleString()}</td>
            <td style="padding: 8px; border: 1px solid #e5e7eb;">${varErrors}</td>
          </tr>
        </tbody>
      </table>

      <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 12px; margin-bottom: 20px;">
        <p style="margin: 0; color: #166534; font-size: 14px;">
          <strong>Store 4 Catalog Status:</strong> ${approvedProductCount} approved products are ready in WooApp.
          <br><small>Note: WordPress export remains manual via the WooApp Connector.</small>
        </p>
      </div>

      <p style="font-size: 12px; color: #9ca3af; margin-bottom: 0;">
        This automated notification was generated by WooApp for ${store.name}.
      </p>
    </div>
  `

  const text = `
Ralawise Sync Completed Successfully
Store: ${store.name} (ID: ${store.id})
Trigger: ${trigger}
Duration: ${duration}
Started: ${startTimeUk}
Completed: ${completedTimeUk}

Products: ${prodNew} new, ${prodUpdated} updated, ${prodErrors} errors
Variations: ${varNew} new, ${varUpdated} updated, ${varErrors} errors
Store 4 Approved Products: ${approvedProductCount}

Final Status: Completed
  `.trim()

  const sendResult = await sendResendEmail({
    to: recipients,
    subject,
    html,
    text,
  })

  // Update store last scheduled email timestamp
  await db.query(
    `UPDATE stores SET last_scheduled_email_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [store.id]
  ).catch(() => {})

  return sendResult
}

/**
 * Send failure / pause email with atomic idempotency check.
 */
async function sendSyncFailureEmail(db, { store, job, error }) {
  if (!job?.id) return { ok: false, error: 'Invalid job' }

  // 1. Atomic conditional update to ensure idempotency
  const claimRes = await db.query(
    `UPDATE ralawise_sync_jobs
     SET failure_email_sent_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND failure_email_sent_at IS NULL
     RETURNING id, failure_email_sent_at`,
    [job.id]
  )

  if (claimRes.rows.length === 0) {
    console.log(`[Notifications] Failure email already sent for job #${job.id}. Skipping.`)
    return { ok: true, alreadySent: true }
  }

  const recipients = parseRecipients(
    store.ralawise_sync_notify_emails,
    process.env.RALAWISE_SYNC_NOTIFY_EMAILS
  )

  if (recipients.length === 0) {
    console.log('[Notifications] No notification email configured for store. Skipping.')
    return { ok: true, noRecipients: true }
  }

  const timeUk = formatUkDateTime(new Date())
  const subject = `[WooApp Alert] ${store.name || 'Southline'} Ralawise Sync Needs Attention`
  const errorMessage = error?.message || job.error_message || 'Sync was paused after retry exhaustion'

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #fecaca; border-radius: 8px; padding: 24px;">
      <h2 style="color: #dc2626; margin-top: 0;">?? Ralawise Sync Needs Attention</h2>
      <p>The Ralawise synchronization for <strong>${store.name || 'Store'}</strong> encountered an issue and was paused safely to protect catalog data.</p>
      
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 8px 0; color: #6b7280;"><strong>Job ID:</strong></td>
          <td style="padding: 8px 0; text-align: right;">#${job.id}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 8px 0; color: #6b7280;"><strong>Phase / Step:</strong></td>
          <td style="padding: 8px 0; text-align: right;">${job.phase || job.step || 'N/A'}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 8px 0; color: #6b7280;"><strong>Progress:</strong></td>
          <td style="padding: 8px 0; text-align: right;">
            Parents: ${job.parent_processed || 0} / ${job.parent_total || 0}<br>
            Variations: ${job.variation_processed || 0} / ${job.variation_total || 0}
          </td>
        </tr>
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 8px 0; color: #6b7280;"><strong>Time (UK):</strong></td>
          <td style="padding: 8px 0; text-align: right;">${timeUk}</td>
        </tr>
      </table>

      <div style="background-color: #fef2f2; border: 1px solid #f87171; border-radius: 6px; padding: 12px; margin-bottom: 20px;">
        <p style="margin: 0; color: #991b1b; font-size: 14px;">
          <strong>Error Summary:</strong><br>${errorMessage}
        </p>
      </div>

      <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; margin-bottom: 20px;">
        <p style="margin: 0; font-size: 14px; color: #374151;">
          <strong>Recommended Action:</strong><br>
          The sync cursor has been preserved in Neon Postgres. You can visit the Store Dashboard and click <strong>Resume</strong> to continue processing from the exact failed batch without data loss.
        </p>
      </div>

      <p style="font-size: 12px; color: #9ca3af; margin-bottom: 0;">
        This automated alert was generated by WooApp for ${store.name}.
      </p>
    </div>
  `

  const text = `
[WooApp Alert] Ralawise Sync Needs Attention
Store: ${store.name} (ID: ${store.id})
Job ID: #${job.id}
Phase: ${job.phase || job.step}
Progress: Parents: ${job.parent_processed || 0}/${job.parent_total || 0}, Variations: ${job.variation_processed || 0}/${job.variation_total || 0}
Time (UK): ${timeUk}
Error: ${errorMessage}

Action: Log in to WooApp and click Resume to continue from the saved cursor.
  `.trim()

  const sendResult = await sendResendEmail({
    to: recipients,
    subject,
    html,
    text,
  })

  await db.query(
    `UPDATE stores SET last_scheduled_email_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [store.id]
  ).catch(() => {})

  return sendResult
}

module.exports = {
  sendResendEmail,
  sendSyncCompletionEmail,
  sendSyncFailureEmail,
  formatUkDateTime,
  formatDuration,
  parseRecipients,
}
