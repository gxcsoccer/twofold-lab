const apiKey = process.env.DEEPSEEK_API_KEY

if (apiKey === undefined || apiKey.trim().length === 0) {
  process.stderr.write('DEEPSEEK_API_KEY is required for the provider smoke test\n')
  process.exitCode = 2
} else {
  const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly: TWOFOLD_V4_PRO_OK',
          },
        ],
        max_tokens: 32,
        stream: false,
      }),
    })

    const payload = await response.json().catch(() => undefined)
    if (!response.ok) {
      const providerCode = payload?.error?.code ?? payload?.error?.type ?? 'unknown'
      throw new Error(`provider returned HTTP ${response.status} (${String(providerCode)})`)
    }

    const model = typeof payload?.model === 'string' ? payload.model : 'unknown'
    const requestId = response.headers.get('x-request-id')
      ?? response.headers.get('x-deepseek-request-id')
      ?? (typeof payload?.id === 'string' ? payload.id : 'unavailable')
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('provider returned no assistant text')
    }

    process.stdout.write(
      `DeepSeek provider smoke passed: requested=deepseek-v4-pro returned=${model} request=${requestId}\n`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`DeepSeek provider smoke failed: ${message}\n`)
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
  }
}
