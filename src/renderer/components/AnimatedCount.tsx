import { useEffect, useRef, useState } from 'react'

/** A number that counts to its new value (about 0.5 s), so a change in the search reads as a change. */
export default function AnimatedCount({ value }: { value: number }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    if (start === value) return undefined
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 550)
      const eased = 1 - (1 - p) ** 3
      const next = Math.round(start + (value - start) * eased)
      from.current = next
      setShown(next)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{shown.toLocaleString()}</>
}
