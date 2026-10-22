import { vi } from 'vitest'

export interface FakeCall {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string>
  body: unknown
}

type Handler = (call: FakeCall) => Response | Promise<Response>

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Replaces global fetch with a fake Enable Banking API and records every call it receives,
// so tests exercise the real request/paging/error code without touching the network.
export function fakeBank(handler: Handler): FakeCall[] {
  const calls: FakeCall[] = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const call: FakeCall = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return handler(call)
  })
  return calls
}
