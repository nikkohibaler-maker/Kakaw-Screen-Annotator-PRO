/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Pencil, 
  Minus, 
  Sparkles, 
  Eraser, 
  Trash2, 
  MousePointer2,
  ChevronRight,
  ChevronLeft,
  Square,
  Circle,
  ArrowUpRight,
  Triangle,
  Type,
  Search,
  RotateCcw,
  RotateCw,
  Download
} from 'lucide-react';
import { DrawingTool, Point, Stroke } from './types.ts';

const CURSOR_MAP: Record<DrawingTool, string> = {
  pen: 'crosshair',
  straightLine: 'crosshair',
  disappearingInk: 'crosshair',
  eraser: 'pointer',
  pointer: 'default',
  rectangle: 'crosshair',
  ellipse: 'crosshair',
  arrow: 'crosshair',
  triangle: 'crosshair',
  text: 'text',
  magnifier: 'none', // Controlled by lens
};

export default function App() {
  const [currentTool, setCurrentTool] = useState<DrawingTool>('pen');
  const [strokeColor, setStrokeColor] = useState('#32D74B'); // iOS Green
  const [lineWidth, setLineWidth] = useState(4);
  const [strokeOpacity, setStrokeOpacity] = useState(1.0);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);
  const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const [isToolbarOpen, setIsToolbarOpen] = useState(true);
  const [smartShapeEnabled, setSmartShapeEnabled] = useState(true);
  const [inkVanishTime, setInkVanishTime] = useState(3000); // Default 3s
  const [eraserSize, setEraserSize] = useState(40); // Default 40px
  const [magnifierPos, setMagnifierPos] = useState<Point | null>(null);
  
  // Text tool state
  const [activeTextId, setActiveTextId] = useState<string | null>(null);
  const [tempText, setTempText] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const isElectron = useMemo(() => {
    return typeof window !== 'undefined' && window.process && (window.process as any).type === 'renderer';
  }, []);

  // LocalStorage Persistence
  useEffect(() => {
    const saved = localStorage.getItem('proannotate_strokes');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setStrokes(parsed);
      } catch (e) {
        console.error("Failed to load strokes", e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('proannotate_strokes', JSON.stringify(strokes));
  }, [strokes]);

  // Keyboard Monitoring (Shortcuts)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in text tool
      if (activeTextId) return;

      // Tool Switching (1-5)
      if (e.key === '1') setCurrentTool('pen');
      if (e.key === '2') setCurrentTool('straightLine');
      if (e.key === '3') setCurrentTool('disappearingInk');
      if (e.key === '4') setCurrentTool('eraser');
      if (e.key === '5') setCurrentTool('pointer');
      
      if (e.shiftKey) setIsShiftPressed(true);

      // Undo / Redo
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        clearAll();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (!e.shiftKey) setIsShiftPressed(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [strokes, redoStack]);

  // Disappearing ink logic
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setStrokes((prev) => 
        prev.filter((s) => !s.isDisappearing || now - s.createdAt < inkVanishTime)
      );
    }, 100);
    return () => clearInterval(interval);
  }, [inkVanishTime]);

  const undo = () => {
    if (strokes.length === 0) return;
    const last = strokes[strokes.length - 1];
    setStrokes(strokes.slice(0, -1));
    setRedoStack([...redoStack, last]);
  };

  const redo = () => {
    if (redoStack.length === 0) return;
    const last = redoStack[redoStack.length - 1];
    setRedoStack(redoStack.slice(0, -1));
    setStrokes([...strokes, last]);
  };

  const clearAll = () => {
    setStrokes([]);
    setRedoStack([]);
  };

  const getCoordinates = (e: React.MouseEvent | React.TouchEvent | MouseEvent): Point | null => {
    if (!containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    
    let clientX, clientY;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    if (currentTool === 'pointer' || currentTool === 'magnifier') return;
    
    const point = getCoordinates(e);
    if (!point) return;

    if (currentTool === 'eraser') {
      setIsDrawing(true);
      performContinuousEraser(point);
      return;
    }

    if (currentTool === 'text') {
      const id = Math.random().toString(36).substring(7);
      const newStroke: Stroke = {
        id,
        points: [point],
        tool: 'text',
        color: strokeColor,
        width: lineWidth,
        opacity: strokeOpacity,
        createdAt: Date.now(),
        text: "",
        fontSize: 24,
      };
      setStrokes([...strokes, newStroke]);
      setActiveTextId(id);
      setTempText("");
      return;
    }

    setIsDrawing(true);
    setCurrentPoints([point]);
    setRedoStack([]); // Clear redo on new action
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    const point = getCoordinates(e);
    if (!point) return;

    if (currentTool === 'magnifier') {
      setMagnifierPos(point);
      return;
    }

    if (!isDrawing) return;

    if (currentTool === 'eraser') {
      performContinuousEraser(point);
      return;
    }

    setCurrentPoints((prev) => [...prev, point]);
  };

  const stopDrawing = () => {
    if (!isDrawing) return;

    let toolToUse = currentTool;
    let pointsToUse = currentPoints;

    // Smart Shape Detection logic
    if (smartShapeEnabled && toolToUse === 'pen' && !isShiftPressed && pointsToUse.length > 10) {
      const detected = detectShape(pointsToUse);
      if (detected) {
        toolToUse = detected.tool;
        pointsToUse = detected.points;
      }
    }

    // Path Simplification for Pen (Production Smoothing)
    if (toolToUse === 'pen' && !isShiftPressed) {
      pointsToUse = simplifyPath(pointsToUse, 1.5); // 1.5px tolerance for "shaky" correction
    }

    const newStroke: Stroke = {
      id: Math.random().toString(36).substring(7),
      points: pointsToUse,
      tool: (toolToUse === 'pen' && isShiftPressed) ? 'straightLine' : toolToUse,
      color: toolToUse === 'disappearingInk' ? '#FFD60A' : strokeColor,
      width: lineWidth,
      opacity: strokeOpacity,
      isDisappearing: toolToUse === 'disappearingInk',
      createdAt: Date.now(),
    };

    setStrokes((prev) => [...prev, newStroke]);
    setIsDrawing(false);
    setCurrentPoints([]);
  };

  // Smart Shape Detection: Upgraded to use simplification analysis
  const detectShape = (points: Point[]): { tool: DrawingTool, points: Point[] } | null => {
    if (points.length < 10) return null;
    
    // Step 1: Geometry basics
    const xMin = Math.min(...points.map(p => p.x));
    const xMax = Math.max(...points.map(p => p.x));
    const yMin = Math.min(...points.map(p => p.y));
    const yMax = Math.max(...points.map(p => p.y));
    const width = xMax - xMin;
    const height = yMax - yMin;
    if (width < 30 && height < 30) return null;

    // Step 2: Path Simplification (High Tolerance to see raw polygon)
    const vertices = simplifyPath(points, Math.max(width, height) * 0.1);
    const start = points[0];
    const end = points[points.length - 1];
    const distStartEnd = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
    const isClosed = distStartEnd < Math.max(width, height) * 0.25;

    // Line Recognition
    if (vertices.length === 2) {
      return { tool: 'straightLine', points: [start, end] };
    }

    // Closed Shape Recognition
    if (isClosed) {
      // 1. Circle Check (Radius consistency)
      const centerX = (xMin + xMax) / 2;
      const centerY = (yMin + yMax) / 2;
      const avgRadius = (width + height) / 4;
      let variance = 0;
      points.forEach(p => {
        const dist = Math.sqrt(Math.pow(p.x - centerX, 2) + Math.pow(p.y - centerY, 2));
        variance += Math.abs(dist - avgRadius);
      });
      const circleConfidence = 1 - (variance / points.length / avgRadius);
      if (circleConfidence > 0.88) return { tool: 'ellipse', points: [{ x: xMin, y: yMin }, { x: xMax, y: yMax }] };

      // 2. Triangle detection (3 main vertices)
      if (vertices.length === 4) { // Closed loops with 3 corners give 4 vertices (start point repeated)
        return { tool: 'triangle', points: [{ x: xMin, y: yMin }, { x: xMax, y: yMax }] };
      }

      // 3. Rectangle detection
      if (vertices.length === 5) { // 4 corners + start
        return { tool: 'rectangle', points: [{ x: xMin, y: yMin }, { x: xMax, y: yMax }] };
      }
    } else {
      // Open Shape: Arrow or Line
      // Simplified heuristic for Arrow: Check angles at vertices
      for (let i = 1; i < vertices.length - 1; i++) {
        const v1 = { x: vertices[i].x - vertices[i-1].x, y: vertices[i].y - vertices[i-1].y };
        const v2 = { x: vertices[i+1].x - vertices[i].x, y: vertices[i+1].y - vertices[i].y };
        const angle = Math.abs(Math.atan2(v1.x * v2.y - v1.y * v2.x, v1.x * v2.x + v1.y * v2.y));
        if (angle > 2.5) { // Acute angle (PI is ~3.14) meaning backtrack/sharp turn
           return { tool: 'arrow', points: [vertices[0], vertices[i]] };
        }
      }
    }

    return null;
  };

  const performContinuousEraser = (point: Point) => {
    setStrokes((prev) => prev.filter((stroke) => {
      // Check distance from eraser point to any point in the stroke
      const isNear = stroke.points.some(p => {
        const dist = Math.sqrt(Math.pow(p.x - point.x, 2) + Math.pow(p.y - point.y, 2));
        return dist < (eraserSize / 2);
      });
      return !isNear;
    }));
  };

  const handleEraserClick = (id: string) => {
    setStrokes((prev) => prev.filter((s) => s.id !== id));
  };

  // Path Simplification (Ramer-Douglas-Peucker approximation)
  const simplifyPath = (points: Point[], tolerance: number): Point[] => {
    if (points.length <= 2) return points;

    const sqTolerance = tolerance * tolerance;

    const getSqDist = (p1: Point, p2: Point) => {
        return Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2);
    };

    const getSqSegDist = (p: Point, p1: Point, p2: Point) => {
        let x = p1.x, y = p1.y, dx = p2.x - x, dy = p2.y - y;
        if (dx !== 0 || dy !== 0) {
            let t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
            if (t > 1) { x = p2.x; y = p2.y; } else if (t > 0) { x += dx * t; y += dy * t; }
        }
        return getSqDist(p, { x, y });
    };

    const simplifyStep = (points: Point[], first: number, last: number, sqTolerance: number, simplified: Point[]) => {
        let maxSqDist = sqTolerance, index = -1;
        for (let i = first + 1; i < last; i++) {
            let sqDist = getSqSegDist(points[i], points[first], points[last]);
            if (sqDist > maxSqDist) {
                index = i;
                maxSqDist = sqDist;
            }
        }
        if (index !== -1) {
            simplifyStep(points, first, index, sqTolerance, simplified);
            simplified.push(points[index]);
            simplifyStep(points, index, last, sqTolerance, simplified);
        }
    };

    let simplified = [points[0]];
    simplifyStep(points, 0, points.length - 1, sqTolerance, simplified);
    simplified.push(points[points.length - 1]);
    return simplified;
  };

  const exportAsPng = async () => {
    if (!containerRef.current) return;
    const svg = containerRef.current.querySelector('svg');
    if (!svg) return;

    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      ctx.fillStyle = '#121212';
      ctx.fillRect(0,0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const pngUrl = canvas.toDataURL('image/png');
      const downloadLink = document.createElement('a');
      downloadLink.href = pngUrl;
      downloadLink.download = 'pro-annotate-export.png';
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const getPathData = (points: Point[], tool: DrawingTool) => {
    if (points.length < 2) return '';
    const start = points[0];
    const end = points[points.length - 1];

    switch (tool) {
      case 'straightLine':
        return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
      
      case 'rectangle':
        return `M ${start.x} ${start.y} H ${end.x} V ${end.y} H ${start.x} Z`;
      
      case 'ellipse':
        const rx = Math.abs(end.x - start.x) / 2;
        const ry = Math.abs(end.y - start.y) / 2;
        const cx = (start.x + end.x) / 2;
        const cy = (start.y + end.y) / 2;
        return `M ${cx-rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx+rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx-rx} ${cy}`;

      case 'triangle':
        // Equilateral-ish triangle within the box
        const tx = (start.x + end.x) / 2;
        return `M ${tx} ${start.y} L ${end.x} ${end.y} L ${start.x} ${end.y} Z`;

      case 'arrow':
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const headLength = 20;
        const x1 = end.x - headLength * Math.cos(angle - Math.PI/6);
        const y1 = end.y - headLength * Math.sin(angle - Math.PI/6);
        const x2 = end.x - headLength * Math.cos(angle + Math.PI/6);
        const y2 = end.y - headLength * Math.sin(angle + Math.PI/6);
        return `M ${start.x} ${start.y} L ${end.x} ${end.y} M ${end.x} ${end.y} L ${x1} ${y1} M ${end.x} ${end.y} L ${x2} ${y2}`;

      default:
        // Smooth curve
        let d = `M ${points[0].x} ${points[0].y}`;
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i+1];
            const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            if (i === 0) d += ` L ${mid.x} ${mid.y}`;
            else d += ` Q ${p1.x} ${p1.y} ${mid.x} ${mid.y}`;
        }
        d += ` L ${end.x} ${end.y}`;
        return d;
    }
  };

  return (
    <div className="relative w-screen h-screen select-none touch-none bg-[#121212] overflow-hidden">
      {/* Electron Drag Region (macOS Title Bar Area) */}
      {isElectron && (
        <div className="fixed top-0 left-0 right-0 h-8 z-[100] window-drag pointer-events-none" style={{ WebkitAppRegion: 'drag' } as any} />
      )}
      {/* Background Simulation */}
      <div className="absolute inset-0 bg-dots flex items-center justify-center pointer-events-none opacity-40">
        <div className="w-[85%] h-[65%] rounded-xl border border-white/5 bg-gradient-to-b from-white/5 to-transparent relative p-12 shadow-inner">
          <div className="absolute top-6 left-6 text-xs text-white/20 font-sans tracking-widest uppercase">
            System Overlay Active · M2 Optimized
          </div>
          <svg className="absolute inset-0 w-full h-full opacity-10" viewBox="0 0 800 400">
             <path d="M0 300 Q 200 350, 400 200 T 800 100" fill="none" stroke="#22c55e" strokeWidth="1" />
             <path d="M0 250 Q 250 150, 500 300 T 800 200" fill="none" stroke="#0ea5e9" strokeWidth="1" />
          </svg>
        </div>
      </div>

      {/* Surface */}
      <div 
        ref={containerRef}
        className="absolute inset-0 z-20 overflow-hidden will-change-transform"
        style={{ cursor: CURSOR_MAP[currentTool] }}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
      >
        <svg id="main-svg" className="w-full h-full pointer-events-none">
          <AnimatePresence>
            {strokes.map((stroke) => (
              <React.Fragment key={stroke.id}>
                {stroke.tool === 'text' ? (
                  <g>
                    {/* Invisible Hitbox for better selecting/erasing */}
                    <rect 
                      x={stroke.points[0].x - 10} 
                      y={stroke.points[0].y - 30} 
                      width={200} 
                      height={40} 
                      fill="transparent" 
                      className="pointer-events-auto cursor-text"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (currentTool === 'eraser') handleEraserClick(stroke.id);
                        else {
                          setActiveTextId(stroke.id);
                          setTempText(stroke.text || "");
                        }
                      }}
                    />
                    <text
                      x={stroke.points[0].x}
                      y={stroke.points[0].y}
                      fill={stroke.color}
                      fontSize={stroke.fontSize}
                      className="pointer-events-none font-sans font-medium select-none"
                    >
                      {stroke.text || "Type..."}
                    </text>
                  </g>
                ) : (
                  <motion.path
                    d={getPathData(stroke.points, stroke.tool)}
                    stroke={stroke.color}
                    strokeWidth={stroke.width + (currentTool === 'eraser' ? 15 : 0)} // Fat hit-box for eraser
                    strokeOpacity={currentTool === 'eraser' ? 0.2 : stroke.opacity}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                    initial={stroke.isDisappearing ? { opacity: stroke.opacity } : false}
                    animate={stroke.isDisappearing ? { opacity: 0 } : { opacity: stroke.opacity }}
                    exit={{ opacity: 0 }}
                    transition={stroke.isDisappearing ? { duration: inkVanishTime / 1000, ease: "linear" } : { duration: 0.15 }}
                    className={currentTool === 'eraser' ? 'pointer-events-auto cursor-pointer hover:stroke-red-500/50 transition-colors' : 'pointer-events-none'}
                    onClick={() => handleEraserClick(stroke.id)}
                    style={{ strokeOpacity: currentTool === 'eraser' ? 0.1 : undefined }}
                  />
                )}
              </React.Fragment>
            ))}
          </AnimatePresence>

          {currentPoints.length > 0 && (
            <path
              d={getPathData(currentPoints, currentTool)}
              stroke={currentTool === 'disappearingInk' ? '#FFD60A' : strokeColor}
              strokeWidth={lineWidth}
              strokeOpacity={strokeOpacity}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              className="pointer-events-none"
            />
          )}
        </svg>

        {/* Inline Text Editor */}
        {activeTextId && (
          <div 
            className="absolute z-[100]"
            style={{ 
              left: strokes.find(s => s.id === activeTextId)?.points[0].x, 
              top: strokes.find(s => s.id === activeTextId)?.points[0].y! - 28 
            }}
          >
            <input
              autoFocus
              value={tempText}
              onChange={e => setTempText(e.target.value)}
              onBlur={() => {
                setStrokes(prev => prev.map(s => s.id === activeTextId ? { ...s, text: tempText } : s));
                setActiveTextId(null);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  setStrokes(prev => prev.map(s => s.id === activeTextId ? { ...s, text: tempText } : s));
                  setActiveTextId(null);
                }
              }}
              className="bg-[#1c1c1e] text-white border-2 border-[#0a84ff] rounded px-2 py-1 focus:outline-none shadow-2xl font-sans font-medium min-w-[150px]"
              style={{ color: strokes.find(s => s.id === activeTextId)?.color }}
            />
          </div>
        )}

        {/* Magnifier Lens - Content Mirroring */}
        {currentTool === 'magnifier' && magnifierPos && (
          <div 
            className="fixed pointer-events-none z-[110] w-[300px] h-[300px] rounded-full border-4 border-white/20 shadow-2xl overflow-hidden backdrop-blur-xl bg-[#121212]"
            style={{ 
              left: magnifierPos.x - 150, 
              top: magnifierPos.y - 150,
            }}
          >
            <div 
              className="absolute pointer-events-none"
              style={{ 
                transform: `scale(2) translate(${-magnifierPos.x + 75}px, ${-magnifierPos.y + 75}px)`,
                width: '100vw',
                height: '100vh',
                transformOrigin: 'top left'
              }}
            >
                {/* Visual Clone of the entire board */}
                <div className="bg-dots w-screen h-screen opacity-20" />
                <svg className="w-screen h-screen">
                   {strokes.map(s => (
                     s.tool !== 'text' && (
                       <path 
                        key={s.id + "-zoom"}
                        d={getPathData(s.points, s.tool)}
                        stroke={s.color}
                        strokeWidth={s.width}
                        strokeOpacity={s.opacity}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                       />
                     )
                   ))}
                </svg>
            </div>
            <div className="absolute inset-0 border-[20px] border-[#1c1c1e] rounded-full opacity-20 pointer-events-none" />
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-black/60 px-3 py-1 rounded-full text-[10px] font-bold text-white tracking-widest uppercase">
              2.0x OPTICAL
            </div>
          </div>
        )}
      </div>
      {/* Toolbar */}
      <motion.div 
        animate={{ x: isToolbarOpen ? 0 : -100 }}
        className="fixed left-8 top-[8%] z-[60] flex items-center"
      >
        <div className="w-[88px] bg-[#1c1c1e]/90 backdrop-blur-[24px] rounded-[24px] border border-white/10 shadow-2xl flex flex-col items-center gap-1 overflow-y-auto max-h-[85vh] py-4 scrollbar-hide">
          
          {/* Group: Drawing */}
          <ToolbarSection label="Ink">
            <ToolButton active={currentTool === 'pen'} onClick={() => setCurrentTool('pen')} icon={<Pencil size={20} />} tooltip="Smooth Pen (1)" />
            
            <div className="relative w-full flex flex-col items-center">
              <ToolButton active={currentTool === 'disappearingInk'} onClick={() => setCurrentTool('disappearingInk')} icon={<Sparkles size={20} />} tooltip="Quick Ink (3)" />
              
              <AnimatePresence>
                {currentTool === 'disappearingInk' && (
                  <motion.div 
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    className="absolute left-[80px] top-0 bg-[#1c1c1e] border border-white/10 rounded-xl p-1.5 flex flex-col gap-1 shadow-2xl z-[70]"
                  >
                    {[3, 5, 10, 30].map(t => (
                      <button
                        key={t}
                        onClick={(e) => {
                          e.stopPropagation();
                          setInkVanishTime(t * 1000);
                        }}
                        className={`text-[10px] font-black w-10 h-7 rounded-lg flex items-center justify-center transition-all ${inkVanishTime === t * 1000 ? 'bg-[#FFD60A] text-black shadow-lg shadow-yellow-500/20' : 'text-white/40 hover:text-white hover:bg-white/5'}`}
                      >
                        {t}s
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="relative w-full flex flex-col items-center">
              <ToolButton active={currentTool === 'eraser'} onClick={() => setCurrentTool('eraser')} icon={<Eraser size={20} />} tooltip="Eraser (4)" />
              
              <AnimatePresence>
                {currentTool === 'eraser' && (
                  <motion.div 
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    className="absolute left-[80px] top-0 bg-[#1c1c1e] border border-white/10 rounded-xl p-1.5 flex flex-col gap-1 shadow-2xl z-[70]"
                  >
                    {[20, 40, 80, 120].map(s => (
                      <button
                        key={s}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEraserSize(s);
                        }}
                        className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${eraserSize === s ? 'bg-red-500/20 border border-red-500/50' : 'hover:bg-white/5 opacity-40 hover:opacity-100'}`}
                      >
                        <div 
                          className={`rounded-full shadow-sm ${eraserSize === s ? 'bg-red-500' : 'bg-white'}`}
                          style={{ 
                            width: Math.max(4, s / 4), 
                            height: Math.max(4, s / 4) 
                          }}
                        />
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </ToolbarSection>

          <ToolbarSeparator />

          {/* Group: Shapes */}
          <ToolbarSection label="Shape">
            <ToolButton active={currentTool === 'straightLine'} onClick={() => setCurrentTool('straightLine')} icon={<Minus size={20} className="rotate-45" />} tooltip="Line (2)" />
            <ToolButton active={currentTool === 'arrow'} onClick={() => setCurrentTool('arrow')} icon={<ArrowUpRight size={20} />} tooltip="Arrow" />
            <ToolButton active={currentTool === 'rectangle'} onClick={() => setCurrentTool('rectangle')} icon={<Square size={20} />} tooltip="Rectangle" />
            <ToolButton active={currentTool === 'ellipse'} onClick={() => setCurrentTool('ellipse')} icon={<Circle size={20} />} tooltip="Ellipse" />
            <ToolButton active={currentTool === 'triangle'} onClick={() => setCurrentTool('triangle')} icon={<Triangle size={20} />} tooltip="Triangle" />
          </ToolbarSection>

          <ToolbarSeparator />

          {/* Group: Annotation */}
          <ToolbarSection label="Utility">
            <ToolButton active={currentTool === 'text'} onClick={() => setCurrentTool('text')} icon={<Type size={20} />} tooltip="Text Tool" />
            <ToolButton active={currentTool === 'magnifier'} onClick={() => setCurrentTool('magnifier')} icon={<Search size={20} />} tooltip="Zoom Lens" />
            <ToolButton active={currentTool === 'pointer'} onClick={() => setCurrentTool('pointer')} icon={<MousePointer2 size={20} />} tooltip="Select (5)" />
          </ToolbarSection>

          <ToolbarSeparator />

          {/* Group: Actions */}
          <ToolbarSection label="State">
            <div className="grid grid-cols-2 gap-1 w-full px-2">
              <ActionButton onClick={undo} icon={<RotateCcw size={16} />} tooltip="Undo (⌘Z)" disabled={strokes.length === 0} />
              <ActionButton onClick={redo} icon={<RotateCw size={16} />} tooltip="Redo (⇧⌘Z)" disabled={redoStack.length === 0} />
              <ActionButton onClick={exportAsPng} icon={<Download size={16} />} tooltip="Export PNG" />
              <ActionButton onClick={clearAll} icon={<Trash2 size={16} />} tooltip="Clear All (⌘K)" />
            </div>
          </ToolbarSection>

          <ToolbarSeparator />

          {/* Settings / Controls */}
          <div className="flex flex-col items-center gap-4 py-2 w-full px-3">
             <div className="flex flex-col items-center gap-2">
                <span className="text-[9px] text-white/20 tracking-[0.2em] font-black uppercase">Smart</span>
                <button 
                  onClick={() => setSmartShapeEnabled(!smartShapeEnabled)}
                  className={`w-10 h-5 rounded-full transition-all relative ${smartShapeEnabled ? 'bg-[#32D74B]' : 'bg-white/10'}`}
                >
                  <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-all ${smartShapeEnabled ? 'left-5.5' : 'left-0.5'}`} />
                </button>
             </div>
             
             <div className="w-full flex flex-col gap-3">
               <div className="flex flex-col items-center gap-1">
                  <span className="text-[9px] text-white/20 tracking-[0.2em] font-black uppercase">Alpha</span>
                  <input type="range" min="0.1" max="1" step="0.05" value={strokeOpacity} onChange={e => setStrokeOpacity(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-full appearance-none accent-[#0a84ff]" />
               </div>

               <div className="w-full h-8 rounded-lg border border-white/10 relative shadow-inner overflow-hidden" style={{ backgroundColor: strokeColor }}>
                 <input type="color" value={strokeColor} onChange={e => setStrokeColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
               </div>
             </div>
          </div>
        </div>

        <button onClick={() => setIsToolbarOpen(!isToolbarOpen)} className="ml-3 p-2 bg-[#1c1c1e]/60 rounded-r-2xl border border-l-0 border-white/10 text-white/20 hover:text-white transition-all shadow-xl backdrop-blur-md">
          {isToolbarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>
      </motion.div>

      {/* Footer Info */}
      <div className="fixed bottom-6 right-8 bg-black/30 backdrop-blur-md px-5 py-2.5 rounded-full border border-white/5 flex items-center gap-4 z-50">
        <div className="flex items-center gap-2 text-[10px] tracking-widest font-bold text-[#8e8e93]">
          <span className="text-white/40">SYSTEM STATUS:</span>
          <span className="text-green-500">READY</span>
        </div>
        <div className="h-4 w-[1px] bg-white/10" />
        <div className="text-[10px] text-white/40 font-mono tracking-tighter">
          MEM: {(strokes.length * 0.1).toFixed(1)}KB / STACK: {strokes.length}
        </div>
      </div>
    </div>
  );
}

function ToolbarSection({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 w-full py-1">
      <span className="text-[9px] text-white/10 tracking-[0.15em] font-black uppercase mb-1">{label}</span>
      <div className="flex flex-col gap-1 w-full items-center">
        {children}
      </div>
    </div>
  );
}

function ToolbarSeparator() {
  return <div className="w-10 h-[1px] bg-white/5 my-2 mx-auto" />;
}

function ToolButton({ active, onClick, icon, tooltip }: { active: boolean, onClick: () => void, icon: React.ReactNode, tooltip: string }) {
  return (
    <div className="group relative">
        <button onClick={onClick} className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-200 ${active ? 'bg-[#0a84ff] text-white shadow-lg shadow-blue-500/40' : 'bg-transparent text-white/60 hover:bg-white/5 hover:text-white'}`}>
            {icon}
        </button>
        <div className="absolute left-full ml-4 px-3 py-1.5 bg-[#1c1c1e] text-white text-[10px] font-bold tracking-widest rounded-lg shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-white/10 z-[100] uppercase">
            {tooltip}
        </div>
    </div>
  );
}

function ActionButton({ onClick, icon, tooltip, disabled = false }: { onClick: () => void, icon: React.ReactNode, tooltip: string, disabled?: boolean }) {
  return (
    <div className="group relative">
        <button onClick={onClick} disabled={disabled} className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all ${disabled ? 'opacity-20 cursor-not-allowed' : 'text-white/40 hover:bg-white/5 hover:text-white'}`}>
            {icon}
        </button>
        {!disabled && <div className="absolute left-full ml-4 px-3 py-1.5 bg-[#1c1c1e] text-white text-[10px] font-bold tracking-widest rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-white/10 z-[100] uppercase">{tooltip}</div>}
    </div>
  );
}
