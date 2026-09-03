import { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, RotateCw } from 'lucide-react'
/** Minimal shape the viewer needs — decoupled from any storage model. */
export interface ViewableImage {
  id: string
  dataUrl: string
  caption?: string
}

export function Lightbox({
  images,
  startIndex = 0,
  onClose,
}: {
  images: ViewableImage[]
  startIndex?: number
  onClose: () => void
}) {
  const [idx, setIdx] = useState(startIndex)
  const [zoom, setZoom] = useState(1)
  const [rot, setRot] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragging = useRef<{ x: number; y: number } | null>(null)

  const reset = useCallback(() => {
    setZoom(1)
    setRot(0)
    setPan({ x: 0, y: 0 })
  }, [])

  const go = useCallback(
    (d: number) => {
      setIdx((i) => (i + d + images.length) % images.length)
      reset()
    },
    [images.length, reset],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') go(1)
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(5, z + 0.5))
      if (e.key === '-') setZoom((z) => Math.max(1, z - 0.5))
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [go, onClose])

  if (images.length === 0) return null
  const img = images[idx]

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90 animate-fade-in backdrop-blur">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-2 p-3 text-white safe-top">
        <span className="text-sm font-medium opacity-80">
          {idx + 1} / {images.length}
          {img.caption ? ` · ${img.caption}` : ''}
        </span>
        <div className="flex items-center gap-1">
          <button className="rounded-lg p-2 hover:bg-white/10" onClick={() => setZoom((z) => Math.max(1, z - 0.5))} aria-label="Zoom out">
            <ZoomOut className="h-5 w-5" />
          </button>
          <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <button className="rounded-lg p-2 hover:bg-white/10" onClick={() => setZoom((z) => Math.min(5, z + 0.5))} aria-label="Zoom in">
            <ZoomIn className="h-5 w-5" />
          </button>
          <button className="rounded-lg p-2 hover:bg-white/10" onClick={() => setRot((r) => r + 90)} aria-label="Rotate">
            <RotateCw className="h-5 w-5" />
          </button>
          <button className="rounded-lg p-2 hover:bg-white/10" onClick={onClose} aria-label="Close">
            <X className="h-6 w-6" />
          </button>
        </div>
      </div>

      {/* Image stage */}
      <div
        className="relative flex-1 select-none overflow-hidden"
        onClick={onClose}
        onMouseDown={(e) => {
          if (zoom > 1) dragging.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
        }}
        onMouseMove={(e) => {
          if (dragging.current) setPan({ x: e.clientX - dragging.current.x, y: e.clientY - dragging.current.y })
        }}
        onMouseUp={() => (dragging.current = null)}
        onMouseLeave={() => (dragging.current = null)}
        onWheel={(e) => setZoom((z) => Math.min(5, Math.max(1, z - e.deltaY * 0.002)))}
      >
        <img
          src={img.dataUrl}
          alt={img.caption || 'inspection'}
          draggable={false}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setZoom((z) => (z > 1 ? 1 : 2.5))
          }}
          onClick={(e) => e.stopPropagation()}
          className="absolute left-1/2 top-1/2 max-h-full max-w-full object-contain transition-transform"
          style={{
            transform: `translate(-50%,-50%) translate(${pan.x}px,${pan.y}px) scale(${zoom}) rotate(${rot}deg)`,
            cursor: zoom > 1 ? 'grab' : 'zoom-in',
          }}
        />

        {images.length > 1 && (
          <>
            <button
              className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
              onClick={(e) => {
                e.stopPropagation()
                go(-1)
              }}
              aria-label="Previous"
            >
              <ChevronLeft className="h-7 w-7" />
            </button>
            <button
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
              onClick={(e) => {
                e.stopPropagation()
                go(1)
              }}
              aria-label="Next"
            >
              <ChevronRight className="h-7 w-7" />
            </button>
          </>
        )}
      </div>

      {/* Thumbnails */}
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto p-3 safe-bottom">
          {images.map((im, i) => (
            <button
              key={im.id}
              onClick={() => {
                setIdx(i)
                reset()
              }}
              className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg ring-2 ${
                i === idx ? 'ring-brand-500' : 'ring-transparent opacity-60'
              }`}
            >
              <img src={im.dataUrl} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  )
}
