"use client"

import { useState, useRef, useEffect } from 'react'
import { Bell } from 'lucide-react'

interface Notif {
  id: string
  title: string
  message: string
  time: string
  read?: boolean
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<Notif[]>([])
  const ref = useRef<HTMLDivElement>(null)
  const unread = notifications.filter((n) => !n.read).length

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  function markAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
  }

  return (
    <div className="relative" ref={ref}>
      <button
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative w-[34px] h-[34px] grid place-items-center text-[#8a8f97] hover:text-[#e6e6e6] transition-colors"
      >
        <Bell size={15} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[#e34c4c] px-1 text-[9px] font-bold leading-none text-white">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[340px] rounded-[12px] border border-[#1f232a] bg-[#0f1217] shadow-[0_20px_40px_rgba(0,0,0,.6)] z-50 overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#1f232a] px-4 py-3">
            <span className="text-[13px] font-semibold text-[#e6e6e6]">Notifications</span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="text-[12px] font-medium text-[#8a8f97] hover:text-[#e6e6e6] transition-colors"
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[400px] overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
            {notifications.length === 0 ? (
              <div className="px-5 py-10 text-center text-[13px] text-[#5a5f66]">
                No notifications yet
              </div>
            ) : (
              <div className="divide-y divide-[#1f232a]">
                {notifications.map((n) => (
                  <div key={n.id} className="flex gap-3 px-4 py-3 hover:bg-[#14171c] transition-colors">
                    <div className="flex w-8 h-8 shrink-0 items-center justify-center rounded-full bg-[#14171c] text-[#8a8f97]">
                      <Bell size={14} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-[#e6e6e6]">{n.title}</span>
                        {!n.read && <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-[#e34c4c]" />}
                      </div>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-[#8a8f97]">{n.message}</p>
                      <span className="mt-1 block text-[11px] text-[#5a5f66]">{n.time}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
