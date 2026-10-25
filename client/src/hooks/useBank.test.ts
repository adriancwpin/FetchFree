import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { updateCachedList } from '@/hooks/useBank'

const KEY = ['accounts', 'acc-1', 'categoryRules']
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('updateCachedList (after saving a budget or rule)', () => {
  it("isn't undone by a fetch that left before the save and answers after it", async () => {
    const client = newClient()
    client.setQueryData(KEY, ['saved before'])
    // A refetch (e.g. on window focus) whose answer predates the save.
    const refetch = client
      .fetchQuery({ queryKey: KEY, queryFn: () => wait(20).then(() => ['stale answer']), staleTime: 0 })
      .catch(() => undefined)

    await updateCachedList<string>(client, KEY, (list) => [...list, 'just saved'])
    await refetch
    await wait(30)

    expect(client.getQueryData(KEY)).toEqual(['saved before', 'just saved'])
  })

  it('fetches the whole list when none was loaded, rather than showing only the saved entry', async () => {
    const client = newClient()
    let answer: () => Promise<string[]> = () => Promise.reject(new Error('server down'))
    const observer = new QueryObserver(client, { queryKey: KEY, queryFn: () => answer() })
    const unsubscribe = observer.subscribe(() => {})
    await wait(10)
    expect(client.getQueryState(KEY)?.status).toBe('error')

    answer = async () => ['older rule', 'just saved']
    await updateCachedList<string>(client, KEY, (list) => [...list, 'just saved'])

    expect(client.getQueryData(KEY)).toEqual(['older rule', 'just saved'])
    unsubscribe()
  })
})
