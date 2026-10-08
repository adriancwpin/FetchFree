interface PendingAuth {
  createdAt: Date
}

interface Account {
  uid: string
  [key: string]: unknown
}

interface CurrentSession {
  sessionId: string
  accounts: Account[]
}

const pendingAuths = new Map<string, PendingAuth>()

let currentSession: CurrentSession | null = null

export const sessionStore = {
  addPendingAuth(state: string): void {
    pendingAuths.set(state, { createdAt: new Date() })
  },
  consumePendingAuth(state: string): boolean {
    return pendingAuths.delete(state)
  },
  setCurrentSession(session: CurrentSession): void {
    currentSession = session
  },
  getCurrentSession(): CurrentSession | null {
    return currentSession
  },
}
