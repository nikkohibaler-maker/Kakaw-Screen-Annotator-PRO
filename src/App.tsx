/**
 * ProAnnotate — Improved App.tsx
 *
 * Key fixes vs original:
 *  1. Stale closure bug: keyboard shortcuts use refs, not captured state
 *  2. Eraser is now undoable (pushes removed strokes into redoStack)
 *  3. Touch events wired up (onTouchStart / onTouchMove / onTouchEnd)
 *  4. Sub-menus close on outside click (pointerdown capture listener)
 *  5. Visual eraser cursor (SVG circle follows the pointer)
 *  6. Empty text nodes pruned on blur/Escape
 *  7. Smart shape detection shows a toast confirmation
 *  8. Toolbar drag clamped to viewport bounds
 *  9. Vertical size slider uses writing-mode, not a janky CSS rotation
 * 10. localStorage saves are debounced (1 s) to avoid blocking every stroke
 * 11. `left-4.5` Tailwind class replaced with `left-[18px]` (valid class)
 * 12. Electron IPC extracted to a thin hook so the component stays clean
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence, Reorder } from 'motion/react';
import {
  Pencil, Minus, Sparkles, Eraser, Trash2, MousePointer2,
  ChevronRight, ChevronLeft, Square, Circle, ArrowUpRight,
  Triangle, Type, Search, RotateCcw, RotateCw, Download, Power,
  Settings, GripVertical, Eye, EyeOff, Highlighter, Zap, Copy, Palette
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type DrawingTool =
  | 'pen' | 'straightLine' | 'disappearingInk' | 'eraser' | 'pointer'
  | 'rectangle' | 'ellipse' | 'arrow' | 'triangle' | 'text' | 'magnifier'
  | 'highlighter' | 'laserPointer';

interface Point { x: number; y: number; t?: number; }

interface Stroke {
  id: string;
  points: Point[];
  tool: DrawingTool;
  color: string;
  width: number;
  opacity: number;
  isDisappearing?: boolean;
  createdAt: number;
  text?: string;
  vanishOverride?: number; // for laser pointer
}

// ─── Utility: path simplification (Ramer-Douglas-Peucker) ────────────────────
// ... (omitted for brevity in search)

function simplifyPath(pts: Point[], tol: number): Point[] {
  if (pts.length <= 2) return pts;
  const sq = tol * tol;
  function sqSegDist(p: Point, a: Point, b: Point): number {
    let x = a.x, y = a.y, dx = b.x - x, dy = b.y - y;
    if (dx || dy) {
      const t = Math.max(0, Math.min(1, ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy)));
      x += dx * t; y += dy * t;
    }
    return (p.x - x) ** 2 + (p.y - y) ** 2;
  }
  function step(pts: Point[], f: number, l: number, out: Point[]) {
    let max = sq, idx = -1;
    for (let i = f + 1; i < l; i++) {
      const d = sqSegDist(pts[i], pts[f], pts[l]);
      if (d > max) { max = d; idx = i; }
    }
    if (idx !== -1) { step(pts, f, idx, out); out.push(pts[idx]); step(pts, idx, l, out); }
  }
  const out = [pts[0]];
  step(pts, 0, pts.length - 1, out);
  out.push(pts[pts.length - 1]);
  return out;
}

// ─── Utility: smart shape detection ──────────────────────────────────────────

function detectShape(pts: Point[]): { tool: DrawingTool; points: Point[] } | null {
  if (pts.length < 10) return null;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = x1 - x0, h = y1 - y0;
  if (w < 30 && h < 30) return null;

  const verts = simplifyPath(pts, Math.max(w, h) * 0.1);
  const s = pts[0], e = pts[pts.length - 1];
  const isClosed = Math.hypot(e.x - s.x, e.y - s.y) < Math.max(w, h) * 0.25;

  if (verts.length === 2) return { tool: 'straightLine', points: [s, e] };

  if (isClosed) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = (w + h) / 4;
    let variance = 0;
    pts.forEach(p => { variance += Math.abs(Math.hypot(p.x - cx, p.y - cy) - r); });
    if (1 - variance / pts.length / r > 0.88)
      return { tool: 'ellipse', points: [{ x: x0, y: y0 }, { x: x1, y: y1 }] };
    if (verts.length === 4) return { tool: 'triangle', points: [{ x: x0, y: y0 }, { x: x1, y: y1 }] };
    if (verts.length === 5) return { tool: 'rectangle', points: [{ x: x0, y: y0 }, { x: x1, y: y1 }] };
  } else {
    for (let i = 1; i < verts.length - 1; i++) {
      const v1 = { x: verts[i].x - verts[i - 1].x, y: verts[i].y - verts[i - 1].y };
      const v2 = { x: verts[i + 1].x - verts[i].x, y: verts[i + 1].y - verts[i].y };
      const angle = Math.abs(Math.atan2(v1.x * v2.y - v1.y * v2.x, v1.x * v2.x + v1.y * v2.y));
      if (angle > 2.5) return { tool: 'arrow', points: [verts[0], verts[i]] };
    }
  }
  return null;
}

// ─── Utility: SVG path data ────────────────────────────────────────────────

function getPathData(points: Point[], tool: DrawingTool): string {
  if (points.length < 2) return '';
  const s = points[0], e = points[points.length - 1];
  switch (tool) {
    case 'straightLine':
      return `M${s.x} ${s.y}L${e.x} ${e.y}`;
    case 'rectangle':
      return `M${s.x} ${s.y}H${e.x}V${e.y}H${s.x}Z`;
    case 'ellipse': {
      const rx = Math.abs(e.x - s.x) / 2, ry = Math.abs(e.y - s.y) / 2;
      const cx = (s.x + e.x) / 2, cy = (s.y + e.y) / 2;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}`;
    }
    case 'triangle': {
      const tx = (s.x + e.x) / 2;
      return `M${tx} ${s.y}L${e.x} ${e.y}L${s.x} ${e.y}Z`;
    }
    case 'arrow': {
      const a = Math.atan2(e.y - s.y, e.x - s.x), hl = 20;
      return `M${s.x} ${s.y}L${e.x} ${e.y}M${e.x} ${e.y}L${e.x - hl * Math.cos(a - Math.PI / 6)} ${e.y - hl * Math.sin(a - Math.PI / 6)}M${e.x} ${e.y}L${e.x - hl * Math.cos(a + Math.PI / 6)} ${e.y - hl * Math.sin(a + Math.PI / 6)}`;
    }
    default: {
      let d = `M${points[0].x} ${points[0].y}`;
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i], p2 = points[i + 1];
        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        d += i === 0 ? `L${mx} ${my}` : `Q${p1.x} ${p1.y} ${mx} ${my}`;
      }
      return d + `L${e.x} ${e.y}`;
    }
  }
}

// ─── Electron IPC hook (isolated so the component stays clean) ───────────────

function useElectronIPC(tool: DrawingTool) {
  const ipcRenderer = useMemo(() => {
    if (typeof window === 'undefined') return null;
    if ((window.process as any)?.type === 'renderer' || navigator.userAgent.includes('Electron')) {
      try { return (window as any).require('electron').ipcRenderer; } catch { return null; }
    }
    return null;
  }, []);

  useEffect(() => {
    if (!ipcRenderer) return;
    ipcRenderer.send('set-ignore-mouse-events', tool === 'pointer', { forward: tool === 'pointer' });
  }, [tool, ipcRenderer]);

  return {
    isElectron: !!ipcRenderer,
    pausePassthrough: () => ipcRenderer?.send('set-ignore-mouse-events', false),
    resumePassthrough: () => ipcRenderer?.send('set-ignore-mouse-events', tool === 'pointer', { forward: tool === 'pointer' }),
    quit: () => ipcRenderer?.send('quit-app'),
  };
}

// ─── Color palette ────────────────────────────────────────────────────────────

const PALETTE = [
  '#FF3B30', '#FF9500', '#FFCC00', '#32D74B',
  '#64D2FF', '#0A84FF', '#5E5CE6', '#BF5AF2',
  '#FFFFFF', '#555566',
];

const TOOL_METADATA: Record<DrawingTool, { label: string; icon: any; hotkey?: string }> = {
  pen: { label: 'Pen', icon: Pencil, hotkey: '1' },
  highlighter: { label: 'Highlight', icon: Highlighter, hotkey: '6' },
  laserPointer: { label: 'Laser', icon: Zap, hotkey: '7' },
  disappearingInk: { label: 'Vanish', icon: Sparkles, hotkey: '3' },
  eraser: { label: 'Eraser', icon: Eraser, hotkey: '4' },
  pointer: { label: 'Pointer', icon: MousePointer2, hotkey: '5' },
  straightLine: { label: 'Line', icon: Minus, hotkey: '2' },
  rectangle: { label: 'Rect', icon: Square },
  ellipse: { label: 'Circle', icon: Circle },
  arrow: { label: 'Arrow', icon: ArrowUpRight },
  triangle: { label: 'Triangle', icon: Triangle },
  text: { label: 'Text', icon: Type },
  magnifier: { label: 'Magnify', icon: Search },
};

const INITIAL_ORDER: DrawingTool[] = [
  'pen', 'highlighter', 'laserPointer', 'disappearingInk', 'eraser', 'pointer', 
  'straightLine', 'rectangle', 'ellipse', 'arrow', 
  'triangle', 'text', 'magnifier'
];

// ─── Main component ───────────────────────────────────────────────────────────

export default function App() {
  // ── Tool state ────────────────────────────────────────────────────────────
  const [tool, setTool]             = useState<DrawingTool>('pen');
  const [color, setColor]           = useState('#32D74B');
  const [lineWidth, setLineWidth]   = useState(4);
  const [smartShape, setSmartShape] = useState(true);
  const [vanishMs, setVanishMs]     = useState(3000);
  const [eraserSize, setEraserSize] = useState(40);

  // ── Canvas state ──────────────────────────────────────────────────────────
  const [strokes, setStrokes]     = useState<Stroke[]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);
  const [curPts, setCurPts]       = useState<Point[]>([]);
  const [drawing, setDrawing]     = useState(false);
  const [shift, setShift]         = useState(false);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [expanded, setExpanded]       = useState(false);
  const [tbOpen, setTbOpen]           = useState(true);
  const [subMenu, setSubMenu]         = useState<'vanish' | 'eraser' | 'color' | 'settings' | null>(null);
  const [magPos, setMagPos]           = useState<Point | null>(null);
  const [eraserClient, setEraserClient] = useState<Point | null>(null);
  const [toast, setToast]             = useState<string | null>(null);
  const [activeText, setActiveText]   = useState<string | null>(null);
  const [tempText, setTempText]       = useState('');
  const [tbOffset, setTbOffset]       = useState({ x: 0, y: 0 });
  const [draggingTb, setDraggingTb]   = useState(false);

  // ── Customization state ──
  const [toolOrder, setToolOrder] = useState<DrawingTool[]>(() => {
    try {
      const saved = localStorage.getItem('tool_order_v1');
      return saved ? JSON.parse(saved) : INITIAL_ORDER;
    } catch { return INITIAL_ORDER; }
  });
  const [hiddenTools, setHiddenTools] = useState<DrawingTool[]>(() => {
    try {
      const saved = localStorage.getItem('hidden_tools_v1');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  // Save customization changes
  useEffect(() => {
    localStorage.setItem('tool_order_v1', JSON.stringify(toolOrder));
  }, [toolOrder]);
  useEffect(() => {
    localStorage.setItem('hidden_tools_v1', JSON.stringify(hiddenTools));
  }, [hiddenTools]);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const containerRef  = useRef<HTMLDivElement>(null);
  const strokesRef    = useRef(strokes);
  const redoRef       = useRef(redoStack);
  const dragOrigin    = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);
  const saveTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs in sync (needed for stale-closure-free keyboard callbacks)
  useEffect(() => { strokesRef.current = strokes; }, [strokes]);
  useEffect(() => { redoRef.current = redoStack; }, [redoStack]);

  // ── Electron IPC ──────────────────────────────────────────────────────────
  const { isElectron, pausePassthrough, resumePassthrough, quit } = useElectronIPC(tool);

  // ── Persistence: save (debounced 1 s) ─────────────────────────────────────
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try { localStorage.setItem('proannotate_v2', JSON.stringify(strokes)); } catch { /* ignore */ }
    }, 1000);
  }, [strokes]);

  // ── Disappearing ink cleanup ───────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setStrokes(prev => prev.filter(s => {
        if (!s.isDisappearing) return true;
        const delay = s.vanishOverride ?? vanishMs;
        return now - s.createdAt < delay + 250;
      }));
    }, 150);
    return () => clearInterval(id);
  }, [vanishMs]);

  // ── Close sub-menus on outside click ─────────────────────────────────────
  useEffect(() => {
    if (!subMenu) return;
    const handler = (e: PointerEvent) => {
      const root = document.getElementById('tb-root');
      if (root && !root.contains(e.target as Node)) setSubMenu(null);
    };
    window.addEventListener('pointerdown', handler, true);
    return () => window.removeEventListener('pointerdown', handler, true);
  }, [subMenu]);

  // ── Undo / Redo ──────────────────────────────────────────────────────────
  const selectTool = (t: DrawingTool) => {
    setTool(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(`Tool: ${TOOL_METADATA[t].label}`);
    toastTimer.current = setTimeout(() => setToast(null), 1000);
    
    if (t === 'disappearingInk') setSubMenu(m => m === 'vanish' ? null : 'vanish');
    else if (t === 'eraser') setSubMenu(m => m === 'eraser' ? null : 'eraser');
    else setSubMenu(null);
  };

  const undo = useCallback(() => {
    const s = strokesRef.current, r = redoRef.current;
    if (!s.length) return;
    setStrokes(s.slice(0, -1));
    setRedoStack([...r, s[s.length - 1]]);
  }, []);

  const redo = useCallback(() => {
    const r = redoRef.current;
    if (!r.length) return;
    setRedoStack(r.slice(0, -1));
    setStrokes(prev => [...prev, r[r.length - 1]]);
  }, []);

  const clearAll = useCallback(() => {
    // Push all current strokes into redo so the user can recover with Ctrl+Z
    setRedoStack(prev => [...prev.slice(-50), ...strokesRef.current]);
    setStrokes([]);
    setSubMenu(null);
  }, []);

  // ── CSS keyframe injection for disappearing ink ───────────────────────────
  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = '@keyframes vanishInk { from { opacity: 1; } to { opacity: 0; } }';
    document.head.appendChild(el);
    return () => document.head.removeChild(el);
  }, []);

  // ── Persistence: load ─────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem('proannotate_v2');
      if (saved) setStrokes(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  // ── Listen for Menu Bar Actions ──
  useEffect(() => {
    if (!isElectron || !(window as any).require) return;
    const { ipcRenderer } = (window as any).require('electron');

    const toggleTb = () => setTbOpen(prev => !prev);
    const doClear = () => clearAll();
    const doUndo = () => undo();
    const doRedo = () => redo();

    ipcRenderer.on('toggle-toolbar', toggleTb);
    ipcRenderer.on('clear-canvas', doClear);
    ipcRenderer.on('undo-stroke', doUndo);
    ipcRenderer.on('redo-stroke', doRedo);

    return () => {
      ipcRenderer.removeListener('toggle-toolbar', toggleTb);
      ipcRenderer.removeListener('clear-canvas', doClear);
      ipcRenderer.removeListener('undo-stroke', doUndo);
      ipcRenderer.removeListener('redo-stroke', doRedo);
    };
  }, [isElectron, clearAll, undo, redo]);

  // ── Keyboard shortcuts (uses refs — no stale closures) ────────────────────
  useEffect(() => {
    const toolKeys: Record<string, DrawingTool> = {
      '1': 'pen', '2': 'straightLine', '3': 'disappearingInk', '4': 'eraser', '5': 'pointer',
      '6': 'highlighter', '7': 'laserPointer'
    };
    const down = (e: KeyboardEvent) => {
      if (activeText) return; // don't intercept while typing
      if (e.shiftKey) setShift(true);
      
      const newTool = toolKeys[e.key];
      if (newTool) {
        setTool(newTool);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast(`Tool: ${TOOL_METADATA[newTool].label}`);
        toastTimer.current = setTimeout(() => setToast(null), 1000);
      }

      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      if (mod && e.key === 'k') { e.preventDefault(); clearAll(); }
      if (mod && e.key === 'c') { e.preventDefault(); copyToClipboard(); }
      if (mod && e.key === 'q') quit();
    };
    const up = (e: KeyboardEvent) => { if (!e.shiftKey) setShift(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [activeText, undo, redo, clearAll, quit]);

  // ── Coordinates ────────────────────────────────────────────────────────────
  const getContainerPt = (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent): Point | null => {
    if (!containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const src = 'touches' in e ? (e as TouchEvent).touches[0] : (e as MouseEvent);
    return { x: src.clientX - rect.left, y: src.clientY - rect.top, t: Date.now() };
  };

  // ── Eraser ────────────────────────────────────────────────────────────────
  const eraseAt = useCallback((pt: Point) => {
    const r = eraserSize / 2;
    setStrokes(prev => {
      const removed: Stroke[] = [];
      const kept = prev.filter(stroke => {
        const hit = stroke.points.some(p => Math.hypot(p.x - pt.x, p.y - pt.y) < r);
        if (hit) removed.push(stroke);
        return !hit;
      });
      if (removed.length) setRedoStack(r => [...r.slice(-50), ...removed]);
      return kept;
    });
  }, [eraserSize]);

  // ── Drawing handlers ──────────────────────────────────────────────────────
  const onPointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    if (tool === 'pointer' || tool === 'magnifier') return;
    const pt = getContainerPt(e);
    if (!pt) return;

    if (tool === 'text') {
      const id = Math.random().toString(36).slice(2);
      setStrokes(prev => [...prev, {
        id, points: [pt], tool: 'text',
        color, width: lineWidth, opacity: 1, createdAt: Date.now(), text: '',
      }]);
      setActiveText(id);
      setTempText('');
      return;
    }

    setDrawing(true);
    setCurPts([pt]);
    setRedoStack([]); // new action clears redo

    if (tool === 'eraser') eraseAt(pt);
  };

  const onPointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    const src = 'touches' in e ? (e as React.TouchEvent).touches[0] : (e as React.MouseEvent);

    if (tool === 'eraser') {
      setEraserClient({ x: src.clientX, y: src.clientY });
      if (drawing) { const pt = getContainerPt(e); if (pt) eraseAt(pt); }
      return;
    }
    const pt = getContainerPt(e);
    setMagPos(pt); // Use magPos for cursor visualization location generally

    if (tool === 'magnifier') {
      return;
    }
    if (!drawing) return;
    if (pt) setCurPts(prev => [...prev, pt]);
  };

  const onPointerUp = () => {
    if (!drawing) return;
    if (tool === 'eraser') { setDrawing(false); return; }

    let finalTool = tool;
    let finalPts  = curPts;

    if (smartShape && tool === 'pen' && !shift && finalPts.length > 10) {
      const detected = detectShape(finalPts);
      if (detected) {
        finalTool = detected.tool;
        finalPts  = detected.points;
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast(detected.tool);
        toastTimer.current = setTimeout(() => setToast(null), 1800);
      }
    }

    if (finalTool === 'pen' && !shift) finalPts = simplifyPath(finalPts, 1.5);

    const isLaser = finalTool === 'laserPointer';
    const isVanish = finalTool === 'disappearingInk' || isLaser;

    const stroke: Stroke = {
      id: Math.random().toString(36).slice(2),
      points: finalPts,
      tool: finalTool === 'pen' && shift ? 'straightLine' : finalTool,
      color: color,
      width: finalTool === 'highlighter' ? lineWidth * 2.5 : lineWidth,
      opacity: finalTool === 'highlighter' ? 0.35 : 1,
      isDisappearing: isVanish,
      vanishOverride: isLaser ? 400 : undefined,
      createdAt: Date.now(),
    };

    setStrokes(prev => [...prev, stroke]);
    setDrawing(false);
    setCurPts([]);
  };

  // ── Text commit (prunes empty text nodes) ─────────────────────────────────
  const commitText = (id: string, text: string) => {
    if (!text.trim()) setStrokes(prev => prev.filter(s => s.id !== id));
    else setStrokes(prev => prev.map(s => s.id === id ? { ...s, text } : s));
    setActiveText(null);
  };

  // ── Export PNG ────────────────────────────────────────────────────────────
  const exportPng = () => {
    const svg = containerRef.current?.querySelector('svg');
    if (!svg) return;
    const data = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d')!;
    const img = new Image();
    const blob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      ctx.fillStyle = '#121212';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'annotation.png';
      a.click();
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  // ── Copy to Clipboard ─────────────────────────────────────────────────────
  const copyToClipboard = () => {
    const svg = containerRef.current?.querySelector('svg');
    if (!svg) return;
    const data = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d')!;
    const img = new Image();
    const blob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        if (!blob) return;
        try {
          const item = new ClipboardItem({ 'image/png': blob });
          navigator.clipboard.write([item]);
          setToast('Copied to clipboard');
          if (toastTimer.current) clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(() => setToast(null), 2000);
        } catch (e) {
          console.error("Clipboard API failed:", e);
        }
      });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  // ── Toolbar drag ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!draggingTb) return;
    const move = (e: MouseEvent) => {
      if (!dragOrigin.current) return;
      const dx = e.clientX - dragOrigin.current.mx;
      const dy = e.clientY - dragOrigin.current.my;
      setTbOffset({
        x: Math.max(-400, Math.min(300, dragOrigin.current.ox + dx)),
        y: Math.max(-200, Math.min(window.innerHeight * 0.75, dragOrigin.current.oy + dy)),
      });
    };
    const up = () => setDraggingTb(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [draggingTb]);

  // ── Cursor ────────────────────────────────────────────────────────────────
  const cursor =
    tool === 'eraser'    ? 'none'    :
    tool === 'magnifier' ? 'none'    :
    tool === 'pointer'   ? 'default' :
    tool === 'text'      ? 'text'    : 'default';

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-screen h-screen select-none touch-none bg-transparent overflow-hidden">

      {isElectron && <div className="fixed top-0 left-0 right-0 h-8 z-[100] pointer-events-none" />}

      {/* ── Drawing surface ── */}
      <div
        ref={containerRef}
        className="absolute inset-0 z-20"
        style={{ cursor }}
        onMouseDown={onPointerDown}
        onMouseMove={onPointerMove}
        onMouseUp={onPointerUp}
        onMouseLeave={() => { setEraserClient(null); setMagPos(null); if (drawing) onPointerUp(); }}
        onTouchStart={onPointerDown}
        onTouchMove={onPointerMove}
        onTouchEnd={onPointerUp}
      >
        <svg className="w-full h-full pointer-events-none">
          {[...strokes]
            .sort((a, b) => {
              if (a.tool === 'highlighter' && b.tool !== 'highlighter') return -1;
              if (a.tool !== 'highlighter' && b.tool === 'highlighter') return 1;
              return 0;
            })
            .map(stroke =>
              stroke.tool === 'text' ? (
              <g key={stroke.id}>
                <rect
                  x={stroke.points[0].x - 10} y={stroke.points[0].y - 30}
                  width={220} height={44} fill="transparent"
                  className="pointer-events-auto cursor-text"
                  onClick={e => {
                    e.stopPropagation();
                    if (tool === 'eraser') {
                      setRedoStack(r => [...r, stroke]);
                      setStrokes(prev => prev.filter(s => s.id !== stroke.id));
                    } else {
                      setActiveText(stroke.id);
                      setTempText(stroke.text || '');
                    }
                  }}
                />
                <text
                  x={stroke.points[0].x} y={stroke.points[0].y}
                  fill={stroke.color}
                  fontSize={stroke.width * 3 + 14}
                  fontFamily="system-ui, -apple-system, sans-serif"
                  fontWeight="500"
                  className="pointer-events-none"
                >
                  {stroke.text || (activeText === stroke.id ? '' : '|')}
                </text>
              </g>
            ) : (
              <path
                key={stroke.id}
                d={getPathData(stroke.points, stroke.tool)}
                stroke={stroke.color}
                strokeWidth={stroke.width}
                strokeOpacity={stroke.opacity}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                style={stroke.isDisappearing
                  ? { animation: `vanishInk ${vanishMs}ms linear forwards` }
                  : undefined}
                className={tool === 'eraser' ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none'}
                onClick={() => {
                  if (tool === 'eraser') {
                    setRedoStack(r => [...r, stroke]);
                    setStrokes(prev => prev.filter(s => s.id !== stroke.id));
                  }
                }}
              />
            )
          )}

          {/* Live preview stroke */}
          {curPts.length > 1 && (
            <path
              d={getPathData(curPts, tool)}
              stroke={color}
              strokeWidth={tool === 'highlighter' ? lineWidth * 2.5 : lineWidth}
              strokeOpacity={tool === 'highlighter' ? 0.35 : 1}
              strokeLinecap="round" strokeLinejoin="round"
              fill="none"
              className="pointer-events-none"
              style={tool === 'laserPointer' || tool === 'disappearingInk' 
                ? { animation: `vanishInk ${tool === 'laserPointer' ? 400 : vanishMs}ms linear forwards` }
                : undefined}
            />
          )}
        </svg>

        {/* Text input overlay */}
        {activeText && (() => {
          const s = strokes.find(x => x.id === activeText);
          if (!s) return null;
          return (
            <div className="absolute z-50" style={{ left: s.points[0].x, top: s.points[0].y - 32 }}>
              <input
                autoFocus
                value={tempText}
                onChange={e => setTempText(e.target.value)}
                onBlur={() => commitText(activeText, tempText)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitText(activeText, tempText);
                  if (e.key === 'Escape') {
                    setStrokes(prev => prev.filter(x => x.id !== activeText));
                    setActiveText(null);
                  }
                }}
                className="bg-[#1c1c1e] border-2 border-[#0a84ff] rounded px-2 py-1 focus:outline-none shadow-2xl font-medium min-w-[160px]"
                style={{ color: s.color, fontSize: s.width * 3 + 14 }}
              />
            </div>
          );
        })()}

        {/* Eraser cursor ring */}
        {tool === 'eraser' && eraserClient && (
          <div
            className="fixed pointer-events-none z-50 rounded-full border-2 border-white/70"
            style={{
              width: eraserSize,
              height: eraserSize,
              left: eraserClient.x - eraserSize / 2,
              top:  eraserClient.y - eraserSize / 2,
            }}
          />
        )}

        {/* Magnifier */}
        {tool === 'magnifier' && magPos && (
          <div
            className="fixed pointer-events-none z-50 w-[280px] h-[280px] rounded-full border-4 border-white/20 shadow-2xl overflow-hidden bg-[#121212]"
            style={{ left: magPos.x - 140, top: magPos.y - 140 }}
          >
            <div
              className="absolute"
              style={{
                transform: `scale(2) translate(${-magPos.x + 70}px, ${-magPos.y + 70}px)`,
                width: '100vw', height: '100vh', transformOrigin: 'top left',
              }}
            >
              <svg className="w-screen h-screen">
                {strokes.filter(s => s.tool !== 'text').map(s => (
                  <path key={s.id + '-z'} d={getPathData(s.points, s.tool)}
                    stroke={s.color} strokeWidth={s.width} fill="none"
                    strokeLinecap="round" strokeLinejoin="round" />
                ))}
              </svg>
            </div>
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] font-bold text-white/50 tracking-widest uppercase bg-black/50 px-3 py-1 rounded-full">
              2× ZOOM
            </div>
          </div>
        )}

        {/* Ball Point Cursor Size visualization */}
        {tool !== 'pointer' && tool !== 'magnifier' && tool !== 'text' && tool !== 'eraser' && magPos && (
          <div
            className="fixed pointer-events-none z-50 rounded-full mix-blend-difference"
            style={{
              width: lineWidth,
              height: lineWidth,
              left: magPos.x - lineWidth / 2,
              top: magPos.y - lineWidth / 2,
              backgroundColor: 'white',
              opacity: 0.8
            }}
          />
        )}
      </div>

      {/* ── Smart shape toast ── */}
      {toast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200] bg-[#1c1c1e]/95 border border-white/15 text-white/60 text-xs font-bold uppercase tracking-widest px-4 py-2 rounded-full pointer-events-none shadow-xl animate-pulse">
          ✦ snapped · {toast}
        </div>
      )}

      {/* ── Floating toolbar ── */}
      <div
        id="tb-root"
        onMouseEnter={pausePassthrough}
        onMouseLeave={resumePassthrough}
        className="fixed z-[120] flex flex-row-reverse items-stretch"
        style={{
          right: `calc(1.5rem - ${tbOffset.x}px)`,
          top:   `calc(10% + ${tbOffset.y}px)`,
          transform: tbOpen ? 'translateX(0)' : 'translateX(76px)',
          transition: draggingTb ? 'none' : 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        {/* Main body - Slightly wider to accommodate grid actions gracefully */}
        <div className="w-[62px] bg-[#121214]/95 backdrop-blur-2xl rounded-[22px] border border-white/[0.08] shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)] flex flex-col items-center gap-1 py-4 ring-1 ring-white/[0.03]">

          {/* Drag handle - Distinct hardware feel */}
          <div
            className="w-full h-4 flex flex-col justify-center items-center gap-[2px] mb-2 cursor-grab active:cursor-grabbing opacity-30 hover:opacity-100 transition-opacity"
            onMouseDown={e => {
              dragOrigin.current = { mx: e.clientX, my: e.clientY, ox: tbOffset.x, oy: tbOffset.y };
              setDraggingTb(true);
              e.preventDefault();
            }}
          >
            <div className="w-5 h-[1.5px] rounded-full bg-white/40" />
            <div className="w-5 h-[1.5px] rounded-full bg-white/40" />
          </div>

          {/* Primary Quick Actions (Top 4 visible) */}
          <div className="flex flex-col gap-1 w-full px-2">
            {toolOrder
              .filter(id => !hiddenTools.includes(id))
              .slice(0, 4)
              .map(id => {
                const meta = TOOL_METADATA[id];
                const Icon = meta.icon;
                return (
                  <TBtn 
                    key={id}
                    active={tool === id} 
                    onClick={() => selectTool(id)}
                    tip={meta.label} 
                    hotkey={meta.hotkey}
                    subActive={(id === 'disappearingInk' && subMenu === 'vanish') || (id === 'eraser' && subMenu === 'eraser')}
                  >
                    <Icon size={15} />
                  </TBtn>
                );
              })}
          </div>

          <GSep />

          {/* Secondary / Shape Group - Dynamic Collapsible */}
          <TBtn active={expanded} onClick={() => setExpanded(!expanded)} tip={expanded ? "Hide More" : "Show More"}>
            {expanded ? <ChevronLeft size={16} className="rotate-90" /> : <Settings size={14} />}
          </TBtn>

          {expanded && (
            <div className="flex flex-col gap-1 w-full px-2 mt-1 animate-in fade-in slide-in-from-top-2 duration-300">
              {toolOrder
                .filter(id => !hiddenTools.includes(id))
                .slice(4)
                .map(id => {
                  const meta = TOOL_METADATA[id];
                  const Icon = meta.icon;
                  return (
                    <TBtn 
                      key={id}
                      active={tool === id} 
                      onClick={() => selectTool(id)}
                      tip={meta.label} 
                      hotkey={meta.hotkey}
                      subActive={(id === 'disappearingInk' && subMenu === 'vanish') || (id === 'eraser' && subMenu === 'eraser')}
                    >
                      <Icon size={15} />
                    </TBtn>
                  );
                })}
            </div>
          )}

          <GSep />

          {/* Visual Settings - Combined Palette + Width */}
          <div className="w-full flex flex-col items-center gap-3 px-2">
            <button
              onClick={() => setSubMenu(m => m === 'color' ? null : 'color')}
              className="w-9 h-9 rounded-full border border-white/10 hover:scale-105 active:scale-95 transition-all shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)] flex items-center justify-center p-[2px]"
            >
              <div className="w-full h-full rounded-full" style={{ backgroundColor: color }} />
            </button>

            <div className="flex flex-col items-center gap-1.5 w-full">
              <span className="text-[9px] font-mono text-white/30 tracking-tighter tabular-nums leading-none">
                {lineWidth.toString().padStart(2, '0')}<span className="text-[7px] ml-[1px]">PX</span>
              </span>
              <div className="relative h-12 w-1.5 bg-white/[0.05] rounded-full overflow-hidden">
                <div 
                  className="absolute bottom-0 left-0 right-0 transition-all duration-300"
                  style={{ height: `${((lineWidth - 2) / 22) * 100}%`, backgroundColor: color }}
                />
                <input 
                  type="range" min="2" max="24" step="1" value={lineWidth}
                  onChange={e => setLineWidth(+e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                />
              </div>
            </div>
          </div>

          <GSep />

          {/* Management / Bottom Actions */}
          <div className="flex flex-col items-center w-full px-2">
            <div className="grid grid-cols-2 gap-1 w-full">
              <ABtn onClick={undo} disabled={strokes.length === 0} tip="Undo">
                <RotateCcw size={14} />
              </ABtn>
              <ABtn onClick={redo} disabled={redoStack.length === 0} tip="Redo">
                <RotateCw size={14} />
              </ABtn>
              <ABtn onClick={copyToClipboard} tip="Copy PNG">
                <Copy size={14} />
              </ABtn>
              <ABtn onClick={exportPng} tip="PNG Export">
                <Download size={14} />
              </ABtn>
            </div>
            <div className="w-full mt-1">
              <ABtn onClick={clearAll} tip="Clear All" danger>
                <div className="flex items-center gap-1">
                  <Trash2 size={13} />
                  <span className="text-[8px] font-bold uppercase tracking-tighter">Clear</span>
                </div>
              </ABtn>
            </div>
          </div>

          {/* Smart Toggle - Integrated more cleanly */}
          <div className="mt-2 pt-2 border-t border-white/[0.05] w-full flex flex-col items-center gap-2">
            <button
              onClick={() => setSmartShape(!smartShape)}
              className={`w-7 h-4 rounded-full transition-all duration-300 relative border ${smartShape ? 'bg-green-500/20 border-green-500/40' : 'bg-white/5 border-white/10'}`}
            >
              <div className={`absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full transition-all duration-300 ${smartShape ? 'left-[16px] bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]' : 'left-[4px] bg-white/20'}`} />
            </button>
            <button
              onClick={() => setSubMenu(m => m === 'settings' ? null : 'settings')}
              className={`p-1.5 rounded-lg transition-all ${subMenu === 'settings' ? 'bg-white text-black' : 'text-white/20 hover:text-white/60 hover:bg-white/5'}`}
            >
              <Settings size={14} />
            </button>
          </div>

          {isElectron && (
            <div className="mt-3">
              <button 
                onClick={quit} 
                className="w-8 h-8 rounded-full flex items-center justify-center text-red-500/40 hover:text-red-500 hover:bg-red-500/10 transition-all"
              >
                <Power size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Tab Toggle - Latch style */}
        <button
          onClick={() => setTbOpen(!tbOpen)}
          className="self-center -mr-2 w-5 h-12 bg-[#121214]/90 backdrop-blur-xl rounded-l-md border-y border-l border-white/10 flex items-center justify-center text-white/20 hover:text-white/60 transition-all shadow-xl group"
        >
          {tbOpen ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>

        {/* Sub-menus - Refined with Hardware vibe */}
        <AnimatePresence>
          {subMenu === 'vanish' && (
            <SubMenu style={{ right: 68, top: 48 }}>
              <span className="text-[8px] font-mono text-white/20 uppercase tracking-widest mb-1.5 block px-1 text-center font-bold">Delay Mode</span>
              <div className="grid grid-cols-2 gap-1.5">
                {[3, 5, 10, 30].map(t => (
                  <button key={t} onClick={() => { setVanishMs(t * 1000); setSubMenu(null); }}
                    className={`text-[10px] font-mono font-bold h-8 w-8 rounded-lg border transition-all ${vanishMs === t * 1000 ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-100' : 'border-white/5 text-white/40 hover:text-white hover:bg-white/5'}`}>
                    {t}s
                  </button>
                ))}
              </div>
            </SubMenu>
          )}

          {subMenu === 'eraser' && (
            <SubMenu style={{ right: 68, top: 88 }}>
              <span className="text-[8px] font-mono text-white/20 uppercase tracking-widest mb-1.5 block px-1 text-center font-bold">Aperture</span>
              <div className="flex flex-col gap-1">
                {[20, 40, 80, 120].map(s => (
                  <button key={s} onClick={() => { setEraserSize(s); setSubMenu(null); }}
                    className={`h-9 w-full rounded-lg border flex items-center justify-start px-3 gap-3 transition-all ${eraserSize === s ? 'bg-red-500/10 border-red-500/30 text-red-100' : 'border-white/5 text-white/40 hover:text-white hover:bg-white/5'}`}>
                    <div className={`rounded-full ${eraserSize === s ? 'bg-red-400' : 'bg-white/30'}`} style={{ width: s/10, height: s/10 }} />
                    <span className="text-[9px] font-mono tracking-tighter">{s}px</span>
                  </button>
                ))}
              </div>
            </SubMenu>
          )}

          {subMenu === 'settings' && (
            <SubMenu style={{ right: 68, top: 40, width: 180 }} grid={false}>
              <span className="text-[8px] font-mono text-white/20 uppercase tracking-widest mb-1.5 block px-1 text-center font-bold">Customize Toolbar</span>
              <Reorder.Group axis="y" values={toolOrder} onReorder={setToolOrder} className="flex flex-col gap-1 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
                {toolOrder.map((id) => {
                  const meta = TOOL_METADATA[id];
                  const Icon = meta.icon;
                  const isHidden = hiddenTools.includes(id);
                  return (
                    <Reorder.Item key={id} value={id} className="flex items-center gap-2 p-1.5 bg-white/[0.03] rounded-lg border border-white/[0.05] hover:bg-white/[0.06] transition-colors group">
                      <div className="cursor-grab active:cursor-grabbing text-white/10 group-hover:text-white/30 transition-colors">
                        <GripVertical size={12} />
                      </div>
                      <div className={`flex items-center justify-center w-6 h-6 rounded-md ${isHidden ? 'opacity-20' : 'bg-white/5 text-white'}`}>
                        <Icon size={14} />
                      </div>
                      <span className={`text-[10px] font-mono flex-1 truncate ${isHidden ? 'text-white/20 line-through' : 'text-white/70'}`}>
                        {meta.label}
                      </span>
                      <button 
                        onClick={() => {
                          setHiddenTools(prev => 
                            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
                          );
                        }}
                        className={`p-1 rounded transition-colors ${isHidden ? 'text-red-500/40 hover:text-red-400' : 'text-white/20 hover:text-white/60'}`}
                      >
                        {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    </Reorder.Item>
                  );
                })}
              </Reorder.Group>
              <div className="mt-2 pt-2 border-t border-white/5">
                 <button 
                    onClick={() => { setToolOrder(INITIAL_ORDER); setHiddenTools([]); }}
                    className="w-full py-1.5 text-[9px] font-mono text-white/30 hover:text-white/60 hover:bg-white/5 rounded-md transition-all uppercase tracking-tighter"
                 >
                    Reset Layout
                 </button>
              </div>
            </SubMenu>
          )}

          {subMenu === 'color' && (
            <SubMenu style={{ right: 68, bottom: 120, width: 140 }} grid>
              <span className="col-span-2 text-[8px] font-mono text-white/20 uppercase tracking-widest mb-1 block text-center font-bold">Palette</span>
              <div className="col-span-2 grid grid-cols-4 gap-1.5 mb-2">
                {PALETTE.map(c => (
                  <button key={c} onClick={() => { setColor(c); setSubMenu(null); }}
                    className={`w-7 h-7 rounded-full border-2 transition-all ${color === c ? 'border-white scale-110 shadow-lg' : 'border-white/5 hover:border-white/20 hover:scale-105'}`}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
              <div className="col-span-2 pt-2 border-t border-white/10 flex flex-col gap-1.5">
                <span className="text-[7px] font-mono text-white/20 uppercase tracking-widest text-center font-bold">Custom Color</span>
                <div className="flex items-center gap-2 bg-white/5 p-1 rounded-lg">
                  <Palette size={14} className="text-white/30" />
                  <input 
                    type="color" value={color} 
                    onChange={e => setColor(e.target.value)}
                    className="w-full h-4 bg-transparent cursor-pointer border-none p-0"
                  />
                </div>
              </div>
            </SubMenu>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function GLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[7px] text-white/20 tracking-[0.2em] font-mono uppercase mt-1 mb-0.5">{children}</span>;
}

function GSep() {
  return <div className="w-6 h-[1px] bg-white/[0.05] my-1" />;
}

function SubMenu({ children, style, grid }: { children: React.ReactNode; style: React.CSSProperties; grid?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 10, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 10, scale: 0.95 }}
      className={`absolute bg-[#121214]/98 backdrop-blur-3xl border border-white/10 rounded-xl p-2 shadow-[0_20px_40px_rgba(0,0,0,0.6)] z-[200] ${grid ? 'grid grid-cols-2 gap-2 w-[100px]' : 'flex flex-col gap-1 min-w-[72px]'}`}
      style={style}
    >
      {children}
    </motion.div>
  );
}

const TBtn = ({
  active, onClick, tip, hotkey, danger, subActive, children,
}: {
  active: boolean; onClick: () => void; tip: string;
  hotkey?: string; danger?: boolean; subActive?: boolean;
  children: React.ReactNode;
  key?: React.Key;
}) => {
  return (
    <div className="group relative w-full flex justify-center">
      <button
        onClick={onClick}
        className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200 relative border ${
          active   ? 'bg-white text-black border-transparent shadow-[0_0_15px_rgba(255,255,255,0.2)]' :
          danger   ? 'text-red-400/50 border-transparent hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/20' :
                     'text-white/40 border-transparent hover:bg-white/5 hover:text-white hover:border-white/10'
        }`}
      >
        <div className="scale-110">{children}</div>
        {subActive && (
          <div className="absolute -right-1 w-1 h-2 bg-[#0a84ff] rounded-full top-1/2 -translate-y-1/2 shadow-[0_0_8px_#0a84ff]" />
        )}
      </button>
      <div className="absolute right-full mr-3 px-2 py-1.5 bg-[#121214] text-white/80 text-[10px] font-mono tracking-tight rounded-md opacity-0 group-hover:opacity-100 transition-all pointer-events-none border border-white/10 z-[300] uppercase whitespace-nowrap flex items-center gap-2 -translate-x-2 group-hover:translate-x-0">
        {tip}
        {hotkey && <span className="bg-white/10 px-1 py-0.5 rounded text-[8px] text-white/30 font-bold">{hotkey}</span>}
      </div>
    </div>
  );
}

const ABtn = ({
  onClick, disabled, tip, danger, children,
}: {
  onClick: () => void; disabled?: boolean; tip: string; danger?: boolean;
  children: React.ReactNode;
}) => {
  return (
    <div className="group relative flex-1">
      <button
        onClick={onClick} disabled={disabled}
        className={`w-full h-8 rounded-md flex items-center justify-center transition-all border ${
          disabled ? 'opacity-10 cursor-not-allowed border-transparent' :
          danger   ? 'text-red-400/50 border-transparent hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/10' :
                     'text-white/30 border-transparent hover:bg-white/5 hover:text-white hover:border-white/10'
        }`}
      >
        {children}
      </button>
      {!disabled && (
        <div className="absolute right-full mr-3 px-2 py-1 bg-[#121214] text-white/60 text-[9px] font-mono tracking-tight rounded-md opacity-0 group-hover:opacity-100 transition-all pointer-events-none border border-white/10 z-[300] uppercase whitespace-nowrap -translate-x-2 group-hover:translate-x-0">
          {tip}
        </div>
      )}
    </div>
  );
}
